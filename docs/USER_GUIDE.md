# AI Developer Onboarding Copilot — 使用手册

## 快速开始

```bash
npm run dev
# 浏览器打开 http://localhost:3000
```

首次启动会自动加载 `.env` 中的 LLM 配置（如果存在），否则以离线检索模式运行。

---

## 页面导航

共 5 个页面，顶部导航栏可切换。Landing 页的 5 个流程卡片也可点击跳转。

### 1. Product（产品首页）

**用途**：向面试官/用户展示产品价值主张和完整工作流。

| 元素 | 功能 |
|---|---|
| **Launch sample workspace** | 一键导入内置示例仓库（Commerce API），跳转到 Overview |
| **Import repository** | 跳转到导入页 |
| **5 个流程卡片** | 点击可跳转到对应功能页：Import → Overview → Copilot → Copilot → Dashboard |
| **右侧预览面板** | 静态展示产品 UI 形态 |

### 2. Import（导入仓库）

**用途**：导入代码仓库，生成可检索的项目索引。

**三种导入方式**：

| 方式 | 操作 |
|---|---|
| **Sample Repo** | 点击 "Use Sample Repo" 按钮，使用内置的 Commerce API 示例（11 个文件） |
| **GitHub URL** | 输入公开仓库地址，如 `https://github.com/expressjs/express`，点击 "Analyze Repository" |
| **ZIP 上传** | 拖拽或选择本地 ZIP 文件 |

**导入流程**（右侧面板显示进度）：
1. Uploading → 接收文件
2. Parsing files → 过滤支持的文件类型，排除 node_modules 等目录
3. Creating local retrieval index → 按 70 行/3.5KB 切分 chunks
4. Generating project summary → 推断技术栈、核心模块、推荐阅读
5. Ready → 完成，可进入 Copilot

**支持的文件类型**：`.md` `.txt` `.js` `.ts` `.tsx` `.py` `.java` `.json` `.yaml` `.yml`

### 3. Overview（项目概览）

**用途**：导入后自动生成的项目地图。

| 区块 | 内容 |
|---|---|
| **Repository Summary** | 项目名称、来源标签、README 摘要、文件数/chunk 数/推荐阅读数 |
| **Next Best Actions** | 3 个快捷操作：解释架构 / 查找订单逻辑 / 生成入门路径。点击自动跳转 Copilot 并填入问题 |
| **Core Modules** | 自动检测的业务模块标签 |
| **Directory Structure** | 代码目录树（深色终端风格） |
| **Tech Stack** | 推断的技术栈标签 |
| **Recommended First Reads** | 按相关性排序的优先阅读文件列表 |
| **Evidence Index** | 可检索 chunks 数、文档数、源码文件数统计 |

### 4. Copilot（工作台）

**用途**：核心交互区，4 个 Tab 覆盖 4 种任务。

#### 4.1 Q&A Tab — 代码库问答

**功能**：基于检索到的仓库上下文回答问题。

**使用**：
1. 在输入框输入问题（或点击左侧推荐问题）
2. 点击 "Ask Copilot"
3. 回答包含：答案正文、关键要点、相关文件（带行号）、不确定性评估、建议追问

**LLM 模式标识**：
- 页面顶部绿色 `⚡ AI 增强模式` → 使用 DeepSeek/OpenAI 真实 LLM
- 页面顶部黄色 `📚 离线检索模式` → 使用确定性模板回答（无需 API key）

**反馈**：每条回答底部有 5 个反馈按钮（Helpful / Not helpful / Inaccurate / Missing citation / Too generic），点击后数据进入评估仪表盘。

#### 4.2 Impact Tab — 影响范围分析

**功能**：输入计划改动，分析可能影响的模块和风险。

**使用**：
1. 输入改动描述（如 "新增订单状态 partially_refunded"）
2. 点击 "Analyze Impact"
3. 输出：影响摘要、受影响模块（按 Data Model / API Routes / Business Logic / UI / Tests 分类）、风险等级、测试建议、开放问题

#### 4.3 Agent Tab — 多 Agent 协同工作流

**功能**：展示 Supervisor、ImpactAnalyst、QACritic 三个模型 Agent 与确定性工具节点的协同工作流。默认使用 Supervisor 路由（`AGENT_GRAPH_MODE=supervisor`），可通过环境变量切回线性模式（`AGENT_GRAPH_MODE=linear`）。

**模型 Agent**：Supervisor、ImpactAnalyst、QACritic。三者分别拥有独立 prompt、输出 schema、模型调用记录和确定性 fallback。

**确定性角色/工具节点**：SafetyGuard、MemoryCurator、Classifier、Retriever、OnboardingPlanner、Synthesizer、Harness。它们不因出现在 LangGraph node 中就被定义成独立模型 Agent。

