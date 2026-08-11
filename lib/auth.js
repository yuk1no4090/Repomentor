import crypto from "node:crypto";
import { AUTH_REQUIRED, AUTH_TOKEN_CONFIG, DEFAULT_USER_ID, normalizeUserId, apiError } from "./config.js";

const DEFAULT_AUTH_SCOPES = ["*"];

function normalizeAuthEvent(item) {
  if (!item || typeof item !== "object") return null;
  return {
    id: item.id || crypto.randomUUID(),
    userId: typeof item.userId === "string" ? item.userId : null,
    role: typeof item.role === "string" ? item.role : null,
    scopes: normalizeAuthScopes(item.scopes),
    method: typeof item.method === "string" ? item.method : "UNKNOWN",
    path: typeof item.path === "string" ? item.path : "unknown",
    requiredScope: typeof item.requiredScope === "string" ? item.requiredScope : null,
    status: typeof item.status === "string" ? item.status : "unknown",
    reason: typeof item.reason === "string" ? item.reason : null,
    createdAt: item.createdAt || new Date().toISOString()
  };
}

function normalizeAuthIdentity(value) {
  if (typeof value === "string") {
    return {
      userId: normalizeUserId(value),
      role: "admin",
      scopes: [...DEFAULT_AUTH_SCOPES],
      orgId: null
    };
  }
  if (!value || typeof value !== "object") return null;
  const userId = value.userId || value.user_id || value.id;
  if (!userId) return null;
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.map((scope) => String(scope || "").trim()).filter(Boolean)
    : [...DEFAULT_AUTH_SCOPES];
  return {
    userId: normalizeUserId(userId),
    role: typeof value.role === "string" && value.role.trim() ? value.role.trim() : "user",
    scopes: scopes.length ? scopes : [...DEFAULT_AUTH_SCOPES],
    orgId: value.orgId || value.org_id || null
  };
}

function parseAuthTokenConfig(raw = AUTH_TOKEN_CONFIG) {
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed)
      .map(([token, identity]) => [String(token), normalizeAuthIdentity(identity)])
      .filter(([token, identity]) => token && identity));
  } catch {
    return new Map(String(raw).split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [token, userId] = entry.split(":");
        return [String(token || "").trim(), String(userId || "").trim() ? normalizeAuthIdentity(userId) : null];
      })
      .filter(([token, identity]) => token && identity));
  }
}

const AUTH_TOKEN_TO_IDENTITY = parseAuthTokenConfig();

function normalizeAuthScopes(scopes) {
  return Array.isArray(scopes)
    ? [...new Set(scopes.map((scope) => String(scope || "").trim()).filter(Boolean))]
    : [...DEFAULT_AUTH_SCOPES];
}

function normalizeAuthRole(value, fallback = "user") {
  const role = String(value || fallback).trim().toLowerCase();
  return role || fallback;
}

function authUserFromIdentity(identity, source = "token-config") {
  if (!identity?.userId) return null;
  const now = new Date().toISOString();
  return {
    id: normalizeUserId(identity.userId),
    role: normalizeAuthRole(identity.role, "user"),
    scopes: normalizeAuthScopes(identity.scopes),
    orgId: identity.orgId || null,
    source,
    status: "active",
    createdAt: now,
    updatedAt: now
  };
}

function hashAuthToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createLocalAuthTokenValue() {
  return `ai_pm_${crypto.randomBytes(24).toString("base64url")}`;
}

function normalizeAuthTokenRecord(token) {
  if (!token || typeof token !== "object") return null;
  const tokenHash = typeof token.tokenHash === "string"
    ? token.tokenHash
    : typeof token.token_hash === "string"
      ? token.token_hash
      : null;
  if (!tokenHash) return null;
  const userId = normalizeUserId(token.userId || token.user_id);
  return {
    id: String(token.id || crypto.randomUUID()),
    userId,
    tokenHash,
    tokenPrefix: typeof token.tokenPrefix === "string" ? token.tokenPrefix : (typeof token.token_prefix === "string" ? token.token_prefix : null),
    scopes: normalizeAuthScopes(token.scopes),
    status: String(token.status || "active").trim() || "active",
    source: String(token.source || "store-token").trim() || "store-token",
    createdAt: token.createdAt || new Date().toISOString(),
    updatedAt: token.updatedAt || new Date().toISOString(),
    lastUsedAt: token.lastUsedAt || token.last_used_at || null
  };
}

