# 开发日志 (CHANGELOG)

> 本文件记录 AI Developer Onboarding Copilot 项目的开发历程。
> 仓库：`yuk1no4090/AI-PM`，分支：`main`

---

## 2026-08-12 — 前端 i18n/状态修复 + 领域层拆分完成（server.js → 1213 行）+ 性能改造 + node:test 单元测试

本轮同样由多个 worker agent 在独立分支/worktree 并行完成，逐一经 reviewer 审核通过后合并（`F1`/`F2`/`W2-3a`/`W2-3b`/`W2-4`/`W2-5`），全程 `npm test` 保持全绿。

### F1 — 前端 i18n 补全 + 转义修复 + Enter 提交（651f1ec，merge 2a4df29）

- 补齐 HITL 审批卡片、Agent 角色/交接、导入安全面板等此前"被引用但未定义"的 copy 键（中英双语），修复中文模式下的英文兜底/undefined 显示；Auth Operations 面板、Harness Run Audit 面板、dashboard 混排标题等整块英文硬编码收编进 copy 双语体系。
- 修复 `feedbackBar`/`failureReasons`/`rankedBars` 中未转义的 `data-answer`/`item.count`，补齐 XSS 防护。
- `api()` 增加 content-type 检测与 try/catch，非 JSON 响应抛出带 HTTP 状态码的可读错误，替代原始 `SyntaxError`。
- 问题输入框支持 Enter 提交（Shift+Enter 换行），复用现有按钮点击处理器与 loading 防重入；`workflow-card` 补充 keydown（Enter/Space）键盘可达性。

### F2 — 标签页状态入 state（2128e1e，merge 9ef4ce6）

- `state` 新增 `activeTab`/`draftQuestion`；`switchTab()` 从直接操作 DOM（`innerHTML` 替换 + `classList.toggle`）改为写 state 后调用统一 `render()`，修复整页重渲染时标签页跳回 Q&A 的问题。
- `render()` 开头把当前 `#questionInput` 的值写回 `state.draftQuestion` 再重渲染；`ask()`/`runAgentImpact()` 提交成功后清空输入框，修复重渲染时用户已输入但未提交的内容丢失的问题。

### W2-3a — 领域层拆分一：lib/auth、importer、retrieval、safety（d394c61，merge 23572f3）

- 纯搬移零逻辑改动，从 server.js 抽出四个领域模块：`lib/auth.js`（token/身份解析、认证用户与事件 CRUD、scope 校验）、`lib/importer.js`（仓库导入，单向依赖 `lib/retrieval.js` 与 `lib/safety.js`）、`lib/retrieval.js`（分词/查询扩展/分块/检索）、`lib/safety.js`（输入/检索/输出三级安全扫描与脱敏，`SAFETY_POLICY` 改从 `lib/config.js` 导入）。
- 顺手清理 `lib/safety.js` 中声明后从未使用的死正则，同步 `check-safety-guardrails.js` 里依赖该死代码文本的一条过期期望。
- server.js 4278 → 3186 行；路由/LLM/answers/agent-graph/metrics 尚未拆分。

### W2-3b — 领域层拆分二：lib/llm、answers、agent-graph、metrics（d6cd778，merge 1b2384f）

- 延续前两阶段模式，纯搬移零逻辑改动。server.js 从 3186 行降至 **1213 行**，只剩 HTTP 路由分发（`handleApi`/`handleApiUnlocked`/`serveStatic`）+ 少量仍与路由强耦合的辅助函数（`sendJson`/`readBody`/`findHarnessRunAudit`）+ bootstrap（`setStoreRecordNormalizers`/`setCheckpointCollaborators` 接线、`http.createServer`、优雅关机）。
- 新增 `lib/llm.js`（provider 解析 + `maybeCallOpenAI` + `runModelAdapter`）、`lib/answers.js`（QA/impact/onboarding 确定性答案生成器、偏好增删查、记忆建议生成、答案 schema 校验）、`lib/agent-graph.js`（路由决策 `decideNextRoute`、trace/工具注册表辅助、harness 报告构造器、`StateGraph` 节点定义、`runAgenticImpactWorkflow`）、`lib/metrics.js`（`computeMetrics` + `FEEDBACK_TYPES`）。
- 依赖方向确认单向无环：`agent-graph` → `llm`/`answers`/`retrieval`/`safety`/`memory-db`/`checkpoints`；`answers` → `memory-db`（仅 `normalizeMemorySuggestion`）；`metrics` → `agent-graph`（复用 `createHarnessRunSnapshot`）+ `memory-db`/`checkpoints`/`safety`；`llm` 只依赖 `config`/`safety`。
- 搬移过程用脚本对全部约 55 个搬移片段与原 server.js 做逐字节比对确认零逻辑改动；`node --check` 通过 server.js 与全部 `lib/*.js`，`npm test` 全绿。

