# AGENTS.md

本文件面向在本仓库工作的 AI agent 与人类贡献者，说明工程规则、测试与静态检查机制、代码风格、禁区，以及本仓库已经在实践的多 Agent 协作约定。请在改动代码前通读一遍。

## 项目速览

- AI Developer Onboarding Copilot：面向新工程师/技术 PM/QA 的仓库导览 MVP —— 仓库摘要、代码问答、影响分析、多 Agent LangGraph 工作流、onboarding 计划、评估指标。
- Node.js ESM（`"type": "module"`），零 Web 框架，原生 `node:http`。
- 后端主体是根目录 `server.js`，配合 `lib/` 下按职责拆出的模块（`lib/config.js`、`lib/store.js`、`lib/memory-db.js`、`lib/checkpoints.js`）。`server.js` 曾是单文件 6029 行，模块化拆分持续进行中，先落地了存储基础层；后续可能继续把更多逻辑迁出到 `lib/`。
- 前端是原生 JavaScript SPA（`public/app.js` + `public/index.html` + `public/styles.css`），无构建步骤，无框架。
- 运行时依赖刻意精简，目前仅 3 个 `@langchain/*` 包（`@langchain/core`、`@langchain/langgraph`、`@langchain/langgraph-checkpoint`）。
- Node 版本要求 `>=24`（`.nvmrc` 锁定 `24`），因为长期记忆存储用到内置 `node:sqlite`。

## 测试命令

`npm test` 依次跑 9 个子命令，总耗时约 41 秒，全程不需要真实的 LLM API key —— 没有配置 `OPENAI_API_KEY` 时，agent 工作流和 harness 会走确定性离线检索/回退路径；smoke test 还会自带一个 fake OpenAI-compatible LLM server 用来验证有 key 时的行为（schema 校验失败、超时、越权引用等边界）。

| 命令 | 作用 |
| --- | --- |
| `npm run test:static` | 跑 `scripts/static-checks.js`：先对 `server.js`、`public/app.js`、`scripts/*.js` 做 `node --check` 语法检查，再自动发现并顺序执行全部 `scripts/check-*.js`。 |
| `npm run test:smoke` | `scripts/smoke-test.js`：在临时端口 + 隔离数据目录下启动真实服务器，覆盖导入、Q&A、agent-impact、onboarding、记忆、安全护栏、fake LLM 边界等端到端路径。 |
| `npm run test:ui` | `scripts/ui-acceptance.js`：启动服务器，验证前端静态资源可被拉取，且 Memory/Harness/Safety/长期记忆/Dashboard 等 API 数据契约齐全。 |
| `npm run test:safety` | `scripts/safety-redteam.js`：prompt injection、密钥请求、工具越权、检索内容注入等红队用例。 |
| `npm run test:memory` | `scripts/memory-compaction-test.js`：标量偏好冲突时旧值转 `superseded`，生成 `preference_summary`。 |
| `npm run test:user-memory` | `scripts/user-memory-isolation-test.js`：按 `X-User-Id` 隔离偏好和 SQLite 长期记忆，跨用户操作应返回 `MEMORY_USER_MISMATCH`。 |
| `npm run test:auth` | `scripts/auth-boundary-test.js`：`AI_PM_AUTH_REQUIRED=true` 下的 token 校验、`/api/health` 免鉴权、`AUTH_USER_MISMATCH` 等边界。 |
| `npm run test:embedding` | `scripts/embedding-provider-test.js`：`MEMORY_EMBEDDING_PROVIDER=openai` 时外部 embedding 读写路径。 |
| `npm run test:benchmark` | `scripts/agent-benchmark.js`：固定离线基准矩阵（安全影响分析、prompt injection、安全问答、工具越权、多轮记忆召回），核对通过率与评估指标。 |

CI（`.github/workflows/test.yml`）在 push `main` 和 PR 上跑 `npm ci && npm test`，按 `ref` 设置了 `concurrency` + `cancel-in-progress`，同一 PR 连续 push 不会堆积多个运行。

