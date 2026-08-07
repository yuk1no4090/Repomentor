# 开发日志 (CHANGELOG)

> 本文件记录 AI Developer Onboarding Copilot 项目的开发历程。
> 仓库：`yuk1no4090/AI-PM`，分支：`main`

---

## 2026-08-07 — 多 Agent 协同 + 生产就绪完善

### scene#17「Agent 应用」多 Agent 协同（4c32ed1）

基于外部课程 scene#17 场景，将线性 9 节点 LangGraph 工作流升级为 Supervisor 动态路由的多 Agent 协同架构。

**P1 — Agent 角色显式化**
- `AGENT_TOOL_REGISTRY` 11 个工具全部添加 `agent_role`，映射到 9 个角色：SafetyGuard、MemoryCurator、Classifier、Retriever、ImpactAnalyst、QAPlanner、OnboardingPlanner、Synthesizer、Harness
- State annotation 新增 `handoffs`（append reducer）、`routeDecisions`（append）、`hitlRequest`、`agentRoster` 四个字段
- `makeTraceStep()` 扩展支持 `agent_role` 参数，9 个节点 trace 全部标注角色
- synthesize 节点构建 `agentRoster`（role→tools 映射），finalPayload 暴露 `agent_roster`、`handoffs`
- harness 报告新增 `agent_roster`、`handoff_count`
- 新增 `scripts/check-multi-agent-roles.js` 静态契约检查

**P2 — Supervisor 动态路由**
- 新增 `ROUTE_RULES` 确定性路由规则表 + `decideNextRoute(state)` 纯函数（基于 trace.length 分阶段路由）
- 新增 `supervisor` 节点：读取 state 决定下一跳，追加 `routeDecisions` 和 `handoffs`
- 图结构改为 `START → supervisor → (conditional edges) → 9 nodes → supervisor → END`
- 环境变量 `AGENT_GRAPH_MODE=supervisor`（默认）/ `linear`（一键回退原线性图）
- 预算 `AGENT_MAX_STEPS` 从 9 调整到 14（覆盖 supervisor 路由开销）
- 新增 `scripts/check-supervisor-routing.js`

**P3 — Human-in-the-Loop 审核**
- `human_review` 节点：`AGENT_HITL_ENABLED=true` 时，高风险变更（riskLevel=high）暂停到人工审核
- `synthesize` 节点产生暂停/批准/拒绝三种 finalPayload（含 `hitl` 字段）
- `/api/langgraph-resume` 新增 `decision` 参数（approve/reject），注入到 graph input
- `decideNextRoute` 支持 post-human_review 路由分支
- 新增 `scripts/check-hitl-resume.js`

**P4 — 前端协同视图**
- `public/app.js` 新增：HITL 审核卡片（批准/拒绝按钮 + `handleHitlDecision` 交互）、Agent Roster 面板、Agent Handoff 流转链、trace agent_role 徽章
- `public/styles.css` 新增 `.hitl-card`、`.agent-roster`、`.agent-handoff`、`.agent-role-badge` 样式

**计划书**
- 新增 `docs/MULTI_AGENT_PLAN.md`：完整的多 Agent 协同计划书（架构设计、角色分工、通信机制、演示场景、评估指标、风险回退）
- `docs/PRD.md` V0.3 小节添加引用链接

### P1 安全修复

根据外部代码审查报告，修复 4 个安全问题：
1. `.gitignore` 补全：遗漏了 `memory.sqlite`、`-wal`、`-shm`、`.sqlite.bak`、`.corrupt-*`
2. ZIP 炸弹防护：`parseZip` 中 `zlib.inflateRawSync` 添加 `maxOutputLength`
3. 认证读取权限收紧：新增 `auth:read` scope
4. 项目级租户隔离：`createProject` 添加 `ownerId`，API 按用户过滤

### 生产就绪完善（a645682）

**P0 运维基础设施**
- CORS 配置（`sendJson` + `serveStatic` + `OPTIONS` preflight）
- 优雅关闭（SIGTERM/SIGINT 处理器，10s 连接排空 + store flush）
- Rate limit（令牌桶 120 req/min，localhost 免限，`RATE_LIMIT_MAX=0` 禁用）
- 结构化日志（`log(level, msg, extra)` → JSON + ISO 时间戳 + `LOG_LEVEL` 控制）
- Question 长度限制（`MAX_QUESTION_LENGTH=16000`，超出返回 413）
- 健康检查增强（SQLite `SELECT 1` + store 文件可读写 + readiness probe）
- `Dockerfile`（node:24-alpine，非 root 用户，HEALTHCHECK）

**P0 文档同步**
- `MULTI_AGENT_PLAN.md` 状态更新为 P1-P4 已实现
- `AGENT_RUNTIME_ARCHITECTURE.md` Non-Goals 移除 supervisor/HITL；Graph Nodes 补充 supervisor 路由图
- `HANDOVER.md` 新增「已实现的超越版本」小节
- `PRD.md` V0.3 标记 ✅ 已实现
- `USER_GUIDE.md` Agent Tab 重写为 7 Agent Supervisor 协同
- `README.md` 新增 7 个环境变量 + Docker 部署说明

