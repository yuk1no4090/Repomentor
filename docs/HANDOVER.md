# AI-PM 项目交接文档

更新时间：2026-08-07

> **快照说明**：本文档定格在 `41bc3a1`（2026-08-07）交接时点，记录的是当时的仓库状态、决策脉络与验证结果，此后未做整体重写。仓库自那之后持续演进（多 Agent 协同、server.js 模块化拆分至 `lib/` 12 个模块、store/SQLite 性能改造、`test/` node:test 单元测试等），当前实际状态截至 `20c6d98`。查看最新代码组织和逐波次改动请分别参考 [docs/AGENT_RUNTIME_ARCHITECTURE.md](AGENT_RUNTIME_ARCHITECTURE.md) 的「Code Organization」小节与 [docs/CHANGELOG.md](CHANGELOG.md)；本文余下内容仅作历史背景参考，不代表当前代码结构。

## 文档目的

本文用于交接当前仓库已完成的工作，汇总对话中的目标和决策、已实现能力、关键架构、验证状态、明确边界及建议的后续工作。它是对话内容的完整摘要，不是逐字聊天记录；不会记录密钥、本地令牌或具体用户记忆内容。

## 对话与决策脉络

本轮工作按以下顺序推进：

1. 将 `yuk1no4090/AI-PM.git` 拉取到共享工作区并阅读代码仓库。
2. 讨论给项目加入 LangGraph 多 Agent 编排的可行性，并确定要同时补齐记忆、Harness engineering 与 AI 安全。
3. 确认升级方案：保留既有产品 API 和 UI 主体；对影响分析接入真实 LangGraph 图；第一版记忆做用户偏好；用统一运行时封装模型、工具、预算、trace 和回退；做应用级安全护栏，不宣称合规认证。
4. 讨论长期记忆是否需要数据库。结论是有必要，但第一版优先选择 SQLite + 用户确认的偏好记忆，而不是立即引入数据库服务或让模型无确认自动写入记忆。这样可以解释、审计和删除。
5. 参考同类 Agent 的常见分层思路后，向量召回设计为可选能力：SQLite 仍是事实来源，外部向量库仅做镜像和候选召回。
6. 增加可选的令牌认证、用户隔离和审计边界；明确它不是完整账号系统。
7. LangGraph checkpoint 先用于审计与只读回放，后升级为保存脱敏的 `MemorySaver` payload，从而支持兼容 checkpoint 的实际图续跑。
8. 补充文档、自动化测试、GitHub 同步及 CI 验证。

原始的 LangGraph + 记忆 + Harness + AI 安全升级范围已完成。本文最后列出的事项均是下一阶段可选扩展，不属于遗留未完成项。

## 仓库快照

| 项目 | 状态 |
| --- | --- |
| 仓库 | `yuk1no4090/AI-PM` |
| 分支 | `main` |
| 本次交接前最新提交 | `41bc3a1 Add executable LangGraph checkpoint resume` |
| 交接时工作区 | 干净，且已与 `origin/main` 同步 |
| 运行时 | Node.js 24 或更高版本 |
| 包管理器 | npm 10 |
| 最近一次 GitHub Actions | 成功，run `28834402874` |
| CI 链接 | https://github.com/yuk1no4090/AI-PM/actions/runs/28834402874 |

## 产品基线

AI-PM 是一个代码仓库导览与分析 MVP，目前主要能力包括：

- 导入内置示例仓库、公开 GitHub 仓库或 ZIP；
- 查看项目概览、目录树、推断技术栈、核心模块和建议阅读文件；
- 通过 `/api/chat` 进行代码仓库问答；
- 通过 `/api/agent-impact` 做结构化影响分析；
- 生成按角色区分的 onboarding 计划；
- 收集反馈并输出质量评估指标；
- 在既有 UI 中查看 Agent trace、Harness、记忆、安全与审计信息。

主要服务端实现为 [server.js](D:\AI PM\server.js)，前端在 [public](D:\AI PM\public)，检查和测试脚本在 [scripts](D:\AI PM\scripts)。

## 已实现架构

### LangGraph 多 Agent 工作流

