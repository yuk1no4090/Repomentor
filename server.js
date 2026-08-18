import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  PORT, HOST, log, PUBLIC_DIR, STORE_PATH,
  MEMORY_DB_PATH, DEFAULT_USER_ID,
  AUTH_REQUIRED, RUNTIME_METADATA,
  MAX_REQUEST_BODY_BYTES,
  MAX_QUESTION_LENGTH, CORS_ORIGIN, AGENT_GRAPH_MODE,
  AGENT_HITL_ENABLED, RATE_LIMIT_WINDOW_MS, checkRateLimit,
  LLM_REQUEST_TIMEOUT_MS, LLM_CONTEXT_TOKEN_BUDGET,
  safetyPolicySummary, MIME_TYPES, normalizeUserId, apiError
} from "./lib/config.js";
import {
  ensureStore, saveStore, withWriteLock, setStoreRecordNormalizers, flushStore
} from "./lib/store.js";
import {
  listSchemaMigrations, getMemoryDatabaseStatus,
  createMemoryDatabaseBackup, listMemoryDatabaseBackups,
  createMemoryDatabaseRestorePlan, restoreMemoryDatabaseFromBackup,
  resolveMemoryEmbeddingMode, resolveMemoryVectorIndexMode,
  upsertLongTermMemoryFromSuggestion, markLongTermMemoryForgotten,
  parsePositiveInteger, normalizeLongTermMemoryStatusFilter,
  searchLongTermMemory, listLongTermMemories, summarizeLongTermMemories,
  normalizeMemorySuggestion, normalizeMemoryEvent
} from "./lib/memory-db.js";
import {
  loadLangGraphCheckpointPayload, listLangGraphCheckpoints,
  findLangGraphCheckpoint, buildLangGraphReplay, runLangGraphResumeFromCheckpoint,
  setCheckpointCollaborators
} from "./lib/checkpoints.js";
import {
  normalizeAuthUserRecord, normalizeAuthTokenRecord, normalizeAuthEvent,
  mergeAuthUsersWithConfiguredTokens, AUTH_TOKEN_TO_IDENTITY,
  listAuthUsers, listAuthTokenSummaries, listAuthEvents,
  upsertLocalAuthUser, disableLocalAuthUser, createAuthEvent, recordAuthEvent,
  requireAuthScope, requiredScopeForRequest, resolveAuthenticatedIdentity,
  resolveAuthenticatedUserId, authIdentityResponse, resolveUserId
} from "./lib/auth.js";
import {
  findProject, fetchGithubZip, parseZip, createProject
} from "./lib/importer.js";
import {
  retrieveChunks
} from "./lib/retrieval.js";
import {
  scanInputSafety, scanRetrievedSafety, scanOutputSafety,
  mergeSafetyReports, safetyChecksToGuardrails,
  redactSensitivePayloadWithReport, attachOutputRedactionReport,
  collectCitationFiles
} from "./lib/safety.js";
import {
  resolveLlmEndpoint, resolveLlmModel, resolveLlmProvider, runModelAdapter
} from "./lib/llm.js";
import {
  generateQaAnswer, generateImpactAnswer, generateOnboardingPlan,
  inferQuestionType, relatedFilesFromChunks,
  validateImpactPayload, validateQaPayload,
  applyPreferencesToImpact, applyPreferencesToQa,
  createEmptyPreferences, normalizePreferences,
  getUserPreferences, setUserPreferences,
  isKnownMemoryValue, validateMemorySuggestionValue, MEMORY_PREFERENCE_KEYS,
  createMemorySuggestions, appendMemorySuggestions, applyMemorySuggestion,
  createMemoryEvent, summarizePreferences
} from "./lib/answers.js";
import {
  makeTraceStep, validateTraceToolUse, createHarnessRunId,
  buildChatHarnessReport, buildOnboardingHarnessReport,
  normalizeHarnessRun, createHarnessRunSnapshot, recordHarnessRun,
  runAgenticImpactWorkflow
} from "./lib/agent-graph.js";
import {
  computeMetrics, FEEDBACK_TYPES
} from "./lib/metrics.js";