**P1 前端增强**
- 错误重试机制（`showError(error, retryFn)` + `error-banner` 内联提示）

### CI 修复（7337393）

`check-architecture-docs.js` 术语同步：USER_GUIDE.md 重写后旧术语不再存在，更新 `requiredUserGuideTerms` 和 `staleUserGuideTerms`。

---

## 2026-07-07 — 运维文档 + 认证 UI + Checkpoint 续跑

| 提交 | 内容 |
|---|---|
| `4c853c4` | 新增 `docs/OPERATIONS.md` 运维指南 |
| `4b4fd63` | 认证管理 UI（用户列表、token 创建、禁用、审计事件） |
| `41bc3a1` | 可执行 LangGraph checkpoint 续跑：从持久化 MemorySaver payload 克隆状态，支持从历史 checkpoint 边界继续执行 |

---

## 2026-07-06 — SQLite 记忆 + 认证 + 向量检索 + Checkpoint 审计

本轮是记忆系统和认证边界的重大升级，共 24 个提交。

### SQLite 长期记忆

| 提交 | 内容 |
|---|---|
| `8649668` | 新增 SQLite 长期记忆存储（`memory_items` 表 + FTS5 + 本地 hash 向量） |
| `1219b18` | 运行时契约与 SQLite 记忆对齐 |
| `88b1881` | 长期记忆检查过滤器（status/type/query/limit） |
| `6febf55` | 记忆压缩：确认的标量偏好自动标记旧值为 `superseded`，生成 `preference_summary` |
| `46479a0` | 用户级记忆隔离（`userId` scope） |
| `0170d11` | 本地向量记忆检索（`local-hash-v1` 64 维 embedding） |
| `ead626d` | SQLite schema migration 审计（`schema_migrations` 表） |

### 认证边界

| 提交 | 内容 |
|---|---|
| `8d6ba40` | 可选令牌认证（`AI_PM_AUTH_REQUIRED` + `AI_PM_USER_TOKENS`） |
| `3a82131` | Token scope 授权（`project:read/write`、`memory:write`、`answer:write`） |
| `68fe4d9` | 认证用户审计端点（`/api/auth/users`、`/api/auth/events`） |
| `c43ffd9` | 认证审计事件记录 |
| `775e62b` | Store-backed 认证用户（本地 token SHA-256 哈希存储） |
| `61460c4` | 受保护的内存数据库恢复（SHA-256 校验 + `confirm: "RESTORE_MEMORY_DATABASE"`） |

### 外部 Embedding + 向量库

| 提交 | 内容 |
|---|---|
| `37f67c1` | 可选外部 memory embeddings（`MEMORY_EMBEDDING_PROVIDER=openai`） |
| `3876aa0` | 外部向量索引适配器（HTTP 兼容） |
| `7f04262` | Qdrant 向量库适配器 |
| `745f0ff` | Pinecone 向量库适配器 |

### LangGraph Checkpoint

| 提交 | 内容 |
|---|---|
| `f80bcf6` | 持久化 LangGraph checkpoint 摘要到 SQLite |
| `e743214` | Checkpoint 检查 API（`/api/langgraph-checkpoint`） |
| `bff9725` | Checkpoint replay 审计（`/api/langgraph-replay`） |
| `a1799ed` | Checkpoint resume 执行（`/api/langgraph-resume`） |

### 数据库运维

| 提交 | 内容 |
|---|---|
| `9999189` | 记忆数据库状态和备份 API（`/api/memory/status`、`/api/memory/backup`） |
| `dec60fe` | 备份目录和恢复计划（`/api/memory/backups`、`/api/memory/restore-plan`） |

### 评估

| 提交 | 内容 |
|---|---|
| `2f67068` | Agent 基准评估套件（18 个标准问题） |
| `4c25456` | 扩展基准评估的记忆覆盖 |

### 安全测试

| 提交 | 内容 |
|---|---|
| `c620a54` | 安全策略红队测试（`safety-redteam.js`） |
| `c7dfc77` | 服务端 UI 验收测试（`ui-acceptance.js`） |

---

## 2026-06-23 ~ 06-29 — LangGraph Agent Runtime + 评估可观测性 + 安全护栏

本轮是 Agent 工作流的核心建设期，共 42 个提交。

### LangGraph Agent Runtime

| 提交 | 内容 |
|---|---|
| `50f04e1` | LangGraph agent runtime：9 节点 StateGraph（input_safety → memory → classify → retrieve → expand_context → impact_analysis → qa_plan → guardrails → synthesize）+ MemorySaver checkpoint + 只读工具注册表 |

### Direct Chat Harness