`POST /api/agent-impact` 使用 LangGraph `StateGraph`，按固定节点顺序运行：

```text
input_safety
  -> memory
  -> classify
  -> retrieve
  -> expand_context
  -> impact_analysis
  -> qa_plan
  -> guardrails
  -> synthesize
```

每个节点都会写入 trace 元数据。图采用 deterministic-first 策略：没有 API key 时仍可运行确定性的本地检索/分析；配置 OpenAI-compatible 模型后，由共享模型适配器做增强。因此本地开发和演示不会因模型配置缺失而不可用。

`/api/chat` 与 `/api/onboarding` 没有强行改为 LangGraph 图，而是使用较轻的 Harness。它们复用相同的模型适配、记忆报告、schema 校验、安全结构、工具策略、trace 字段与确定性回退，保持原有接口兼容。

### Harness Engineering 运行时边界

`server.js` 内的运行时封装负责：

- `modelAdapter`：OpenAI-compatible chat completion、超时、上下文预算、响应/schema 校验和确定性回退；
- `toolRegistry`：仓库检索、上下文扩展、引用校验和安全扫描；
- `agentHarness`：run id、节点 trace、耗时、模型模式/提供方、模型调用状态、token/上下文预算、schema 状态、回退原因、只读工具策略和错误；
- 持久化 Harness 快照：用于 evaluation 和 `GET /api/harness-run` 的单次运行审计。

Agent 的工具权限是刻意收紧的：

```json
{
  "mode": "read-only",
  "allow_external_network": false,
  "allow_repository_writes": false,
  "allow_shell_execution": false
}
```

因此 Agent 工作流不会修改仓库、执行 shell 命令或自行发起外部网络请求。

### 记忆设计

第一版记忆是“用户偏好记忆”，支持字段：

- `role`
- `language`
- `detailLevel`
- `focusAreas`
- `taskTypes`

系统可以依据使用行为提出偏好建议，例如中文优先、产品经理视角、回答简洁、更多关注风险和测试。但建议默认不会写入长期记忆，只有用户确认后才会持久化。

确认后的偏好存放在两处：

- `data/store.json`：运行时 JSON 状态、偏好、待确认建议、记忆事件、Harness run 和本地认证元数据；
- SQLite 数据库，路径由 `MEMORY_DB_PATH` 指定，默认 `data/memory.sqlite`：`memory_items`、embedding、可用时的 FTS、schema migration 审计、LangGraph checkpoint 摘要和可执行 checkpoint payload。

记忆按 `userId` 隔离；未显式提供时按 `local-user` 处理，以保持本地和历史 API 的兼容。建议同时带有 `projectId`，确认与遗忘时会校验用户和项目归属。用户可忽略建议、遗忘单个偏好或清空全部偏好。遗忘的长期记忆会标记状态，不再作为 active 记忆使用。

对于 `role`、`language`、`detailLevel` 这类标量偏好，系统会把旧冲突值标记为 `superseded`，并维护一条压缩后的 preference summary，避免长期召回到互相矛盾、无限累积的偏好。

默认向量召回采用确定性的本地 `local-hash-v1` embedding。可配置 OpenAI-compatible embedding 服务。外部向量索引支持通用 HTTP、Qdrant、Pinecone；它们只提供候选召回，SQLite 始终负责最终的用户、项目和状态过滤，是事实来源。

记忆相关接口：

| 方法 | 接口 | 用途 |
| --- | --- | --- |
| `GET` | `/api/memory` | 查看偏好、建议、事件和可筛选的长期记忆。 |
| `POST` | `/api/memory/confirm` | 确认待确认建议并持久化。 |
| `POST` | `/api/memory/forget` | 忽略建议，或遗忘一个/全部偏好。 |
| `GET` | `/api/memory/status` | 查看数据库健康状态，不返回具体记忆内容。 |
| `POST` | `/api/memory/backup` | 创建 SQLite 记忆备份。 |
| `GET` | `/api/memory/backups` | 列出备份文件。 |
| `POST` | `/api/memory/restore-plan` | 校验备份并返回不修改数据的回滚计划。 |
| `POST` | `/api/memory/restore` | 在 checksum 和明确确认后恢复指定备份。 |