const SAMPLE_FILES = [
  {
    path: "README.md",
    content: `# Commerce API

Commerce API is a Node.js backend for users, products, orders, payments, coupons, and refunds.

## Startup
npm install
npm run dev

## Authentication
Clients call POST /api/login. The auth route validates credentials, issues a JWT, and returns the token to the client.

## Business flows
Orders are created from cart items, then paid through the payment service. Refunds can update order status after payment settlement.`
  },
  {
    path: "src/routes/auth.ts",
    content: `import { authService } from "../services/authService";

export async function loginRoute(req, res) {
  const { email, password } = req.body;
  const user = await authService.validateUser(email, password);
  if (!user) return res.status(401).json({ error: "invalid_credentials" });
  const token = authService.issueJwt(user);
  return res.json({ token, userId: user.id });
}`
  },
  {
    path: "src/services/authService.ts",
    content: `export const authService = {
  async validateUser(email: string, password: string) {
    const user = await userRepository.findByEmail(email);
    if (!user) return null;
    return passwordHasher.compare(password, user.passwordHash) ? user : null;
  },
  issueJwt(user) {
    return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET);
  }
};`
  },
  {
    path: "src/models/order.ts",
    content: `export type OrderStatus =
  | "draft"
  | "pending_payment"
  | "paid"
  | "cancelled"
  | "refunded";

export interface Order {
  id: string;
  userId: string;
  status: OrderStatus;
  totalAmount: number;
  couponCode?: string;
}`
  },
  {
    path: "src/routes/order.ts",
    content: `import { orderService } from "../services/orderService";

export async function createOrderRoute(req, res) {
  const order = await orderService.createOrder(req.user.id, req.body.items, req.body.couponCode);
  return res.status(201).json(order);
}

export async function cancelOrderRoute(req, res) {
  const order = await orderService.cancelOrder(req.params.orderId, req.user.id);
  return res.json(order);
}`
  },
  {
    path: "src/services/orderService.ts",
    content: `export const orderService = {
  async createOrder(userId: string, items: CartItem[], couponCode?: string) {
    const pricedItems = await productService.priceItems(items);
    const discount = couponCode ? await couponService.validateCoupon(couponCode, userId) : 0;
    return orderRepository.create({
      userId,
      items: pricedItems,
      totalAmount: calculateTotal(pricedItems, discount),
      status: "pending_payment"
    });
  },
  async markPaid(orderId: string) {
    return orderRepository.updateStatus(orderId, "paid");
  },
  async cancelOrder(orderId: string, userId: string) {
    const order = await orderRepository.findById(orderId);
    if (order.userId !== userId || order.status === "paid") throw new Error("cannot_cancel");
    return orderRepository.updateStatus(orderId, "cancelled");
  }
};`
  },
  {
    path: "src/services/paymentService.ts",
    content: `export const paymentService = {
  async chargeOrder(orderId: string, paymentMethodId: string) {
    const order = await orderRepository.findById(orderId);
    const result = await paymentGateway.charge(order.totalAmount, paymentMethodId);
    if (result.status === "succeeded") {
      await orderService.markPaid(orderId);
    }
    if (result.status === "failed") {
      await paymentRepository.recordFailure(orderId, result.failureCode);
    }
    return result;
  }
};`
  },
  {
    path: "src/services/refundService.ts",
    content: `export const refundService = {
  async refundOrder(orderId: string, amount: number) {
    const order = await orderRepository.findById(orderId);
    if (order.status !== "paid") throw new Error("order_not_paid");
    const refund = await paymentGateway.refund(orderId, amount);
    if (refund.fullRefund) {
      await orderRepository.updateStatus(orderId, "refunded");
    }
    return refund;
  }
};`
  },
  {
    path: "src/services/couponService.ts",
    content: `export const couponService = {
  async validateCoupon(code: string, userId: string) {
    const coupon = await couponRepository.findActiveByCode(code);
    if (!coupon) throw new Error("invalid_coupon");
    if (coupon.usedBy.includes(userId)) throw new Error("coupon_already_used");
    return coupon.amountOff;
  }
};`
  },
  {
    path: "src/pages/order-detail.tsx",
    content: `export function OrderDetail({ order }) {
  return (
    <section>
      <h1>Order {order.id}</h1>
      <span data-status={order.status}>{order.status}</span>
      <strong>{order.totalAmount}</strong>
    </section>
  );
}`
  },
  {
    path: "tests/order.test.ts",
    content: `describe("orders", () => {
  it("creates pending payment orders", async () => {});
  it("does not cancel paid orders", async () => {});
  it("marks paid orders after successful payment", async () => {});
});`
  }
];


function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, X-API-Key, X-AI-PM-Token, X-User-Id, X-AI-PM-User-Id"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(apiError("Request body is too large. Keep ZIP uploads under 30MB for the MVP.", "REQUEST_BODY_TOO_LARGE", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function findHarnessRunAudit(store, projectId, runId, userId = null) {
  if (!runId) throw apiError("Run id is required.", "RUN_ID_REQUIRED");
  findProject(store, projectId, userId);
  const persisted = (store.harnessRuns || []).find((item) => item.projectId === projectId && item.run_id === runId);
  const answer = store.answers.find((item) => {
    return item.projectId === projectId && item.payload?.harness?.run_id === runId;
  });
  const run = persisted || (answer ? createHarnessRunSnapshot(answer) : null);
  if (!run) throw apiError("Harness run not found.", "HARNESS_RUN_NOT_FOUND", 404);
  return {
    run,
    checkpoints: listLangGraphCheckpoints({ projectId, runId, limit: 20 }),
    answer: answer
      ? {
          answer_id: answer.id,
          question_id: answer.questionId,
          kind: answer.kind,
          createdAt: answer.createdAt,
          harness: answer.payload?.harness || null,
          safety: answer.payload?.safety || null,
          guardrails: answer.payload?.guardrails || [],
          trace: answer.payload?.trace || []
        }
      : null
  };
}

// Routes whose handlers run 30s-class LLM/LangGraph work (POST /api/chat,
// /api/agent-impact, /api/onboarding, /api/langgraph-resume). These do not go
// through the single request-wide withWriteLock() in handleApi() below —
// instead their route bodies in handleApiUnlocked() take two short,
// independent locks of their own: one for store setup + auth bookkeeping
// ("gate", via loadStoreWithAuthGate()) and one around the final
// push-to-store + saveStore() ("commit"), with the actual retrieval/LLM/graph
// work running unlocked in between. This is what lets a slow LLM call stop
// blocking every other POST (and every GET once AUTH_REQUIRED) behind it,
// which is what a single global write lock around the entire request used to
// do.
const HEAVY_MUTATION_PATHS = new Set([
  "/api/chat",
  "/api/agent-impact",
  "/api/onboarding",
  "/api/langgraph-resume"
]);
function isHeavyMutationRoute(method, pathname) {
  return method === "POST" && HEAVY_MUTATION_PATHS.has(pathname);
}

// Shared preamble for every route: load the resident store, then (when
// AUTH_REQUIRED) evaluate the auth scope for this request and record +
// persist an audit event either way (denial or success). This mutates the
// store (recordAuthEvent() pushes into store.authEvents; requireAuthScope()
// can bump a store-backed token's lastUsedAt via findStoreAuthTokenIdentity())
// and calls saveStore(), so the caller must already hold the write lock for
// the duration of this call — this function does not lock itself, so it can
// be composed either way: nested inside the whole-request lock that wraps
// lightweight routes, or wrapped in its own short-lived lock for the heavy
// routes above (see handleApi()/handleApiUnlocked() below).
async function loadStoreWithAuthGate(req, pathname) {
  const store = await ensureStore();
  if (AUTH_REQUIRED && pathname !== "/api/health") {
    try {
      requireAuthScope(req, pathname, store);
    } catch (error) {
      recordAuthEvent(store, createAuthEvent({
        identity: error.auth ? {
          userId: error.auth.user_id,
          role: error.auth.role,
          scopes: error.auth.scopes,
          orgId: error.auth.org_id
        } : null,
        req,
        pathname,
        requiredScope: error.required_scope || requiredScopeForRequest(req, pathname),
        status: "denied",
        reason: error.code || "AUTH_DENIED"
      }));
      await saveStore(store);
      throw error;
    }
    recordAuthEvent(store, req.authEvent);
    await saveStore(store);
  }
  return store;
}