### W2-4 — 性能改造：store 常驻内存缓存 + SQLite 事务化 + FTS 条件重建（5ee8fc1，merge 57c99d8）

- `lib/store.js`：`ensureStore()` 缓存已解析的 store 实例，用 `fs.stat` 的 mtime+size 签名判断磁盘文件是否被外部改动，未变化时跳过整份 read+JSON.parse+normalizeStore；`saveStore()` 写盘后直接刷新缓存，避免同进程内"写完自己再读一遍"。24MB 量级 `store.json` 下 `ensureStore()` 稳态耗时从 ~56ms/次降到 ~0.4ms/次（约 140 倍读加速）。新增 `flushStore()` 由 `gracefulShutdown()` 调用以等待关机时可能仍在途的写入；未采用字面意义的定时防抖落盘——`scripts/smoke-test.js` 会在子进程运行期间从测试进程直接改写 `store.json` 并期望下一次请求立刻感知，落盘时机改为异步会破坏这一跨进程契约。
- `lib/memory-db.js`/`lib/checkpoints.js`：新增 `getCachedStatement()`/`runInSqliteTransaction()`，检索路径批量 `UPDATE` 复用单条 prepared statement；多行写操作包进 `BEGIN`/`COMMIT`（异常 `ROLLBACK`）；语句缓存随 `closeMemoryDatabase()` 一起失效。
- `lib/memory-db.js`：FTS 索引启动时按需重建（表不存在或行数与 `memory_items` 不一致才 `DROP`+`CREATE`+rebuild），`/api/memory/status` 改用 `fs.statSync` 取 DB 文件大小而非整份 `readFileSync`。
- `lib/config.js`：`rateBuckets` 清理改为每 1000 次请求确定性触发一次（原为概率触发）。
- `lib/agent-graph.js`：LangGraph 回退路径对同一 query 的 `retrieveChunks` 只调用一次，结果复用于 fallback 摘要与 `related_files`。
- reviewer 通过，附带 2 项非阻塞跟进（见下方「已知跟进项」）。

### W2-5 — node:test 纯函数单测，41 例，删除 simulateRoute 镜像副本（9c96fa8，merge 20c6d98）

- 新增 `test/{routing,safety,retrieval}.test.js`，直接从 `lib/agent-graph.js`、`lib/safety.js`、`lib/retrieval.js` 导入真函数做单测（`node:test` 内置运行器，零新增依赖）。`routing.test.js` 移植 `check-routing-unit-test.js` 原 13 条 `simulateRoute` 用例并补 5 条边界用例；`decideNextRoute` 依赖进程启动时按环境变量固化的 `AGENT_HITL_ENABLED` 常量，HITL-enabled 分支通过子进程注入环境变量后调用真函数验证。
- 新增 `scripts/check-unit-tests.js`，spawn `node --test test/**/*.js` 按子进程退出码产出 `{ ok }`，被 `static-checks.js` 的 `readdir` 自动发现纳入 check 脚本清单（24 → 25 个），无需改动 `package.json`。
- 改造 `check-routing-unit-test.js`：删除 `simulateRoute` 镜像副本及其用例执行逻辑，改为直接 import 真实 `decideNextRoute`/`ROUTE_RULES` 做存在性与结构断言，并对 `test/routing.test.js` 做覆盖回归防护（缺失任一原始场景描述则报错），避免与 `check-unit-tests.js` 重复执行同一组用例。
- `lib/agent-graph.js` 追加 `ROUTE_RULES` 具名导出（仅导出列表变更，函数体未改）供测试与 check 脚本直接引用真实路由表。

### 已知跟进项（非阻塞）