恢复需要精确的备份 checksum 以及 `confirm: "RESTORE_MEMORY_DATABASE"`。执行恢复前会自动创建当前数据库的备份。

### AI 安全边界

实现的是应用级工程护栏，不是合规或认证声明。集中化安全策略由 `GET /api/health` 返回。

覆盖范围：

- 输入层：识别明显 prompt injection、忽略指令请求、system/developer prompt 泄露请求、密钥请求和工具越权请求；
- 检索层：仓库文件一律被当作不可信证据，不能变成模型指令；疑似敏感值会在发送到外部模型前被脱敏；
- 输出层：校验引用文件、检测缺失/不成立的引用、标记过度自信，并在存储和返回前脱敏疑似凭据；
- Agent 层：仅允许前述只读工具注册表。

风险结果使用 `passed` 或 `needs_review`，并提供 `risk_types`、`risk_details`、guardrail 结果和输出脱敏信息。evaluation 会统计 guardrail、安全和脱敏数据，但不暴露已脱敏的原始值。

### Checkpoint、回放与续跑

LangGraph 使用 `MemorySaver`。运行时 store 和完整 project 对象不进入图 state，而是由 runtime closure 访问，防止可执行 checkpoint payload 包含完整 JSON store、认证用户或令牌 hash。

系统持久化：

- `langgraph_checkpoints`：紧凑的 checkpoint 摘要；
- `langgraph_checkpoint_payloads`：经过处理的 `MemorySaver` storage/writes 快照。

相关接口：

| 方法 | 接口 | 行为 |
| --- | --- | --- |
| `GET` | `/api/langgraph-checkpoint` | 查看单个 checkpoint 摘要，不执行图。 |
| `GET` | `/api/langgraph-replay` | 返回有序 checkpoint 摘要回放，不调用图、工具或模型。 |
| `POST` | `/api/langgraph-resume` | 可执行 payload 存在时，将 checkpoint 克隆为新 run 并继续执行图。 |

旧 run 没有可执行 payload 时，会明确标记为 `input_snapshot_reexecution`；新的兼容 checkpoint 可标记为 `checkpoint_continuation`。

### 可选认证边界

认证默认关闭。设置 `AI_PM_AUTH_REQUIRED=true` 后，除 `GET /api/health` 外的 API 都需要 bearer/API token。令牌会解析为用户身份、角色、组织 id 和 scopes；请求传入的 user id 必须与认证身份一致。

已实现管理接口：

- `GET /api/auth/me`
- `GET /api/auth/users`
- `POST /api/auth/users`
- `POST /api/auth/users/disable`
- `GET /api/auth/events`

本地用户/令牌保存在 `store.json`。令牌仅存 SHA-256 hash 和短前缀，明文只会在签发时返回一次。认证事件不保存令牌值。前端 Dashboard 已有 `Auth Operations` 面板，顶栏可从浏览器 local storage 读取并发送 API token。

这不是完整账号系统：目前不包含密码登录、OAuth、session cookie、找回密码、MFA 或 IdP 集成。

## API 兼容性

以下既有接口仍保持可用：

- `GET /api/health`
- `GET /api/projects`
- `POST /api/import`
- `POST /api/chat`
- `POST /api/agent-impact`
- `POST /api/onboarding`
- `POST /api/feedback`
- `GET /api/evaluation`

`/api/agent-impact` 保留前端可渲染的原有结构，并增加 `memory_used`、`memory_suggestions`、`harness`、`safety`。`/api/chat` 与 `/api/onboarding` 按自身运行时增加等价的可观测字段。

接口参数、错误码、环境变量和响应约定以 [README.md](D:\AI PM\README.md) 为对外参考；运行时细节以 [docs/AGENT_RUNTIME_ARCHITECTURE.md](D:\AI PM\docs\AGENT_RUNTIME_ARCHITECTURE.md) 为准。

## 前端变化

没有新建大型页面，复用了现有界面：