// Used by the 4 heavy-mutation routes (see isHeavyMutationRoute() above) in
// place of a second resolveAuthenticatedUserId(req, body, store) call in
// their route body. That second call — needed because the request body,
// parsed only after the gate lock releases, can name a userId that must be
// checked against the authenticated token — would otherwise re-derive the
// identity from the token via findStoreAuthTokenIdentity() during the
// *unlocked* compute phase. For a store-backed token, that function bumps
// tokenRecord.lastUsedAt on the shared store object outside any lock.
// requireAuthScope() (run inside the gate lock, see loadStoreWithAuthGate()
// above) already resolved and validated the identity once per request and
// stashed it on req.auth, so this reuses that instead of re-resolving from
// the token, while still performing the same body/header-vs-token
// consistency check (AUTH_USER_MISMATCH) that resolveAuthenticatedUserId()
// performs — see scripts/auth-boundary-test.js's "impersonation" case, which
// POSTs a different body.userId than the token owns to /api/agent-impact and
// expects a 403.
function resolveHeavyRouteUserId(req, body) {
  if (!AUTH_REQUIRED) return resolveUserId(req, body);
  const identity = req.auth;
  const requestedUserId = body.userId || body.user_id || req.headers["x-user-id"] || req.headers["x-ai-pm-user-id"];
  if (requestedUserId && normalizeUserId(requestedUserId) !== identity.userId) {
    throw apiError("Authenticated token cannot act as a different user.", "AUTH_USER_MISMATCH", 403);
  }
  return identity.userId;
}

async function handleApi(req, res, pathname) {
  // Non-GET requests always mutate the store, so they always take the write
  // lock. GET only needs the lock when AUTH_REQUIRED is on and the route
  // isn't /api/health: that's the one GET path that calls
  // recordAuthEvent()+saveStore() (see loadStoreWithAuthGate() above), so it
  // can race with a concurrent POST's load-modify-save cycle. /api/health is
  // explicitly excluded from that auth-event bookkeeping and never writes
  // the store, so it must stay unlocked — agent workflow requests can hold
  // a write lock for 30s+ (LLM_REQUEST_TIMEOUT_MS x multi-step runs), and
  // the Dockerfile HEALTHCHECK only allows 5s with 3 retries; queuing health
  // checks behind that would get the container flagged unhealthy.
  //
  // The heavy LLM/LangGraph routes are the other reason a request could hold
  // a lock that long, and now they don't: handleApiUnlocked() manages its own
  // short gate/commit locks for them (see isHeavyMutationRoute() above), so
  // this dispatcher must not also wrap their whole call in a lock here — that
  // would just reintroduce the same request-wide serialization via a second,
  // redundant lock layer (and, if it ever nested inside handleApiUnlocked's
  // own withWriteLock() calls, would deadlock: withWriteLock()'s queue is not
  // reentrant).
  if (isHeavyMutationRoute(req.method, pathname)) {
    return handleApiUnlocked(req, res, pathname);
  }
  const needsWriteLock = req.method !== "GET" || (AUTH_REQUIRED && pathname !== "/api/health");
  if (needsWriteLock) {
    return withWriteLock(() => handleApiUnlocked(req, res, pathname));
  }
  return handleApiUnlocked(req, res, pathname);
}