**新特性（2026-08-07）**：
- **Supervisor 路由**：确定性规则表 `ROUTE_RULES` 驱动动态编排，支持 `AGENT_GRAPH_MODE=linear` 一键回退。
- **HITL 审核**：启用 `AGENT_HITL_ENABLED=true` 后，四类信号中任意一个都会暂停到人工审核节点：高风险变更（`riskLevel === "high"`）、Supervisor 自身请求复核（`supervisorPlan.require_human_review`）、输入问题/检索到的仓库内容被安全扫描标记（`inputSafety`/`retrievedSafety` 状态为 `needs_review`），或 QACritic 在有界 revise 环预算用尽后仍返回 `verdict="revise"`（`critic_flag`——流水线即将交付一个 critic 自己仍在拒绝的答案，此时才需要人工介入；若预算未用尽，环路会照常再跑一轮而不会暂停）。通过 `/api/langgraph-resume` 提交 approve/reject 决策；暂停卡片会标明具体是哪个信号触发的（`hitl.reason`/`hitl.triggers`），安全类信号的 `hitl.reason` 还会点名具体的风险类型（如 `"input flagged: prompt_injection"`），`critic_flag` 的 `hitl.reason` 会点名具体轮数（如 `"critic still requested revision after 1 round(s)"`）。approve 只是放行本次执行，不会清除 `safety.status`（仍保持 `needs_review`）；reject 则直接阻断，不返回完整答案。确定性/离线回退路径下，`require_human_review`/`risk_hypothesis`/`riskLevel` 都只是基于问题关键词或文件路径的启发式判断，并非对变更本身的证据化推理。
- **Agent Roster 面板**：页面展示所有 Agent 角色及其工具子集。
- **Handoff 流转链**：可视化 Agent 间的交接路径（sender → recipient）。

**新特性（有界 QACritic revise 环）**：QACritic 复核后如果判定证据不足（`verdict="revise"`），图会回到 Retriever 再做一轮检索（带上 QACritic 自己提出的补充查询），而不是直接进入下一步；轮数由 `AGENT_MAX_REVISION_ROUNDS`（默认 1，设为 `0` 可关闭）限界，用尽预算后无论是否解决都会照常继续输出。这是当前图里唯一的真实环路。

**新特性（节点级 SSE 进度流）**：点击 "Run Agent" 后不再只看到一句静态的 "Running agent workflow..."——前端改用 `POST /api/agent-impact/stream`，随着上面 9 个流程节点逐个完成实时点亮执行轨迹（节点名、Agent 角色、耗时），有界修订轮和 HITL 暂停也会作为独立事件即时显示。任何环节失败（网络错误、浏览器不支持等）都会自动回退到原有的一次性 JSON 接口，最终答案的呈现方式不变。详见 README「`/api/agent-impact/stream`」一节。

**流程**（9 个标称阶段，另有两个可选分支：有界 revise 环与 HITL 暂停）：
1. SafetyGuard — 检查 prompt injection、密钥请求和越权工具意图
2. MemoryCurator — 加载已确认偏好，并生成待确认记忆建议
3. Classifier — 识别改动类型
4. Retriever — 逐查询检索相关 chunks 并扩展依赖上下文
5. ImpactAnalyst — 独立调用 LLM，按仓库证据聚合影响和风险
6. QACritic — 独立调用 LLM，复核引用、遗漏范围和回归测试建议；返回 verdict="revise" 且未超出 `AGENT_MAX_REVISION_ROUNDS`（默认 1）时会回到步骤 4 再走一轮，携带 QACritic 自己提出的补充检索词
7. SafetyGuard — 校验引用、敏感输出、过度自信
8. [human_review] — 仅当风险为 high、Supervisor 的计划请求复核、输入/检索内容被安全标记，或 QACritic 在 revise 预算用尽后仍要求修订，且 `AGENT_HITL_ENABLED=true` 时才会出现，通过 LangGraph 原生 `interrupt()` 真正暂停，approve/reject 均从此处继续到步骤 9
9. Synthesizer — 生成结构化输出

**状态卡**：Agent header 展示 Memory、Harness、Safety 三类状态。Memory 显示已使用偏好和待确认数量；Harness 显示模型模式、步骤数、耗时、fallback、budget、handoff_count；Safety 显示护栏通过或需要复核。技术详情里的 **Model Agent Calls** 分别展示三个模型 Agent 是否使用 LLM、是否 fallback、模型、耗时和 token 估算。未配置 API key 时三个角色都会走确定性 fallback，该次执行不应描述成真实的多模型 Agent 协作。

**面试价值**：展示 Supervisor 动态路由 / Agent 角色分工 / conditional edges / Handoff 机制 / HITL 人在回路 / trace / guardrails / structured output 等 Agent 工程核心理念。