- Agent Workflow 视图展示 trace、记忆使用/建议、Harness 状态、fallback/budget/schema 和安全状态；
- 记忆建议以小型确认/忽略控件展示；
- Copilot inspector 可查看确认偏好、长期记忆、审计事件，并支持遗忘单项或清空偏好；
- Dashboard 增加安全、记忆确认、fallback、输出脱敏和 Harness 指标；
- Dashboard 的 `Auth Operations` 支持签发/禁用本地用户和查看认证审计，调用方需具有 `auth:write`。

## 关键配置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DATA_DIR` / `STORE_PATH` | `data/store.json` | JSON 运行时 store 路径。 |
| `MEMORY_DB_PATH` | `data/memory.sqlite` | SQLite 长期记忆与 checkpoint 数据库。 |
| `AI_PM_AUTH_REQUIRED` | `false` | 是否要求 API token 认证。 |
| `AI_PM_USER_TOKENS` | 未设置 | 启动期 token 到用户身份的映射。 |
| `OPENAI_API_KEY` | 未设置 | 启用 OpenAI-compatible chat 调用。 |
| `OPENAI_BASE_URL` | `https://api.openai.com` | Chat 提供方 base URL。 |
| `OPENAI_MODEL` | `gpt-4o-mini` | Chat 模型。 |
| `LLM_REQUEST_TIMEOUT_MS` | 运行时默认值 | Chat 请求超时。 |
| `LLM_CONTEXT_TOKEN_BUDGET` | `8000` | 触发回退前的估算上下文上限。 |
| `MEMORY_EMBEDDING_PROVIDER` | 本地 | 设置为 `openai` 时使用远程 embedding。 |
| `OPENAI_EMBEDDING_API_KEY` | Chat API key | Embedding 提供方 key。 |
| `OPENAI_EMBEDDING_BASE_URL` | Chat base URL | Embedding 提供方 base URL。 |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding 模型。 |
| `MEMORY_VECTOR_INDEX_PROVIDER` | 未设置 | `http`、`qdrant` 或 `pinecone`。 |
| `MEMORY_VECTOR_INDEX_URL` | 未设置 | 外部向量服务/index host。 |
| `MEMORY_VECTOR_INDEX_API_KEY` | 未设置 | 外部向量服务凭据。 |
| `MEMORY_VECTOR_INDEX_NAMESPACE` | 按提供方默认 | HTTP namespace、Qdrant collection 或 Pinecone namespace。 |

部署、备份和恢复细节见 [docs/OPERATIONS.md](D:\AI PM\docs\OPERATIONS.md)。

## 交接时的验证状态

在最新实现点已成功执行完整测试：

```powershell
npm.cmd test
```

它包含：

- 静态契约与文档检查；
- import、chat、impact workflow、checkpoint resume 和 API 兼容性的 smoke test；
- UI acceptance；
- 安全 red-team；
- 记忆压缩；
- 用户记忆隔离；
- 认证边界；
- embedding provider；
- Agent benchmark。

本次新增文档后，`npm.cmd run test:static` 已再次通过。提交 `41bc3a1` 对应的 GitHub Actions 也成功完成：https://github.com/yuk1no4090/AI-PM/actions/runs/28834402874。

## 关键提交

| 提交 | 说明 |
| --- | --- |
| `41bc3a1` | Add executable LangGraph checkpoint resume |
| `4b4fd63` | Add auth operations UI |
| `4c853c4` | Add operations guide |
| `775e62b` | Add store backed auth users |
| `61460c4` | Add guarded memory database restore |
| `c43ffd9` | Add auth audit events |
| `4c25456` | Expand agent benchmark memory coverage |
| `745f0ff` | Add Pinecone memory vector adapter |
| `7f04262` | Add Qdrant memory vector adapter |
| `a1799ed` | Add LangGraph checkpoint resume execution |
| `3876aa0` | Add external memory vector index adapter |

## 已有文档

