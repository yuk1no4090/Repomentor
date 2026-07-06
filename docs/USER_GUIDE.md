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

#### 4.3 Agent Tab — LangGraph Agent 工作流

**功能**：展示 9 节点 LangGraph Agent 工作流，每步可见输入、输出、引用和 guardrail 结果。

**流程**：
1. input_safety — 检查 prompt injection、密钥请求和越权工具意图
2. memory — 加载已确认偏好，并生成待确认记忆建议
3. classify_change_request — 识别改动类型
4. retrieve_repository_chunks — 检索相关 chunks
5. expand_dependency_context — 扩展搜索上下游依赖
6. estimate_impact_risk — 按模块聚合风险
7. plan_regression_tests — 生成回归测试建议
8. validate_output — 校验引用、敏感输出、过度自信和工具策略
9. compose_structured_answer — 生成结构化输出

**状态卡**：Agent header 会展示 Memory、Harness、Safety 三类状态。Memory 显示已使用偏好和待确认数量；Harness 显示模型模式、步骤数、耗时、fallback 和预算状态；Safety 显示护栏通过或需要复核以及命中的风险类型。

**记忆建议**：Agent 会展示最近的记忆建议。待确认建议可保存或忽略；已确认和已忽略建议会保留状态标记，避免用户误以为本次旧回答已经应用了刚保存的偏好。

**面试价值**：展示 LangGraph nodes / state / tools / trace / memory / harness / guardrails / structured output 这些 Agent 工程核心理念。

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
| 可选前端 | `nocode/` 目录含 React + Vite + shadcn/ui 版本（独立项目） |

## API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | LLM 状态 + 服务运行时间 |
| GET | `/api/projects` | 获取所有项目 |
| POST | `/api/import` | 导入仓库（sample / repoUrl / zipBase64） |
| POST | `/api/chat` | 问答 / 影响分析（kind: "qa" / "impact"） |
| POST | `/api/agent-impact` | LangGraph Agent 工作流影响分析，返回 memory / harness / safety 状态 |
| POST | `/api/onboarding` | 生成入职学习计划 |
| POST | `/api/feedback` | 提交回答反馈 |
| GET | `/api/evaluation` | 获取评估指标 |
| GET | `/api/harness-run` | 按 projectId 和 runId 查看单次 harness 执行快照 |
| GET | `/api/langgraph-checkpoint` | 按 projectId、runId 和 checkpointId 查看单个 LangGraph checkpoint 摘要 |
| GET | `/api/memory` | 获取已确认偏好和最近记忆建议 |
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

- `npm run test:static`：静态契约、文案、依赖、架构文档和前端 UI 结构检查。
- `npm run test:smoke`：后端 API、LangGraph、记忆、harness、安全、评价指标的临时服务回归测试。
- `npm run test:ui`：启动临时服务，拉取真实前端资源，导入 sample workspace，运行 Agent Workflow，并确认 Memory / Harness / Safety / long-term memory / Dashboard / harness audit panel 都有可渲染数据。
- `npm test`：串联以上三类检查。

**关键面试话术**：
- "顶部绿色标识说明当前是 AI 增强模式，我接入了 DeepSeek API"
- "每条回答都有文件引用——这是 RAG 的 citation 机制，降低幻觉"
- "Agent 工作流是 LangGraph 9 节点编排，每步能看到输入输出、引用文件和 guardrail 状态"
- "记忆模块只保存用户确认过的偏好，未确认建议不会写入长期记忆"
- "Harness 统一记录模型模式、步骤预算、耗时、schema 校验和 fallback"
- "Safety 护栏会标记 prompt injection、敏感信息请求、越权工具意图和无效引用"
- "评估仪表盘有真实数据——83% helpful rate、86% citation coverage、14% uncertain rate"