#### 4.4 Onboarding Plan Tab — 入职学习路径

**功能**：按角色和周期生成阅读计划。

**使用**：
1. 选择角色：Backend Engineer / Frontend Engineer / Product Manager / QA
2. 选择周期：3 days / 5 days
3. 点击 "Generate Plan"
4. 输出：每天的学习重点、推荐阅读文件、具体任务

### 5. Evaluation（评估仪表盘）

**用途**：展示 AI 产品核心质量指标。

| 指标 | 含义 |
|---|---|
| Total Questions | 总提问数 |
| Agent Runs | Agent 工作流执行次数 |
| Helpful Rate | 用户标记"有帮助"的比例 |
| Citation Coverage | 回答包含文件引用的比例 |
| Uncertain Answer Rate | AI 明确表示不确定的比例 |
| Negative Feedback Rate | 负反馈比例 |
| High Risk Questions | 涉及高风险改动的问题数 |
| Top Failure Reasons | 负反馈类型分布（含进度条） |
| Recent Feedback | 最近 8 条反馈记录 |
| Product Iteration Signals | 从指标推导的产品改进方向 |

---

## LLM 接入

### 使用 DeepSeek（推荐）

1. 获取 API key：https://platform.deepseek.com
2. 在项目根目录创建 `.env` 文件：
   ```
   OPENAI_API_KEY=sk-your-key
   OPENAI_BASE_URL=https://api.deepseek.com
   OPENAI_MODEL=deepseek-chat
   ```
3. 重启服务：`npm run dev`
4. 验证：`curl http://localhost:3000/api/health`

### 使用 OpenAI

```bash
export OPENAI_API_KEY=sk-your-key
# BASE_URL 和 MODEL 使用默认值即可
npm run dev
```

### 分角色模型选择（可选）

Agent 工作流里的 Supervisor / ImpactAnalyst / QACritic 三个模型驱动角色可以分别指定模型和采样温度，不再必须共用一个全局 `OPENAI_MODEL`：

```bash
export OPENAI_MODEL=gpt-4o-mini            # 未设置角色专属覆盖时的共享默认值
export OPENAI_MODEL_SUPERVISOR=gpt-4o-mini
export OPENAI_MODEL_IMPACT_ANALYST=gpt-4o  # 重度推理角色可以用更强的模型
export OPENAI_MODEL_QA_CRITIC=gpt-4o-mini
# 温度同理：OPENAI_TEMPERATURE / OPENAI_TEMPERATURE_SUPERVISOR /
# OPENAI_TEMPERATURE_IMPACT_ANALYST / OPENAI_TEMPERATURE_QA_CRITIC
```

未设置角色专属变量的角色会回退到 `OPENAI_MODEL`/`OPENAI_TEMPERATURE`，再回退到内置默认值。每次 Agent 调用实际使用的模型可以在 Agent Tab 的 harness 详情（`model_calls[]`）里逐条查看；`harness.model_config` 展示每个角色当前生效的模型/温度及是否使用了角色专属覆盖。本项目不测量任何配置下的成本或延迟（测试全部离线运行），因此这里只是让该权衡变得可配置、可观测，而非给出效果承诺。

### 无 API Key

不设置任何环境变量即可。系统使用确定性检索式回答，功能完整但回答质量较低。UI 会显示"离线检索模式"。

---

## 技术架构

| 层 | 技术 |
|---|---|
| 后端 | Node.js 原生 HTTP + LangGraph Agent Runtime |
| 前端 | 原生 JS + CSS（SPA，无框架） |
| 数据 | JSON 文件存储（`data/store.json`） |
| LLM | OpenAI 兼容 API（DeepSeek / GPT-4o-mini / Groq 等） |
| 检索 | 本地关键词匹配 + 中英文术语扩展 |