- **store 缓存签名的时钟粒度盲区**：`lib/store.js` 的常驻缓存用 `fs.stat` 的 mtime+size 判断磁盘文件是否被外部改动；如果外部进程用完全相同字节数覆写 `store.json`，且覆写发生在文件系统 mtime 分辨率粒度之内（Windows 实测存在这一窗口），签名可能保持不变，导致 `ensureStore()` 继续返回缓存中的旧内容而不是重新读盘。
- **`AUTH_REQUIRED=false` 时 GET 不走写锁，可能读到共享内存中间态**：Wave1-C 把写锁范围收窄为"非 GET 一律走锁，GET 仅在 `AUTH_REQUIRED` 且路径不是 `/api/health` 时走锁"。默认的 `AUTH_REQUIRED=false` 下 GET 请求不入队，如果与一次跨多个 `await` 边界的并发 POST 写请求重叠，理论上可能读到 store 常驻内存对象处于该次写入的部分修改中间态，而不是写入前或写入后的完整快照。

---

## 2026-08-11 — 前端确定性 bug 修复 + 工程化清理 + server.js 正确性热修 + 存储基础层拆分 + 样式清理

本轮由多个 worker agent 在独立分支/worktree 并行完成，逐一经 reviewer 审核通过后合并（`Wave1-A`/`Wave1-B`/`Wave1-C`/`W2-1`/`W2-2`/`F3`），全程 `npm test` 保持全绿。

### 前端 5 个确定性 bug 修复（39f8335，Wave1-A）

- Retry 按钮：先取出 `retryFn` 局部变量再 `clearError()`，避免读取已置空的 `state.errorBanner`。
- `runAgentImpact` 失败重试改为调用 `runAgentImpact(question)`，不再引用未定义的 `kind`。
- HITL 审批/驳回后更新原消息 `payload.hitl` 为已决策状态，避免全量 render 时按钮复活；`state.messages.push` 统一改为 `unshift`。
- `renderAgentImpactMessage` 中移除重复的 `renderOptionalRuntimeStatus(payload)` 调用，运行时状态卡片只渲染一次。
- 接入 `state.loading`：`import`/`ask`/`runAgentImpact` 入口加防重入守卫，对应提交按钮渲染时按 `loading` 置 `disabled`，完成/失败后在 `finally` 中复位并重渲染。

### 工程化清理（53f64d2，Wave1-B）

- 新增 `.dockerignore`，排除 `node_modules`/`.git`/`data`/`nocode`/`scripts`/`docs` 等，避免 55MB `node_modules` 及含用户数据的 `data/memory.sqlite` 进入构建上下文。
- `Dockerfile`：`HEALTHCHECK` 改用 shell 形式 `${PORT:-3000}` 而非硬编码 `3000`；移除生产镜像里不需要的 `COPY scripts/`。
- CI：`test.yml` 按 `ref` 加 `concurrency` 分组 + `cancel-in-progress`，避免同一 PR 连续 push 堆积运行。
- `README.md` 测试命令代码块补齐遗漏的 `npm run test:smoke`。
- 删除初始提交遗留的 Vite+React 原型 `nocode/`（84 个文件，提交共 −8930 行，零引用零改动），同步清理 `docs/MULTI_AGENT_PLAN.md` 与 `docs/USER_GUIDE.md` 中指向该目录的文字。

### server.js 四处正确性热修（0efc2e2 + d4abe97，Wave1-C）

- `loadEnvFile` 移至文件最顶部（imports 之后、任何读 `process.env` 的常量之前），修复 `.env` 中 `PORT`/`HOST`/`AUTH_REQUIRED`/`RATE_LIMIT_MAX`/`LLM_REQUEST_TIMEOUT_MS` 等配置此前因加载时机太晚而静默失效的问题（含鉴权开关，属安全问题）。
- `ensureStore` 收窄灾难恢复范围：仅 `ENOENT` 视为新建；`SyntaxError` 时先 `backupCorruptStore` 再重建；其余错误（如 Windows 瞬时 `EBUSY`/`EPERM`）直接向上抛出，不再用空 seed 静默覆盖磁盘上的真实数据。
- 删除优雅关机中引用未定义全局变量 `store` 的死代码（`await saveStore(store)`），该行必抛 `ReferenceError` 并被 catch 吞掉，原本没有实际效果。
- 写锁范围修复分两步：先让 `handleApi` 统一所有方法（含 GET）都经过 `withWriteLock`，修复 `AUTH_REQUIRED` 下 GET 路径的 `recordAuthEvent`+`saveStore` 与写锁内 POST 的 load-modify-save 并发互相覆盖丢数据的问题；reviewer 指出无差别加锁会让 `/api/health` 与并发 agent 请求（单次可持锁 30s+）抢同一把 FIFO 锁、拖慢 Dockerfile 的 5s 超时健康检查，随后收窄为：非 GET 一律走锁，GET 仅在 `AUTH_REQUIRED && pathname !== "/api/health"` 时走锁，其余 GET（含 `/api/health`）不入队直接处理。