async function handleApiUnlocked(req, res, pathname) {
  let store = null;
  try {
    store = isHeavyMutationRoute(req.method, pathname)
      ? await withWriteLock(() => loadStoreWithAuthGate(req, pathname))
      : await loadStoreWithAuthGate(req, pathname);

    if (req.method === "GET" && pathname === "/api/auth/me") {
      const identity = resolveAuthenticatedIdentity(req, {}, store);
      sendJson(res, 200, {
        auth_required: AUTH_REQUIRED,
        identity: authIdentityResponse(identity)
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/auth/users") {
      sendJson(res, 200, {
        auth_required: AUTH_REQUIRED,
        users: listAuthUsers(store),
        tokens: listAuthTokenSummaries(store)
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/auth/events") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      sendJson(res, 200, {
        auth_required: AUTH_REQUIRED,
        events: listAuthEvents(store, url.searchParams.get("limit") || 50)
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/users") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const created = upsertLocalAuthUser(store, {
        userId: body.userId || body.user_id || body.id,
        role: body.role || "user",
        scopes: Array.isArray(body.scopes) ? body.scopes : ["project:read"],
        orgId: body.orgId || body.org_id || null,
        issueToken: body.issueToken !== false && body.issue_token !== false
      });
      recordAuthEvent(store, createAuthEvent({
        identity: req.auth,
        req,
        pathname,
        requiredScope: "auth:write",
        status: "allowed",
        reason: `created_user:${created.user.id}`
      }));
      await saveStore(store);
      sendJson(res, 200, {
        user: created.user,
        token: created.token,
        token_record: created.token_record,
        token_visible_once: !!created.token
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/users/disable") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const disabled = disableLocalAuthUser(store, body.userId || body.user_id || body.id);
      recordAuthEvent(store, createAuthEvent({
        identity: req.auth,
        req,
        pathname,
        requiredScope: "auth:write",
        status: "allowed",
        reason: `disabled_user:${disabled.user.id}`
      }));
      await saveStore(store);
      sendJson(res, 200, disabled);
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      const userId = resolveAuthenticatedUserId(req, {}, store);
      const visibleTo = (project) => {
        if (!AUTH_REQUIRED) return true;
        return !project.ownerId || project.ownerId === userId;
      };
      sendJson(res, 200, {
        projects: store.projects.filter(visibleTo).map((project) => ({
          id: project.id,
          name: project.name,
          source: project.source,
          ownerId: project.ownerId || null,
          createdAt: project.createdAt,
          fileCount: project.fileCount,
          chunkCount: project.chunkCount,
          summary: project.summary,
          files: project.files
        }))
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/memory") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const userId = resolveAuthenticatedUserId(req, { userId: url.searchParams.get("userId") || url.searchParams.get("user_id") }, store);
      const projectId = url.searchParams.get("projectId");
      if (projectId) findProject(store, projectId, userId);
      const query = String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim();
      const status = normalizeLongTermMemoryStatusFilter(url.searchParams.get("status") || "active");
      const limit = parsePositiveInteger(url.searchParams.get("limit"), 20, 50);
      const suggestions = store.memorySuggestions
        .filter((item) => (item.userId || DEFAULT_USER_ID) === userId)
        .filter((item) => !projectId || item.projectId === projectId)
        .slice(-20)
        .reverse();
      const events = (store.memoryEvents || [])
        .filter((item) => (item.userId || DEFAULT_USER_ID) === userId)
        .filter((item) => !projectId || item.projectId === projectId || item.projectId == null)
        .slice(-20)
        .reverse();
      const longTermMemories = query
        ? await searchLongTermMemory({ userId, projectId, query, status, limit, recordUsage: false })
        : listLongTermMemories({ userId, projectId, status, limit });
      sendJson(res, 200, {
        user_id: userId,
        preferences: getUserPreferences(store, userId),
        suggestions,
        events,
        long_term_memories: longTermMemories,
        long_term_memory_query: {
          query,
          status,
          limit,
          embedding_model: resolveMemoryEmbeddingMode().model,
          embedding_provider: resolveMemoryEmbeddingMode().provider,
          vector_index_provider: resolveMemoryVectorIndexMode().provider,
          vector_search: !!query,
          result_count: longTermMemories.length
        }
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/memory/status") {
      sendJson(res, 200, { memory_database: getMemoryDatabaseStatus() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/memory/backups") {
      const backups = await listMemoryDatabaseBackups();
      sendJson(res, 200, {
        backups,
        backup_count: backups.length,
        directory_basename: path.basename(path.dirname(MEMORY_DB_PATH))
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/memory/backup") {
      const backup = await createMemoryDatabaseBackup();
      sendJson(res, 200, { backup });
      return;
    }

    if (req.method === "POST" && pathname === "/api/memory/restore-plan") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const restorePlan = createMemoryDatabaseRestorePlan({
        backupName: body.backup || body.backupName || body.backup_name,
        expectedSha256: body.sha256 || body.expectedSha256 || body.expected_sha256 || null
      });
      sendJson(res, 200, { restore_plan: restorePlan });
      return;
    }

    if (req.method === "POST" && pathname === "/api/memory/restore") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const restore = await restoreMemoryDatabaseFromBackup({
        backupName: body.backup || body.backupName || body.backup_name,
        expectedSha256: body.sha256 || body.expectedSha256 || body.expected_sha256 || null,
        confirm: body.confirm
      });
      sendJson(res, 200, { restore });
      return;
    }

    if (req.method === "POST" && pathname === "/api/memory/confirm") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const userId = resolveAuthenticatedUserId(req, body, store);
      const suggestion = store.memorySuggestions.find((item) => item.id === body.suggestionId);
      if (!suggestion) throw apiError("Memory suggestion not found.", "MEMORY_SUGGESTION_NOT_FOUND");
      if ((suggestion.userId || DEFAULT_USER_ID) !== userId) throw apiError("Memory suggestion belongs to a different user.", "MEMORY_USER_MISMATCH", 409);
      if (body.projectId && suggestion.projectId !== body.projectId) throw apiError("Memory suggestion does not belong to this project.", "MEMORY_PROJECT_MISMATCH", 409);
      if (suggestion.status !== "pending") throw apiError("Memory suggestion is not pending.", "MEMORY_SUGGESTION_NOT_PENDING");
      validateMemorySuggestionValue(suggestion);
      setUserPreferences(store, userId, applyMemorySuggestion(getUserPreferences(store, userId), suggestion));
      suggestion.status = "confirmed";
      suggestion.confirmedAt = new Date().toISOString();
      store.memoryEvents.push(createMemoryEvent({
        userId,
        suggestion,
        action: "confirmed",
        status: "confirmed"
      }));
      const longTermMemory = await upsertLongTermMemoryFromSuggestion(suggestion);
      await saveStore(store);
      sendJson(res, 200, {
        user_id: userId,
        preferences: getUserPreferences(store, userId),
        suggestion,
        event: store.memoryEvents.at(-1),
        long_term_memory: longTermMemory
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/memory/forget") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const userId = resolveAuthenticatedUserId(req, body, store);
      if (body.suggestionId) {
        const suggestion = store.memorySuggestions.find((item) => item.id === body.suggestionId);
        if (!suggestion) throw apiError("Memory suggestion not found.", "MEMORY_SUGGESTION_NOT_FOUND");
        if ((suggestion.userId || DEFAULT_USER_ID) !== userId) throw apiError("Memory suggestion belongs to a different user.", "MEMORY_USER_MISMATCH", 409);
        if (body.projectId && suggestion.projectId !== body.projectId) throw apiError("Memory suggestion does not belong to this project.", "MEMORY_PROJECT_MISMATCH", 409);
        if (suggestion.status !== "pending") throw apiError("Memory suggestion is not pending.", "MEMORY_SUGGESTION_NOT_PENDING");
        suggestion.status = "ignored";
        suggestion.ignoredAt = new Date().toISOString();
        store.memoryEvents.push(createMemoryEvent({
          userId,
          suggestion,
          action: "ignored",
          status: "ignored"
        }));
      } else if (body.key) {
        if (body.projectId) findProject(store, body.projectId, userId);
        if (!MEMORY_PREFERENCE_KEYS.has(body.key)) throw apiError("Unknown memory preference key.", "UNKNOWN_MEMORY_PREFERENCE_KEY");
        if (body.value && !isKnownMemoryValue(body.key, body.value)) throw apiError("Unknown memory preference value.", "UNKNOWN_MEMORY_PREFERENCE_VALUE");
        const preferences = getUserPreferences(store, userId);
        if (Array.isArray(preferences[body.key])) {
          preferences[body.key] = body.value
            ? preferences[body.key].filter((item) => item !== body.value)
            : [];
        } else {
          preferences[body.key] = null;
        }
        preferences.updatedAt = new Date().toISOString();
        setUserPreferences(store, userId, preferences);
        store.memoryEvents.push(createMemoryEvent({
          userId,
          projectId: body.projectId || null,
          action: "forgot_preference",
          key: body.key,
          value: body.value || null,
          label: body.value ? `Forgot ${body.key}: ${body.value}` : `Forgot ${body.key}`,
          status: "forgotten"
        }));
        await markLongTermMemoryForgotten({
          userId,
          projectId: body.projectId || null,
          key: body.key,
          value: body.value || null,
          reason: "forgotten"
        });
      } else {
        if (body.projectId) findProject(store, body.projectId, userId);
        setUserPreferences(store, userId, createEmptyPreferences());
        store.memoryEvents.push(createMemoryEvent({
          userId,
          projectId: body.projectId || null,
          action: "cleared_preferences",
          label: "Cleared all user preferences",
          status: "cleared"
        }));
        await markLongTermMemoryForgotten({
          userId,
          projectId: body.projectId || null,
          reason: "forgotten"
        });
      }
      await saveStore(store);
      sendJson(res, 200, {
        user_id: userId,
        preferences: getUserPreferences(store, userId),
        suggestions: store.memorySuggestions.filter((item) => (item.userId || DEFAULT_USER_ID) === userId).slice(-20).reverse(),
        events: store.memoryEvents.filter((item) => (item.userId || DEFAULT_USER_ID) === userId).slice(-20).reverse(),
        long_term_memories: listLongTermMemories({ userId, projectId: body.projectId || null, limit: 20 })
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/import") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const ownerId = resolveAuthenticatedUserId(req, body, store);
      let importResult;
      if (body.sample) {
        importResult = { files: SAMPLE_FILES, repoName: "Sample Commerce API", source: "sample" };
      } else if (body.repoUrl) {
        importResult = await fetchGithubZip(body.repoUrl);
      } else if (body.zipBase64) {
        const buffer = Buffer.from(body.zipBase64, "base64");
        importResult = {
          files: parseZip(buffer),
          repoName: body.fileName?.replace(/\.zip$/i, "") || "Uploaded Repository",
          source: "zip-upload"
        };
      } else {
        throw apiError("Provide a GitHub repo URL, ZIP upload, or choose the sample repository.", "IMPORT_SOURCE_REQUIRED");
      }

      const project = createProject({
        name: importResult.repoName,
        source: importResult.source,
        files: importResult.files,
        ownerId
      });
      store.projects.push(project);
      await saveStore(store);
      sendJson(res, 200, {
        project: {
          id: project.id,
          name: project.name,
          source: project.source,
          ownerId: project.ownerId,
          createdAt: project.createdAt,
          fileCount: project.fileCount,
          chunkCount: project.chunkCount,
          summary: project.summary,
          files: project.files
        }
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const userId = resolveHeavyRouteUserId(req, body);
      const project = findProject(store, body.projectId, userId);
      const question = String(body.question || "").trim();
      if (!question) throw apiError("Question is required.", "QUESTION_REQUIRED");
      if (question.length > MAX_QUESTION_LENGTH) throw apiError(`Question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters.`, "QUESTION_TOO_LONG", 413);
      const kind = body.kind || inferQuestionType(question);
      const started = Date.now();
      const runId = createHarnessRunId("chat");
      const chunks = retrieveChunks(project, question, kind === "impact" ? 10 : 8);
      const inputSafety = scanInputSafety(question);
      const retrievedSafety = scanRetrievedSafety(chunks);
      const preferences = getUserPreferences(store, userId);
      const memorySummary = summarizePreferences(preferences);
      const longTermMemories = await searchLongTermMemory({ userId, projectId: project.id, query: question, limit: 5 });
      const longTermSummary = summarizeLongTermMemories(longTermMemories);
      const combinedMemorySummary = [
        memorySummary !== "none" ? memorySummary : null,
        longTermSummary !== "none" ? `long_term=${longTermSummary}` : null
      ].filter(Boolean).join("; ") || "none";
      const memoryLearningAllowed = inputSafety.status === "passed";
      const memorySuggestions = memoryLearningAllowed
        ? createMemorySuggestions(store, project.id, question, userId)
        : [];
      const validatePayload = kind === "impact" ? validateImpactPayload : validateQaPayload;
      const modelResult = await runModelAdapter({ question, chunks, kind, project, validatePayload });
      let payload = modelResult.payload || (kind === "impact"
        ? generateImpactAnswer(question, chunks, project)
        : generateQaAnswer(question, chunks));
      if (kind === "impact") {
        payload = applyPreferencesToImpact(payload, preferences);
      } else {
        payload = applyPreferencesToQa(payload, preferences);
      }
      payload.memory_used = {
        used: combinedMemorySummary !== "none",
        summary: combinedMemorySummary,
        long_term: longTermMemories
      };
      payload.memory_suggestions = memorySuggestions;
      payload.llm_used = !!modelResult.event.llm_used;
      // Normalize uncertainty to string for consistent frontend + metrics
      if (payload.uncertainty === true || payload.uncertainty === false) {
        payload.uncertainty = payload.uncertainty ? "High. The available repository context may be insufficient." : "Low to medium.";
      }
      const outputSafety = scanOutputSafety(project, payload);
      const trace = [
        makeTraceStep({
          step: "1. Input safety scan",
          tool: "safety.scan_input",
          purpose: "Check the user request for prompt injection, secret requests, or write-tool intent.",
          input: question,
          output: {
            status: inputSafety.status,
            risk_types: inputSafety.risk_types,
            memory_suggestions: memorySuggestions.length,
            learning_skipped: !memoryLearningAllowed
          }
        }),
        makeTraceStep({
          step: "2. Retrieve repository context",
          tool: "retriever_agent.retrieve_repository_chunks",
          purpose: "Find read-only repository evidence for the answer.",
          input: { kind, question },
          output: { chunks: chunks.length, safety: retrievedSafety.status },
          citations: relatedFilesFromChunks(chunks).map((file) => file.file_path)
        }),
        makeTraceStep({
          step: "3. Compose answer",
          tool: "synthesizer_agent.compose_structured_answer",
          purpose: "Use schema-checked model output when valid, otherwise deterministic fallback.",
          input: { kind, llm_attempted: modelResult.event.llm_attempted },
          output: { llm_used: modelResult.event.llm_used, fallback_used: modelResult.event.fallback_used }
        }),
        makeTraceStep({
          step: "4. Output safety scan",
          tool: "safety_guardrail_agent.validate_output",
          purpose: "Validate citations, sensitive output, and overconfidence before returning.",
          input: { required: "Cited files must exist and secret-like values should not be echoed." },
          output: { status: outputSafety.status, risk_types: outputSafety.risk_types }
        })
      ];
      const toolSafety = validateTraceToolUse(trace);
      const safety = mergeSafetyReports(inputSafety, retrievedSafety, outputSafety, toolSafety);
      payload.trace = trace;
      payload.safety = safety;
      payload.guardrails = safetyChecksToGuardrails(safety.checks);
      payload.harness = buildChatHarnessReport({
        runId,
        started,
        trace,
        modelEvent: modelResult.event,
        errors: []
      });
      const redacted = redactSensitivePayloadWithReport(payload);
      payload = attachOutputRedactionReport(redacted.payload, redacted.redaction);
      const questionRecord = {
        id: crypto.randomUUID(),
        projectId: project.id,
        question,
        kind,
        createdAt: new Date().toISOString()
      };
      const answerRecord = {
        id: crypto.randomUUID(),
        projectId: project.id,
        questionId: questionRecord.id,
        kind,
        payload,
        responseTimeMs: Date.now() - started,
        createdAt: new Date().toISOString()
      };
      // Commit phase: everything above (retrieval, safety scans, the LLM
      // call) ran unlocked. Re-fetch the store here — it may have changed on
      // disk while we were computing (another writer, or a test harness
      // editing store.json directly; see lib/store.js's cache-invalidation
      // contract) — and re-validate the project still exists before
      // attaching records to it, so the actual mutation stays atomic and
      // free of the TOCTOU window the unlocked compute phase opened up.
      await withWriteLock(async () => {
        const commitStore = await ensureStore();
        // Return value intentionally discarded: we only need the
        // throw-if-missing side effect (re-validating the project wasn't
        // removed while we computed unlocked), not the project object itself.
        findProject(commitStore, project.id, userId);
        commitStore.questions.push(questionRecord);
        commitStore.answers.push(answerRecord);
        recordHarnessRun(commitStore, answerRecord);
        if (memorySuggestions.length) {
          appendMemorySuggestions(commitStore, memorySuggestions);
        }
        await saveStore(commitStore);
      });
      sendJson(res, 200, { answerId: answerRecord.id, kind, payload });
      return;
    }

    if (req.method === "POST" && pathname === "/api/onboarding") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const userId = resolveHeavyRouteUserId(req, body);
      const project = findProject(store, body.projectId, userId);
      const started = Date.now();
      const runId = createHarnessRunId("onboarding");
      const role = String(body.role || "Backend Engineer").slice(0, 100);
      const duration = String(body.duration || "3 days").slice(0, 50);
      let payload = generateOnboardingPlan(project, role, duration);
      const question = `Generate onboarding plan for ${payload.role}, ${payload.duration}`;
      const inputSafety = scanInputSafety(question);
      const memoryLearningAllowed = inputSafety.status === "passed";
      const memorySuggestions = memoryLearningAllowed
        ? createMemorySuggestions(store, project.id, question, userId)
        : [];
      const outputSafety = scanOutputSafety(project, payload);
      const trace = [
        makeTraceStep({
          step: "1. Input safety scan",
          tool: "safety.scan_input",
          purpose: "Check the onboarding request for prompt injection, secret requests, or write-tool intent.",
          input: question,
          output: {
            status: inputSafety.status,
            risk_types: inputSafety.risk_types,
            memory_suggestions: memorySuggestions.length,
            learning_skipped: !memoryLearningAllowed
          }
        }),
        makeTraceStep({
          step: "2. Generate onboarding plan",
          tool: "onboarding_planner_agent.generate_plan",
          purpose: "Create a role-based reading plan from recommended repository files.",
          input: { role: payload.role, duration: payload.duration },
          output: { days: payload.plan.length, files: collectCitationFiles(payload).length },
          citations: collectCitationFiles(payload)
        }),
        makeTraceStep({
          step: "3. Output safety scan",
          tool: "safety_guardrail_agent.validate_output",
          purpose: "Validate onboarding citations, sensitive output, and overconfidence before returning.",
          input: { required: "Plan files must exist in the imported repository." },
          output: { status: outputSafety.status, risk_types: outputSafety.risk_types }
        })
      ];
      const toolSafety = validateTraceToolUse(trace);
      const safety = mergeSafetyReports(inputSafety, outputSafety, toolSafety);
      payload.llm_used = false;
      payload.memory_used = { used: false, summary: "none" };
      payload.memory_suggestions = memorySuggestions;
      payload.trace = trace;
      payload.safety = safety;
      payload.guardrails = safetyChecksToGuardrails(safety.checks);
      payload.harness = buildOnboardingHarnessReport({
        runId,
        started,
        trace,
        errors: []
      });
      const redacted = redactSensitivePayloadWithReport(payload);
      payload = attachOutputRedactionReport(redacted.payload, redacted.redaction);
      const questionRecord = {
        id: crypto.randomUUID(),
        projectId: project.id,
        question,
        kind: "onboarding",
        createdAt: new Date().toISOString()
      };
      const answerRecord = {
        id: crypto.randomUUID(),
        projectId: project.id,
        questionId: questionRecord.id,
        kind: "onboarding",
        payload,
        responseTimeMs: 0,
        createdAt: new Date().toISOString()
      };
      // Commit phase — see the matching comment in /api/chat above.
      await withWriteLock(async () => {
        const commitStore = await ensureStore();
        // Return value intentionally discarded: we only need the
        // throw-if-missing side effect (re-validating the project wasn't
        // removed while we computed unlocked), not the project object itself.
        findProject(commitStore, project.id, userId);
        commitStore.questions.push(questionRecord);
        commitStore.answers.push(answerRecord);
        recordHarnessRun(commitStore, answerRecord);
        if (memorySuggestions.length) {
          appendMemorySuggestions(commitStore, memorySuggestions);
        }
        await saveStore(commitStore);
      });
      sendJson(res, 200, { answerId: answerRecord.id, kind: "onboarding", payload });
      return;
    }

    if (req.method === "POST" && pathname === "/api/agent-impact") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const userId = resolveHeavyRouteUserId(req, body);
      const project = findProject(store, body.projectId, userId);
      const question = String(body.question || "").trim();
      if (!question) throw apiError("Question is required.", "QUESTION_REQUIRED");
      if (question.length > MAX_QUESTION_LENGTH) throw apiError(`Question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters.`, "QUESTION_TOO_LONG", 413);
      const started = Date.now();
      const payload = await runAgenticImpactWorkflow(store, project, question, userId);
      const questionRecord = {
        id: crypto.randomUUID(),
        projectId: project.id,
        question,
        kind: "agent_impact",
        createdAt: new Date().toISOString()
      };
      const answerRecord = {
        id: crypto.randomUUID(),
        projectId: project.id,
        questionId: questionRecord.id,
        kind: "agent_impact",
        payload,
        responseTimeMs: Date.now() - started,
        createdAt: new Date().toISOString()
      };
      // Commit phase — see the matching comment in /api/chat above. This is
      // the route this whole refactor is for: runAgenticImpactWorkflow()
      // above is the 30s-class LangGraph call that used to hold the single
      // global write lock for its entire duration.
      await withWriteLock(async () => {
        const commitStore = await ensureStore();
        // Return value intentionally discarded: we only need the
        // throw-if-missing side effect (re-validating the project wasn't
        // removed while we computed unlocked), not the project object itself.
        findProject(commitStore, project.id, userId);
        if (payload.memory_suggestions?.length) {
          appendMemorySuggestions(commitStore, payload.memory_suggestions);
        }
        commitStore.questions.push(questionRecord);
        commitStore.answers.push(answerRecord);
        recordHarnessRun(commitStore, answerRecord);
        await saveStore(commitStore);
      });
      sendJson(res, 200, { answerId: answerRecord.id, kind: "agent_impact", payload });
      return;
    }

    if (req.method === "POST" && pathname === "/api/feedback") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const answer = store.answers.find((item) => item.id === body.answerId);
      if (!answer) throw apiError("Answer not found.", "ANSWER_NOT_FOUND");
      if (!FEEDBACK_TYPES.has(body.type)) throw apiError("Invalid feedback type.", "INVALID_FEEDBACK_TYPE");
      const record = {
        id: crypto.randomUUID(),
        projectId: answer.projectId,
        answerId: answer.id,
        harness_run_id: answer.payload?.harness?.run_id || null,
        type: body.type,
        createdAt: new Date().toISOString()
      };
      store.feedback.push(record);
      await saveStore(store);
      sendJson(res, 200, { feedback: record, metrics: computeMetrics(store, answer.projectId) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/evaluation") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const userId = resolveAuthenticatedUserId(req, {}, store);
      const project = findProject(store, url.searchParams.get("projectId"), userId);
      sendJson(res, 200, { metrics: computeMetrics(store, project.id) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/harness-run") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const userId = resolveAuthenticatedUserId(req, {}, store);
      const project = findProject(store, url.searchParams.get("projectId"), userId);
      const audit = findHarnessRunAudit(store, project.id, url.searchParams.get("runId"), userId);
      sendJson(res, 200, audit);
      return;
    }

    if (req.method === "GET" && pathname === "/api/langgraph-checkpoint") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const userId = resolveAuthenticatedUserId(req, {}, store);
      const project = findProject(store, url.searchParams.get("projectId"), userId);
      const checkpoint = findLangGraphCheckpoint(store, {
        projectId: project.id,
        runId: url.searchParams.get("runId"),
        checkpointId: url.searchParams.get("checkpointId") || url.searchParams.get("checkpoint_id"),
        userId
      });
      const checkpointPayload = loadLangGraphCheckpointPayload({ projectId: project.id, runId: checkpoint.run_id });
      sendJson(res, 200, {
        checkpoint,
        time_travel: {
          mode: "read-only checkpoint audit",
          resumable: !!checkpointPayload,
          executable_resume_available: !!checkpointPayload,
          note: "This endpoint exposes persisted checkpoint summaries for inspection; executable continuation is available through POST /api/langgraph-resume when a checkpoint payload exists."
        }
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/langgraph-replay") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const userId = resolveAuthenticatedUserId(req, {}, store);
      const project = findProject(store, url.searchParams.get("projectId"), userId);
      const replay = buildLangGraphReplay(store, {
        projectId: project.id,
        runId: url.searchParams.get("runId")
      });
      sendJson(res, 200, replay);
      return;
    }

    if (req.method === "POST" && pathname === "/api/langgraph-resume") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const userId = resolveHeavyRouteUserId(req, body);
      const project = findProject(store, body.projectId, userId);
      const started = Date.now();
      const resumed = await runLangGraphResumeFromCheckpoint(store, {
        projectId: project.id,
        runId: body.runId || body.run_id,
        checkpointId: body.checkpointId || body.checkpoint_id || null,
        userId,
        decision: body.decision || null
      });
      const questionRecord = {
        id: crypto.randomUUID(),
        projectId: resumed.project.id,
        question: resumed.question,
        kind: "agent_impact_resume",
        createdAt: new Date().toISOString()
      };
      const answerRecord = {
        id: crypto.randomUUID(),
        questionId: questionRecord.id,
        projectId: resumed.project.id,
        kind: "agent_impact",
        payload: resumed.payload,
        responseTimeMs: Date.now() - started,
        createdAt: new Date().toISOString()
      };
      // Commit phase — see the matching comment in /api/chat above.
      // runLangGraphResumeFromCheckpoint() re-invokes the same 30s-class
      // LangGraph workflow as /api/agent-impact.
      await withWriteLock(async () => {
        const commitStore = await ensureStore();
        // Return value intentionally discarded — see the matching comment in
        // /api/chat's commit lock above.
        findProject(commitStore, resumed.project.id, userId);
        if (resumed.payload.memory_suggestions?.length) {
          appendMemorySuggestions(commitStore, resumed.payload.memory_suggestions);
        }
        commitStore.questions.push(questionRecord);
        commitStore.answers.push(answerRecord);
        recordHarnessRun(commitStore, answerRecord);
        await saveStore(commitStore);
      });
      sendJson(res, 200, {
        answerId: answerRecord.id,
        kind: "agent_impact",
        resumed_from: {
          run_id: body.runId || body.run_id,
          checkpoint_id: resumed.checkpoint.checkpoint_id,
          mode: "input_snapshot_reexecution"
        },
        payload: resumed.payload
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      const hasKey = !!process.env.OPENAI_API_KEY;
      const model = resolveLlmModel();
      const provider = resolveLlmProvider();
      const endpoint = hasKey ? resolveLlmEndpoint() : null;
      // Check SQLite connectivity
      let dbStatus = "unknown";
      let dbTest = null;
      try {
        dbTest = new DatabaseSync(MEMORY_DB_PATH);
        dbTest.exec("SELECT 1");
        dbStatus = "connected";
      } catch (e) {
        dbStatus = `error: ${e.message}`;
      } finally {
        if (dbTest) { try { dbTest.close(); } catch {} }
      }
      // Check store file health
      let storeStatus = "ok";
      try {
        await fs.access(STORE_PATH, fs.constants.R_OK | fs.constants.W_OK);
      } catch {
        storeStatus = "unavailable";
      }
      const healthy = dbStatus === "connected" && storeStatus === "ok";
      sendJson(res, healthy ? 200 : 503, {
        status: healthy ? "ok" : "degraded",
        ready: healthy,
        database: { status: dbStatus, path: MEMORY_DB_PATH },
        store: { status: storeStatus, path: STORE_PATH },
        llm: {
          configured: hasKey,
          provider,
          model,
          endpoint: endpoint || "(not configured - set OPENAI_API_KEY)",
          request_timeout_ms: LLM_REQUEST_TIMEOUT_MS,
          context_token_budget: LLM_CONTEXT_TOKEN_BUDGET
        },
        version: RUNTIME_METADATA.version,
        commit: RUNTIME_METADATA.commit,
        node: RUNTIME_METADATA.node,
        environment: RUNTIME_METADATA.environment,
        auth: {
          required: AUTH_REQUIRED,
          token_count: AUTH_TOKEN_TO_IDENTITY.size,
          store_token_count: (store.authTokens || []).filter((token) => token.status === "active").length,
          users_indexed: listAuthUsers(store).length,
          user_binding: "token",
          scopes_enabled: AUTH_REQUIRED
        },
        memory_embedding: {
          provider: resolveMemoryEmbeddingMode().provider,
          model: resolveMemoryEmbeddingMode().model,
          external_configured: resolveMemoryEmbeddingMode().provider !== "local"
        },
        memory_vector_index: {
          provider: resolveMemoryVectorIndexMode().provider,
          namespace: resolveMemoryVectorIndexMode().namespace,
          external_configured: resolveMemoryVectorIndexMode().provider !== "local-sqlite"
        },
        schema_migrations: {
          store: "SQLite schema_migrations",
          recent: listSchemaMigrations(5)
        },
        safety_policy: safetyPolicySummary(),
        uptime_seconds: Math.floor(process.uptime())
      });
      return;
    }

    sendJson(res, 404, { error: "API route not found.", code: "ROUTE_NOT_FOUND" });
  } catch (error) {
    sendJson(res, error.status || 400, {
      error: error.message || "Request failed.",
      code: error.code || "BAD_REQUEST",
      required_scope: error.required_scope || null,
      auth: error.auth || null
    });
  }
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream", "access-control-allow-origin": CORS_ORIGIN });
    res.end(content);
  } catch {
    const fallback = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": CORS_ORIGIN });
    res.end(fallback);
  }
}

// ── Wire up lib/store.js + lib/checkpoints.js collaborators ──
// See lib/store.js and lib/checkpoints.js for why these are injected rather
// than imported directly: normalizeStore()'s record normalizers and the
// checkpoint replay/resume helpers depend on auth/preferences/project/agent-
// workflow logic that stays in server.js for this storage-layer split, and
// lib modules must not import from server.js (that would cycle back through
// the ./lib/store.js / ./lib/checkpoints.js imports above). The auth
// normalizers are now imported from lib/auth.js (itself dependency-free with
// respect to server.js); the remaining preferences/memory/harness normalizers
// are still hoisted function declarations defined later in this file. Either
// way this only needs to run once, before any request is served.
setStoreRecordNormalizers({
  normalizeAuthUserRecord,
  normalizeAuthTokenRecord,
  normalizeAuthEvent,
  normalizeHarnessRun,
  createEmptyPreferences,
  normalizePreferences,
  normalizeMemorySuggestion,
  normalizeMemoryEvent,
  mergeAuthUsersWithConfiguredTokens
});
setCheckpointCollaborators({
  findProject,
  findHarnessRunAudit,
  runAgenticImpactWorkflow
});

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": CORS_ORIGIN,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, X-API-Key, X-AI-PM-Token, X-User-Id, X-AI-PM-User-Id",
      "access-control-max-age": "86400"
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    // Prefer direct socket address; only use XFF when explicitly trusted (behind reverse proxy)
    const ip = process.env.TRUST_PROXY === "true"
      ? (req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown")
      : (req.socket.remoteAddress || "unknown");
    if (!checkRateLimit(ip)) {
      sendJson(res, 429, { error: "Rate limit exceeded. Please wait before sending more requests.", code: "RATE_LIMITED", retry_after_ms: RATE_LIMIT_WINDOW_MS });
      return;
    }
    await handleApi(req, res, url.pathname);
    return;
  }
  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  log("info", "server started", { host: HOST, port: PORT, graph_mode: AGENT_GRAPH_MODE, hitl_enabled: AGENT_HITL_ENABLED });
});

// ── Graceful shutdown ──
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown initiated", { signal });
  // Force close after 10s if drain takes too long
  const forceTimer = setTimeout(() => {
    log("warn", "forcing shutdown after timeout");
    process.exit(1);
  }, 10_000);
  forceTimer.unref();
  // Stop accepting new connections and drain existing ones
  await new Promise((resolve) => server.close(resolve));
  log("info", "http server closed");
  // Wait for any in-flight store.json write to actually land on disk before
  // exiting — ensureStore()/saveStore() now keep the store resident in memory
  // between requests (see lib/store.js), so this is the one place a pending
  // write could otherwise be lost to a signal arriving mid-save.
  await flushStore().catch((error) => {
    log("error", "store flush failed during shutdown", { error: error.message });
  });
  clearTimeout(forceTimer);
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