- [README.md](D:\AI PM\README.md)：安装、产品概览、API 表、配置和特性清单。
- [docs/PRD.md](D:\AI PM\docs\PRD.md)：产品需求与 MVP 背景。
- [docs/USER_GUIDE.md](D:\AI PM\docs\USER_GUIDE.md)：用户工作流说明。
- [docs/AGENT_RUNTIME_ARCHITECTURE.md](D:\AI PM\docs\AGENT_RUNTIME_ARCHITECTURE.md)：运行时、记忆、安全、认证和 checkpoint 的详细设计。
- [docs/OPERATIONS.md](D:\AI PM\docs\OPERATIONS.md)：运行配置、备份恢复、认证和故障处理。

## 当前限制与刻意不做的范围

以下能力没有实现，属于明确的第一版边界：

- PostgreSQL/pgvector 部署；当前以 SQLite 为本地事实来源。
- LangSmith 或分布式 checkpoint 存储。
- 未经用户确认自动写入的长期语义记忆。
- 完整账号生命周期：密码、OAuth、session、MFA、用户自服务。
- 合规认证，或"护栏消除 AI 风险"的表述。
- Agent 自动改代码、执行 shell 或使用外部网络工具。

### 已实现的超越版本（2026-08-07）

以下能力原列在第一版边界之外，现已实现：
- **Supervisor 动态路由**：`AGENT_GRAPH_MODE=supervisor`（默认），`decideNextRoute()` 确定性规则表驱动，`addConditionalEdges` 实现动态编排。`AGENT_GRAPH_MODE=linear` 一键回退。
- **Human-in-the-Loop 审核**：`AGENT_HITL_ENABLED=true` 时高风险变更暂停到 `human_review` 节点，通过 `POST /api/langgraph-resume` 提交 approve/reject 决策。

## 下一阶段建议

根据实际部署目标选择，不是当前 MVP 运行的前置条件：

1. 生产数据层：若需要多实例部署、大量记忆、集中备份或高并发写入，再迁移到 PostgreSQL + pgvector。此项会增加基础设施、依赖、迁移和运维复杂度，实施前应单独确认。
2. 完整身份体系：若面向真实团队用户，应接入 IdP 或建设 session/password/OAuth 流程；服务到服务访问仍保留 token-scoped 授权。
3. 可观测性：先确定生产数据可发送范围、保留周期和隐私政策，再接入集中日志、指标和可选的 LangSmith 类 trace 系统。
4. 评测体系：建立带期望引用、风险标签和人工质量评分的仓库/问题基准集，并在 CI 中跟踪回归。
5. 安全加固：增加依赖扫描、限流；若引入 session，再加 CSRF/session 防护；同时补充外部审计日志和数据保留策略。
6. Agent 扩展：只有在先定义细粒度工具权限、审批 UX、sandbox 和测试后，再考虑 supervisor 路由或工具执行。

## 给下一位维护者的检查清单

1. 依次阅读 [README.md](D:\AI PM\README.md)、[docs/AGENT_RUNTIME_ARCHITECTURE.md](D:\AI PM\docs\AGENT_RUNTIME_ARCHITECTURE.md)、[docs/OPERATIONS.md](D:\AI PM\docs\OPERATIONS.md) 和本文。
2. 安装 Node.js 24+，运行 `npm install`。
3. 修改运行时前先执行 `npm.cmd test`。
4. 本地以 `npm.cmd run dev` 启动；未配置 API 凭据时会进入确定性 offline retrieval 模式。
5. 测试隔离时，给 `DATA_DIR`、`STORE_PATH`、`MEMORY_DB_PATH` 指定临时路径。
6. 即便配置远端向量索引，也要把 SQLite 视为事实来源。
7. 不要在没有独立 threat model 和验收测试的情况下放宽 Agent 的只读工具策略。
8. 不要把明文 token、原始密钥，或未脱敏的模型/仓库敏感内容写入日志、trace 或测试 fixture。
9. 在推进数据库迁移或完整身份系统前，先确认部署环境、预计用户/流量、数据驻留、备份、RPO/RTO 和运维责任人。

## 参考依据说明

方案方向参考了 LangGraph 的 workflow/stateful orchestration 模型、OWASP LLM 应用风险中与 prompt injection、敏感信息泄露、过度代理相关的内容，以及 NIST AI RMF 的风险管理思路。项目实现仍以本仓库代码和测试为边界，不宣称获得这些组织的正式遵循认证。