### 其他 chore

- `.gitattributes`（ada821a）：强制 `*.js`/`*.md`/`*.css`/`*.html`/`*.json`/`*.yml` 以 LF 检出，修复 worktree 下 CRLF 导致部分 `\n` 锚定正则误判的静态检查误报。
- `.gitignore`（036ed87）：忽略 `.claude/` 本地 worktree 目录。

### 测试脚本读源解耦（f542025，merge ceff627，W2-1）

- 新增 `scripts/shared/source-reader.js` 作为读取后端/前端源码的统一入口：`readServerSource()` 拼接 `server.js` + `lib/**/*.js`（目录不存在则跳过，按路径排序），`readFrontendSource()` 读取 `public/app.js`；两者都会把 CRLF 归一化为 LF。
- 18 个原先直接 `readFile("server.js"/"public/app.js")` 的 `check-*.js` 改为调用上述函数，断言内容不变，只换数据源，为 server.js 模块化拆分铺路。
- 裁剪 3 处已确认的脆性断言：`check-smoke-reliability.js` 删除对 `const REQUEST_TIMEOUT_MS = 20_000` 精确数值的断言，改为宽松正则确认"存在显式数字超时常量"；`check-langgraph-checkpoints.js` 的 `.compile({ checkpointer })` 与 `check-frontend-agent-ui.js` 的 `JSON.stringify({ suggestionId, projectId: ... })` 从精确字符串匹配改为容忍空白差异的正则，验证的事实不变。

### 架构拆分——存储基础层（2ac3734，merge cdca7f6，W2-2）

- 纯搬移重构，零逻辑改动，从 `server.js` 抽出 4 个存储基础层模块：`lib/config.js`（环境变量加载 + 全部配置常量 + `apiError`/`normalizeUserId` 两个跨模块共用工具函数）、`lib/store.js`（`ensureStore`/`saveStore`/`normalizeStore`/`backupCorruptStore`/`withWriteLock`，通过 `setStoreRecordNormalizers()` 注入仍留在 `server.js` 的记录归一化函数以避免循环依赖）、`lib/memory-db.js`（SQLite 长期记忆库全部：单例/迁移/FTS/嵌入/向量适配器/CRUD/备份恢复）、`lib/checkpoints.js`（LangGraph checkpoint 序列化/持久化/回放/续跑，通过 `setCheckpointCollaborators()` 注入 `findProject`/`findHarnessRunAudit`/`runAgenticImpactWorkflow`）。
- `server.js` 6029 行 → 4278 行，新增 `lib/` 共 1959 行。评审已通过（reviewer 通过，零阻塞），`npm test` 全绿，无需同步 `scripts/` 期望，因为 `check-*.js` 均已经由 `scripts/shared/source-reader.js` 读取 `server.js` + `lib/**/*.js` 拼接后的源码。

### F3 — styles.css 清理（1267896，merge 37d1622）

- 删除死样式：`.command-center`/`.command-header`/`.status-dot`（旧版预览，已被 `.figma-preview` 取代，直接复用其容器样式）、`.failure-list` 系列六处（JS 无引用，与 `.feedback-log` 合并处理）、`.center`、媒体查询里的孤儿 `.hero`、`.handoff-end`。
- `.progress-box` 非 vertical 布局收窄：grep 确认 `app.js` 仅渲染 `"progress-box vertical"`，但基础规则里的 `display: grid` 是 `.vertical` 变体的必需属性，不能整体删除；仅移除恒被覆盖的 `grid-template-columns`/`gap`，并清掉 600px 媒体查询里恒不匹配的 `.progress-box:not(.vertical)`。
- 补齐 JS 在用但 CSS 缺失的类：`.agent-welcome`/`.agent-avatar`/`.suggestion-grid`（聊天空状态）、`.figma-preview`（沿用原 `.command-center` 容器样式）。
- 语义色收敛：新增 `--success-text`/`--success-border`/`--warn-text`/`--warn-border` 变量，替换 `.llm-badge`/`.llm-source`/`.risk`/`.agent-header`/`.guardrail-list` 中 5 处 `#15803d` 与 4 处 `#92400e` 硬编码。

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