改动代码后必须至少跑一次 `npm test` 全量；只跑单个子命令不足以确认没有破坏其他边界（例如改前端可能同时影响 `check-frontend-agent-ui.js` 和 `test:ui`）。

## 静态检查机制（`scripts/check-*.js`）

- `scripts/static-checks.js` 用 `readdir("scripts")` 遍历目录，凡是匹配 `scripts/check-*.js` 的文件都会被当作检查自动纳入执行，**不需要手动登记**。这意味着：**任何被放进 `scripts/` 且命名为 `check-*.js` 的文件都会自动成为 CI 门禁的一部分**，添加或重命名此类文件前要清楚它会立刻参与 `npm test`。
- 各 check 脚本不会直接 `readFile("server.js")`，而是统一经 `scripts/shared/source-reader.js` 读取源码：
  - `readServerSource()` 读取 `server.js` + `lib/**/*.js`（按路径排序拼接成一个字符串），`lib/` 目录不存在时自动跳过 —— 所以 server.js 未来继续拆分到 `lib/` 时，check 脚本的 `String.includes()` / 正则断言不需要改动。
  - `readFrontendSource()` 读取 `public/app.js`。
  - 两者都会把 CRLF 归一化成 LF，避免 Windows 检出环境下 `\n` 锚定正则误判。
  - `source-reader.js` 本身放在 `scripts/shared/`（不是 `scripts/`），刻意避开 `static-checks.js` 的 `check-*.js` 自动发现，不会被当作一个检查执行。
- 现有 24 个 `check-*.js` 覆盖：locale 文案一致性、前端 agent UI 契约、文案质量（乱码/BOM 检测）、运行时依赖白名单、API 文档与路由同步、store schema、smoke 可靠性、UI 验收接线、安全护栏契约、安全红队接线、记忆压缩、用户记忆隔离、认证边界、embedding provider、agent benchmark 契约、agent 响应契约、多 Agent 角色契约、supervisor 路由、HITL resume、LangGraph checkpoint、长期记忆、路由单测、工具策略、架构文档、运维文档同步。
- 多个 check 脚本对 `README.md`、`docs/*.md` 做**精确子串匹配**（`String.includes()` 命中具体短语、`| METHOD | /api/path |` 格式的路由表行等），不是模糊校验。改动 README/文档正文前务必搜一遍 `scripts/check-*.js` 里是否引用了要改的那段文字，否则很容易在无意间让 `check-api-docs.js`、`check-architecture-docs.js`、`check-operations-docs.js`、`check-runtime-deps.js` 等变红。

## 代码风格

- ESM 全程（`import`/`export`），不要引入 CommonJS `require`。
- 新增运行时依赖要非常谨慎：当前只有 3 个 `@langchain/*` 包，`check-runtime-deps.js` 对依赖列表有白名单式断言。新增依赖前先确认是否真的必要，并同步更新相关文档与检查。
- 换行统一 LF，由根目录 `.gitattributes`（`* text=auto` + 对 `.js/.md/.css/.html/.json/.yml` 显式 `eol=lf`）强制。Windows 上直接编辑一般不用担心，但如果用了会转换换行的工具，提交前确认 `git diff` 里没有整文件换行符差异。
- 没有 ESLint/Prettier 等自动格式化配置，风格以跟随现有代码为准：变量/函数命名沿用驼峰、模块内注释沿用中文为主偶尔夹杂英文技术名词的风格，新代码尽量贴近所在文件的既有写法而不是引入新习惯。
- 前端沿用原生 JS + 模板字符串拼 HTML 的现有模式（见 `public/app.js`），不要引入构建步骤或框架依赖。

## 禁区