function normalizeAuthUserRecord(user) {
  if (!user || typeof user !== "object") return null;
  const now = new Date().toISOString();
  const id = normalizeUserId(user.id || user.userId || user.user_id);
  return {
    id,
    role: normalizeAuthRole(user.role, id === DEFAULT_USER_ID ? "local" : "user"),
    scopes: normalizeAuthScopes(user.scopes),
    orgId: user.orgId || user.org_id || null,
    source: String(user.source || "store").trim() || "store",
    status: String(user.status || "active").trim() || "active",
    createdAt: user.createdAt || now,
    updatedAt: user.updatedAt || now
  };
}

function mergeAuthUsersWithConfiguredTokens(existingUsers = []) {
  const usersById = new Map(existingUsers.map((user) => [user.id, user]));
  for (const identity of AUTH_TOKEN_TO_IDENTITY.values()) {
    const tokenUser = authUserFromIdentity(identity, "token-config");
    if (!tokenUser) continue;
    const existing = usersById.get(tokenUser.id);
    usersById.set(tokenUser.id, {
      ...tokenUser,
      createdAt: existing?.createdAt || tokenUser.createdAt,
      updatedAt: tokenUser.updatedAt
    });
  }
  if (!AUTH_REQUIRED && !usersById.has(DEFAULT_USER_ID)) {
    const localUser = authUserFromIdentity({
      userId: DEFAULT_USER_ID,
      role: "local",
      scopes: [...DEFAULT_AUTH_SCOPES],
      orgId: null
    }, "local");
    usersById.set(localUser.id, localUser);
  }
  return [...usersById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function findStoreAuthTokenIdentity(store, token) {
  if (!store || !token) return null;
  const tokenHash = hashAuthToken(token);
  const tokenRecord = (store.authTokens || []).find((item) => item.tokenHash === tokenHash && item.status === "active");
  if (!tokenRecord) return null;
  const user = mergeAuthUsersWithConfiguredTokens(store.authUsers || []).find((item) => item.id === tokenRecord.userId);
  if (!user || user.status !== "active") return null;
  tokenRecord.lastUsedAt = new Date().toISOString();
  return {
    userId: user.id,
    role: user.role,
    scopes: normalizeAuthScopes(tokenRecord.scopes?.length ? tokenRecord.scopes : user.scopes),
    orgId: user.orgId || null,
    source: "store-token"
  };
}

function authIdentityResponse(identity) {
  return {
    user_id: identity.userId,
    role: identity.role,
    scopes: normalizeAuthScopes(identity.scopes),
    org_id: identity.orgId || null
  };
}

function listAuthUsers(store) {
  return mergeAuthUsersWithConfiguredTokens(store.authUsers || []).map((user) => ({
    id: user.id,
    role: user.role,
    scopes: user.scopes,
    org_id: user.orgId,
    source: user.source,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  }));
}

function listAuthTokenSummaries(store, userId = null) {
  return (store.authTokens || [])
    .filter((token) => !userId || token.userId === userId)
    .map((token) => ({
      id: token.id,
      user_id: token.userId,
      token_prefix: token.tokenPrefix,
      scopes: token.scopes,
      status: token.status,
      source: token.source,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
      lastUsedAt: token.lastUsedAt || null
    }));
}

function upsertLocalAuthUser(store, { userId, role = "user", scopes = ["project:read"], orgId = null, issueToken = true } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId || normalizedUserId === DEFAULT_USER_ID) {
    throw apiError("A non-local user id is required.", "AUTH_USER_ID_REQUIRED", 400);
  }
  const now = new Date().toISOString();
  store.authUsers ||= [];
  const normalized = normalizeAuthUserRecord({
    id: normalizedUserId,
    role,
    scopes: normalizeAuthScopes(scopes),
    orgId,
    source: "store",
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  const index = store.authUsers.findIndex((user) => user.id === normalizedUserId);
  if (index >= 0) {
    if (store.authUsers[index].source === "token-config") {
      throw apiError("Configured token users cannot be overwritten from the local store.", "AUTH_USER_CONFIG_MANAGED", 409);
    }
    store.authUsers[index] = {
      ...store.authUsers[index],
      ...normalized,
      createdAt: store.authUsers[index].createdAt || normalized.createdAt,
      updatedAt: now
    };
  } else {
    store.authUsers.push(normalized);
  }
  let issuedToken = null;
  let tokenRecord = null;
  if (issueToken) {
    issuedToken = createLocalAuthTokenValue();
    tokenRecord = normalizeAuthTokenRecord({
      id: crypto.randomUUID(),
      userId: normalizedUserId,
      tokenHash: hashAuthToken(issuedToken),
      tokenPrefix: issuedToken.slice(0, 12),
      scopes: normalized.scopes,
      status: "active",
      source: "store-token",
      createdAt: now,
      updatedAt: now
    });
    store.authTokens ||= [];
    store.authTokens.push(tokenRecord);
  }
  return {
    user: listAuthUsers(store).find((user) => user.id === normalizedUserId),
    token: issuedToken,
    token_record: tokenRecord ? listAuthTokenSummaries({ authTokens: [tokenRecord] })[0] : null
  };
}

function disableLocalAuthUser(store, userId) {
  const normalizedUserId = normalizeUserId(userId);
  const user = (store.authUsers || []).find((item) => item.id === normalizedUserId);
  if (!user) throw apiError("Auth user not found.", "AUTH_USER_NOT_FOUND", 404);
  if (user.source === "token-config") {
    throw apiError("Configured token users cannot be disabled from the local store.", "AUTH_USER_CONFIG_MANAGED", 409);
  }
  const now = new Date().toISOString();
  user.status = "disabled";
  user.updatedAt = now;
  (store.authTokens || []).forEach((token) => {
    if (token.userId === normalizedUserId) {
      token.status = "disabled";
      token.updatedAt = now;
    }
  });
  return {
    user: listAuthUsers(store).find((item) => item.id === normalizedUserId),
    tokens: listAuthTokenSummaries(store, normalizedUserId)
  };
}

function createAuthEvent({ identity = null, req, pathname, requiredScope = null, status, reason = null }) {
  return normalizeAuthEvent({
    userId: identity?.userId || null,
    role: identity?.role || null,
    scopes: identity?.scopes || [],
    method: req?.method || "UNKNOWN",
    path: pathname || "unknown",
    requiredScope,
    status,
    reason
  });
}

function recordAuthEvent(store, event) {
  if (!event) return;
  store.authEvents ||= [];
  store.authEvents.push(event);
  store.authEvents = store.authEvents.slice(-200);
}

function listAuthEvents(store, limit = 50) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  return (store.authEvents || []).slice(-boundedLimit).reverse().map((event) => ({
    id: event.id,
    user_id: event.userId,
    role: event.role,
    scopes: event.scopes,
    method: event.method,
    path: event.path,
    required_scope: event.requiredScope,
    status: event.status,
    reason: event.reason,
    createdAt: event.createdAt
  }));
}

function getRequestAuthToken(req) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return String(req.headers["x-api-key"] || req.headers["x-ai-pm-token"] || "").trim();
}

function resolveAuthenticatedUserId(req, source = {}, store = null) {
  if (!AUTH_REQUIRED) return resolveUserId(req, source);
  const token = getRequestAuthToken(req);
  if (!token) throw apiError("Authentication token is required.", "AUTH_REQUIRED", 401);
  const identity = AUTH_TOKEN_TO_IDENTITY.get(token) || findStoreAuthTokenIdentity(store, token);
  if (!identity) throw apiError("Authentication token is invalid.", "AUTH_INVALID", 401);
  const requestedUserId = source.userId || source.user_id || req.headers["x-user-id"] || req.headers["x-ai-pm-user-id"];
  if (requestedUserId && normalizeUserId(requestedUserId) !== identity.userId) {
    throw apiError("Authenticated token cannot act as a different user.", "AUTH_USER_MISMATCH", 403);
  }
  return identity.userId;
}

function resolveAuthenticatedIdentity(req, source = {}, store = null) {
  if (!AUTH_REQUIRED) {
    return {
      userId: resolveUserId(req, source),
      role: "local",
      scopes: [...DEFAULT_AUTH_SCOPES],
      orgId: null
    };
  }
  const userId = resolveAuthenticatedUserId(req, source, store);
  const token = getRequestAuthToken(req);
  return AUTH_TOKEN_TO_IDENTITY.get(token) || findStoreAuthTokenIdentity(store, token) || normalizeAuthIdentity(userId);
}

function hasAuthScope(identity, requiredScope) {
  if (!requiredScope) return true;
  const scopes = identity?.scopes || [];
  return scopes.includes("*") || scopes.includes(requiredScope);
}

function requiredScopeForRequest(req, pathname) {
  if (pathname === "/api/health") return null;
  if (req.method === "GET" && (pathname === "/api/auth/users" || pathname === "/api/auth/events")) return "auth:read";
  if (req.method === "GET") return "project:read";
  if (pathname === "/api/auth/users" || pathname === "/api/auth/users/disable") return "auth:write";
  if (pathname === "/api/import") return "project:write";
  if (pathname === "/api/memory/confirm" || pathname === "/api/memory/forget" || pathname === "/api/memory/backup" || pathname === "/api/memory/restore-plan" || pathname === "/api/memory/restore") return "memory:write";
  if (pathname === "/api/chat" || pathname === "/api/agent-impact" || pathname === "/api/onboarding" || pathname === "/api/langgraph-resume") return "answer:write";
  if (pathname === "/api/feedback") return "feedback:write";
  return "project:read";
}

function requireAuthScope(req, pathname, store = null) {
  if (!AUTH_REQUIRED || pathname === "/api/health") return null;
  const identity = resolveAuthenticatedIdentity(req, {}, store);
  const requiredScope = requiredScopeForRequest(req, pathname);
  if (!hasAuthScope(identity, requiredScope)) {
    const error = apiError(`Authenticated token lacks required scope: ${requiredScope}.`, "AUTH_SCOPE_FORBIDDEN", 403);
    error.required_scope = requiredScope;
    error.auth = {
      user_id: identity.userId,
      role: identity.role,
      scopes: identity.scopes,
      org_id: identity.orgId
    };
    throw error;
  }
  req.auth = identity;
  req.authEvent = createAuthEvent({ identity, req, pathname, requiredScope, status: "allowed" });
  return identity;
}

function resolveUserId(req, source = {}) {
  return normalizeUserId(
    source.userId
    || source.user_id
    || req.headers["x-user-id"]
    || req.headers["x-ai-pm-user-id"]
    || DEFAULT_USER_ID
  );
}

export {
  normalizeAuthEvent,
  normalizeAuthIdentity,
  parseAuthTokenConfig,
  AUTH_TOKEN_TO_IDENTITY,
  normalizeAuthScopes,
  normalizeAuthRole,
  authUserFromIdentity,
  hashAuthToken,
  createLocalAuthTokenValue,
  normalizeAuthTokenRecord,
  normalizeAuthUserRecord,
  mergeAuthUsersWithConfiguredTokens,
  findStoreAuthTokenIdentity,
  authIdentityResponse,
  listAuthUsers,
  listAuthTokenSummaries,
  upsertLocalAuthUser,
  disableLocalAuthUser,
  createAuthEvent,
  recordAuthEvent,
  listAuthEvents,
  getRequestAuthToken,
  resolveAuthenticatedUserId,
  resolveAuthenticatedIdentity,
  hasAuthScope,
  requiredScopeForRequest,
  requireAuthScope,
  resolveUserId
};