| 提交 | 内容 |
|---|---|
| `4356c55` | Chat harness 记忆和 CI 质量门 |
| `92ef31f` | Direct chat 记忆建议 |
| `f49783e` | Chat guardrail 详情 |
| `80e631c` | Onboarding harness 可观测性 |
| `754380a` | 将已确认记忆应用到 QA 回答 |

### 评估 Dashboard

| 提交 | 内容 |
|---|---|
| `8c383a1` | 评估运行时可观测性指标 |
| `cd8266a` | Dashboard 展示最近 harness runs |
| `1cf4bab` | Dashboard 展示安全事件 |
| `dc16cbd` | Dashboard 展示记忆事件 |
| `9826bf6` | 记忆和安全状态指标 |
| `7798932` | Harness 运行时评估指标 |
| `45b3650` | 工具策略评估指标 |
| `40e65f7` | Harness 预算评估指标 |
| `174b7e5` | Schema 状态评估指标 |
| `54c3fc2` | LLM 使用评估指标 |
| `57fe915` | Trace 工具评估指标 |
| `209de7c` | 引用状态评估指标 |
| `43ad32f` | Feedback 与 harness run 关联 |

### Harness 审计

| 提交 | 内容 |
|---|---|
| `5946d7d` | Harness run 标识符 |
| `d0d5b2b` | 持久化 harness run 快照 |
| `4002c2f` | Harness run 审计 API |
| `e54fd6a` | Dashboard harness 审计查看器 |
| `de6f9a6` | 持久化 harness 诊断快照 |

### AI 安全护栏

| 提交 | 内容 |
|---|---|
| `80229ed` | 输出安全引用检查对齐 |
| `a1bc0af` | 扩展敏感值脱敏 |
| `9be1f54` | 标记系统提示泄露请求 |
| `476ee8d` | 脱敏 Agent 输出 |
| `16e65fe` | 安全风险详情说明 |
| `b3b139c` | 报告输出脱敏元数据 |
| `25ee736` | 输出脱敏指标汇总 |
| `55523ae` | 导入安全审查摘要 |
| `9bcc05f` | 导入安全指标 |

### 记忆审计

| 提交 | 内容 |
|---|---|
| `328e4e3` | 记忆审计事件 |
| `66edb07` | Inspector 展示记忆审计事件 |
| `e7ce53e` | 记忆事件指标汇总 |

### Harness 工程

| 提交 | 内容 |
|---|---|
| `6c11161` | Health check 暴露运行时元数据 |
| `bf66df4` | 验证 harness 超时配置 |
| `b0ca647` | Health check 暴露 LLM 超时 |
| `6ad3b31` | 状态徽章展示 LLM 超时 |
| `1c54c66` | 强制 harness 上下文 token 预算 |
| `9d2aaea` | Agent 工具策略静态检查 |
| `3e54924` | 最近工具策略事件 |

---

## 2026-05-21 — MVP 初始版本

| 提交 | 内容 |
|---|---|
| `a75d561` | **MVP**：RAG + Agent + DeepSeek LLM 集成。本地 ZIP/GitHub 仓库导入 → 代码块检索 → Q&A / Impact / Onboarding → 反馈 + Dashboard |
| `3f26bf4` | UI redesign v2：现代设计系统、配色、渐变、过渡动画 |
| `b18fe2c` | 修复 workflow 卡片可点击 + 新增 `USER_GUIDE.md` |

### MVP 技术栈
- 后端：Node.js 原生 `http` 模块（零 Web 框架），端口 3000
- 前端：原生 JavaScript SPA（`public/app.js` + `index.html` + `styles.css`）
- AI：OpenAI 兼容协议（推荐 DeepSeek），无 key 时确定性回退
- 数据：`data/store.json`（原子写入 + 损坏备份）
- 依赖：仅 `@langchain/langgraph` 三件套

---

## 技术栈演进总结

| 维度 | 2026-05 MVP | 2026-06 Agent Runtime | 2026-07 SQLite + Auth | 2026-08 多 Agent |
|---|---|---|---|---|
| Agent | 无 LangGraph | 9 节点线性 StateGraph | + checkpoint 续跑 | Supervisor 动态路由 + HITL |
| 记忆 | store.json 偏好 | + 记忆建议 | SQLite + FTS5 + 向量 | 不变 |
| 认证 | 无 | 无 | Token + scope + 审计 | 不变 |
| 安全 | 基础输入检查 | 4 层安全扫描 | + 红队测试 | 不变 |
| 评估 | 基础反馈 | 13 类指标 | + 基准评估 | + handoff_count |
| 运维 | console.log | + harness 审计 | + 备份恢复 | + CORS/rate-limit/Docker/日志 |
| 测试 | 无 | smoke + static | + UI/safety/auth/embedding | + 3 个 multi-agent check |
| 文档 | README | + PRD/USER_GUIDE | + ARCH/HANDOVER/OPS | + MULTI_AGENT_PLAN |