## API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | LLM 状态 + 服务运行时间 |
| GET | `/api/auth/me` | 当前请求的认证用户、角色和 scopes |
| GET | `/api/auth/users` | 已配置认证用户审计列表，不返回 token |
| POST | `/api/auth/users` | 创建或更新本地认证用户，并可签发一次性可见 token |
| POST | `/api/auth/users/disable` | 禁用本地认证用户及其 token |
| GET | `/api/auth/events` | 最近认证允许/拒绝审计事件，不返回 token |
| GET | `/api/projects` | 获取所有项目 |
| POST | `/api/import` | 导入仓库（sample / repoUrl / zipBase64） |
| POST | `/api/chat` | 问答 / 影响分析（kind: "qa" / "impact"） |
| POST | `/api/agent-impact` | LangGraph Agent 工作流影响分析，返回 memory / harness / safety 状态 |
| POST | `/api/agent-impact/stream` | 与 `/api/agent-impact` 相同的工作流，以 SSE（Server-Sent Events）逐节点流式返回进度事件（`workflow_started`/`node_completed`/`revise_round_entered`/`hitl_paused`/`final`/`error`），而不是一次性等待最长 30 秒后返回；鉴权同样走 `Authorization` 请求头，不支持 `EventSource`、也不接受 query string 传 token |
| POST | `/api/onboarding` | 生成入职学习计划 |
| POST | `/api/feedback` | 提交回答反馈 |
| GET | `/api/answers` | 按 projectId 返回最近的问答/影响分析/agent-impact/onboarding 历史（配对问题文本 + 反馈），用于刷新后重建对话历史；支持 limit（默认 50，上限 200） |
| GET | `/api/evaluation` | 获取评估指标 |
| GET | `/api/harness-run` | 按 projectId 和 runId 查看单次 harness 执行快照 |
| GET | `/api/langgraph-checkpoint` | 按 projectId、runId 和 checkpointId 查看单个 LangGraph checkpoint 摘要 |
| GET | `/api/langgraph-replay` | 按 projectId 和 runId 查看 LangGraph checkpoint summary replay |
| POST | `/api/langgraph-resume` | 提交 HITL 审批决策（`decision: "approve"`/`"reject"`）；有 checkpoint payload 时通过 LangGraph 原生 `Command({ resume })` 恢复同一次暂停的执行（`native_interrupt_resume`），否则基于输入快照重新执行 Agent Workflow（`input_snapshot_reexecution`） |
| GET | `/api/memory` | 获取已确认偏好和最近记忆建议 |
| GET | `/api/memory/status` | 查看长期记忆 SQLite 数据库健康状态 |
| GET | `/api/memory/backups` | 查看长期记忆 SQLite 备份列表 |
| POST | `/api/memory/backup` | 创建长期记忆 SQLite 备份 |
| POST | `/api/memory/restore-plan` | 校验备份并生成手动恢复计划 |
| POST | `/api/memory/restore` | 使用校验过的备份恢复长期记忆 SQLite 数据库 |
| POST | `/api/memory/confirm` | 确认待保存的记忆建议 |
| POST | `/api/memory/forget` | 忽略建议、清除单项偏好或清空偏好 |

---

## Demo 演示流程（面试用）

**推荐 5 分钟路径**：

1. **打开 Landing 页**（10 秒）→ 展示产品定位
2. **点击 "Launch sample workspace"**（10 秒）→ 自动导入 Sample Repo
3. **Overview 页**（30 秒）→ 展示自动生成的技术栈、模块、推荐阅读
4. **进入 Copilot → Q&A Tab**（1 分钟）→ 问 "Explain the user authentication flow"，展示带引用的 AI 回答
5. **切换到 Impact Tab**（1 分钟）→ 输入 "Add partially_refunded status to orders"，展示影响分析
6. **切换到 Agent Tab**（1 分钟）→ 运行 Agent 工作流，展示 trace、Memory / Harness / Safety 状态和 guardrails
7. **打开 Dashboard**（30 秒）→ 展示真实评估指标，包括 guardrail hits、memory confirmations、fallback runs

### 7.1 自动化验收

- `npm run test:static`：静态契约、文案、依赖、架构文档和前端 UI 结构检查（`scripts/check-*.js`，33 项；其中也包含 `test/` 下 231 条 `node:test` 单元测试的运行）。
- `npm run test:smoke`：后端 API、LangGraph、记忆、harness、安全、评价指标的临时服务回归测试。
- `npm run test:ui`：启动临时服务，拉取真实前端资源，导入 sample workspace，运行 Agent Workflow，并确认 Memory / Harness / Safety / long-term memory / Dashboard / harness audit panel 都有可渲染数据。
- `npm run test:safety` / `test:memory` / `test:user-memory` / `test:auth` / `test:embedding` / `test:benchmark` / `test:mcp`：分别对应安全红队、记忆压缩、用户记忆隔离、认证边界、embedding provider、agent benchmark 和 MCP server 的独立回归测试。
- `npm test`：依次串联以上全部（`test:static` + 9 套运行时黑盒测试套件）。

**关键面试话术**：
- "顶部绿色标识说明当前是 AI 增强模式，我接入了 DeepSeek API"
- "每条回答都有文件引用——这是 RAG 的 citation 机制，降低幻觉"
- "Agent 工作流是 LangGraph 9 节点编排，每步能看到输入输出、引用文件和 guardrail 状态"
- "记忆模块只保存用户确认过的偏好，未确认建议不会写入长期记忆"
- "Harness 统一记录模型模式、步骤预算、耗时、schema 校验和 fallback"
- "Safety 护栏会标记 prompt injection、敏感信息请求、越权工具意图和无效引用"
- "评估仪表盘有真实数据——83% helpful rate、86% citation coverage、14% uncertain rate"