- 不要提交 `data/` 下的运行时数据文件（`store.json`、`memory.sqlite` 及其 `-wal`/`-shm`/`.bak`/`.corrupt-*` 变体）——这些是用户数据，`.gitignore` 已排除，测试/开发时请用 `DATA_DIR`、`STORE_PATH`、`MEMORY_DB_PATH` 指向临时目录。
- 不要修改 `.workbuddy/`（本地多 Agent 协作工作区状态，不属于产品代码）。
- 不要为了让某个改动“看起来通过”而弱化或删除 `check-*.js` 里的断言；如果确信某个断言过于脆弱或已经过期（比如绑死了一个会随意调整的数值常量），单独说明原因再改，并在改动后完整跑一遍 `npm test` 确认没有引入回归。
- 改了代码之后必须跑全量 `npm test` 再提交，不要只跑本地开发时顺手跑的那一两个子命令。

## 多 Agent 协作约定（本仓库实践）

本仓库的多数近期改动是由多个 worker agent 在独立分支/worktree 中并行完成，再由 reviewer agent 审核后合并的。约定如下：

- **任务卡**：每个 worker 任务以结构化任务卡下发，至少包含 `scope`（允许改动的文件/目录）、`forbidden`（禁止触碰的范围）、`acceptance`（验收标准，通常是某几类 `npm test` 子命令全绿）、`stop_when`（遇到什么情况应该停下汇报而不是自行决定）。
- **worker**：在独立分支或独立 git worktree 中工作，避免和其他并行 worker 互相踩踏；一次任务只产出一个 commit（多个逻辑改动放在同一个 commit 里，而不是拆成一串琐碎提交）；完成后给出结构化报告（改了什么文件、为什么、测试结果），而不是简单说“做完了”。
- **reviewer**：只读审查 worker 产出的 diff，不直接改代码；确认改动落在任务卡的 `scope` 内、没有触碰 `forbidden` 区域、测试结果与报告一致。
- 只有测试全绿（`npm test`）才允许合并到 `main`。合并提交沿用 `merge: <改动摘要>（reviewer 通过/reviewer 两轮通过/reviewer 通过，零阻塞）` 这类描述，说明是第几轮通过、有没有阻塞项。
- 参考近期合并历史（`git log --oneline`）里的 `Wave1-A`/`Wave1-B`/`Wave1-C`/`W2-1`/`W2-2` 系列 merge commit，可以看到这个流程在实际运作中的样子。

## Commit 规范

- 提交信息用中文描述改动内容和原因，首行格式为 `<类型前缀>: <简要描述>`。
- 类型前缀参照 `git log` 里的既有用法：`fix`（缺陷修复）、`feat`（新功能）、`chore`（工程化/杂项，如依赖、CI、忽略规则）、`refactor`（不改变行为的结构调整）、`docs`（文档）、`test`（测试补充）、`style`（不影响逻辑的格式/命名调整）。合并提交用 `merge: ...` 前缀。
- 首行之后可以用列表详细说明每一点改动，尤其是 bug fix 要写清楚“原来的问题是什么、为什么会发生、怎么修的”，方便 reviewer 和后续维护者理解动机而不只是看 diff。
- 由 AI agent 产出的提交，请在提交信息末尾保留 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` 之类的署名尾行（参照近期提交历史的实际写法）。

## 相关文档索引

- [README.md](README.md) / [README.en.md](README.en.md)：安装、测试、运行时配置、API 表、特性清单（中英双语）。
- [docs/AGENT_RUNTIME_ARCHITECTURE.md](docs/AGENT_RUNTIME_ARCHITECTURE.md)：LangGraph、记忆、Harness、安全的实现边界。
- [docs/OPERATIONS.md](docs/OPERATIONS.md)：部署、认证、长期记忆、备份恢复、向量记忆、安全、验证操作。
- [docs/PRD.md](docs/PRD.md)：产品需求与路线图。
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md)：用户工作流说明。
- [docs/MULTI_AGENT_PLAN.md](docs/MULTI_AGENT_PLAN.md)：多 Agent 协同架构计划书。
- [docs/HANDOVER.md](docs/HANDOVER.md)：项目交接文档，含决策脉络和已知边界。
- [docs/CHANGELOG.md](docs/CHANGELOG.md)：开发日志，按日期记录改动。
