# AI Developer Onboarding Copilot PRD

## 1. 项目概述

**项目名称**：AI Developer Onboarding Copilot  
**中文名**：AI 研发知识助手 / AI 代码库入门助手  
**项目类型**：AI 产品经理作品集 MVP  
**目标岗位匹配**：AI 产品经理、GenAI PM、技术产品经理、Developer Productivity PM

### 一句话描述

面向新入职工程师、技术 PM 和 QA 的 AI Copilot，通过解析代码仓库、README、接口文档和 issue，帮助用户快速理解项目结构、业务流程、关键模块、改动影响范围和测试重点，并通过引用来源、Agent 执行轨迹、反馈闭环和评估指标降低 AI 幻觉风险。

### 产品定位

这个产品不是普通“代码问答机器人”，而是一个面向研发 onboarding 场景的 AI 工作台。它展示从用户问题发现、MVP 定义、RAG 方案、轻量 Agentic Workflow、AI guardrails、质量评估到产品迭代的完整 AI PM 能力。

## 2. 背景与问题

### 用户问题

新成员加入项目时，常见问题不是“找不到代码”，而是无法快速建立上下文：

- 文档分散在 README、Wiki、接口文档、issue 和代码注释中。
- 文档可能过期，真实逻辑藏在 routes、services、models、tests 中。
- 新人不知道应该先看哪些文件。
- PM 和 QA 难以理解代码改动会影响哪些业务链路。
- AI 回答如果没有来源引用，用户难以判断可信度。

### 产品机会

RAG 可以把代码和文档变成可检索上下文；引用来源和不确定性提示可以降低幻觉风险；影响范围分析和测试建议能把 AI 从“问答工具”提升为“研发工作流助手”。

## 3. 目标与非目标

### 产品目标

1. 帮助新入职工程师在 1-3 天内建立项目结构和核心业务流程认知。
2. 帮助技术 PM 快速理解需求背后的接口、模块、数据流和改动风险。
3. 帮助 QA 根据代码和文档生成测试场景和边界条件。
4. 通过文件引用、不确定性标记和反馈机制降低 AI 幻觉。
5. 用 evaluation dashboard 展示 AI 产品质量管理能力。
6. 通过 Agentic Impact Workflow 展示 tools、trace、guardrails 和 structured output 的 Agent 产品设计理解。

### MVP 非目标

- 不做企业权限系统。
- 不做多人协作。
- 不做 GitHub OAuth。
- 不做自动提交 PR。
- 不做复杂 Agent 自动改代码或自动提交 PR。
- 不追求支持所有语言和框架。
- 不做复杂模型路由和模型市场。

## 4. 目标用户

### 4.1 新入职工程师

**痛点**

- 不知道从哪里开始读代码。
- 不知道核心业务流程在哪些文件里。
- 想改代码但担心影响其他模块。

**典型问题**

- 用户登录流程是怎么走的？
- 订单创建涉及哪些模块？
- 我想修改订单状态字段，会影响哪些地方？
- 第一周应该先看哪些代码？

### 4.2 技术 PM

**痛点**

- 需要理解功能背后的接口、状态流转和模块依赖。
- 需要评估需求变更的技术影响。
- 需要把代码逻辑翻译成业务语言。

**典型问题**

- 优惠券功能涉及哪些接口？
- 如果新增退款状态，可能影响哪些页面和接口？
- repo 里和支付相关的逻辑在哪里？

### 4.3 QA / 测试

**痛点**

- 不知道代码改动影响哪些测试场景。
- 不清楚业务边界和异常路径。
- 需要快速生成测试思路。

**典型问题**

- 修改登录逻辑后需要测哪些场景？
- 订单取消有哪些边界情况？
- 支付失败后系统会怎么处理？

## 5. 核心价值主张

用户导入或上传一个代码仓库后，系统自动解析文件，生成项目摘要和可问答的 Copilot。AI 回答必须基于仓库上下文，给出文件引用，并在证据不足时说明不确定。

核心价值：

- **更快理解代码库**：自动生成项目结构、技术栈、核心模块和推荐阅读路径。
- **更可信的 AI 回答**：每个答案必须关联文件路径、函数或代码片段说明。
- **更贴近研发工作流**：支持改动影响范围分析、Agent 执行轨迹和测试建议。
- **可衡量的 AI 质量**：用 dashboard 追踪 helpful rate、citation coverage、uncertain answer rate 等指标。

## 6. MVP 范围

### 6.1 Repo 导入 / 文档上传

支持：

- 输入公开 GitHub repo URL。
- 上传 ZIP 文件。
- 使用内置 Sample Repo 进行 demo。

解析文件类型：

- `.md`
- `.txt`
- `.js`
- `.ts`
- `.tsx`
- `.py`
- `.java`
- `.json`
- `.yaml`
- `.yml`

忽略目录：

- `.git`
- `node_modules`
- `dist`
- `build`
- `.next`
- `coverage`

### 6.2 项目结构摘要

导入完成后展示：

- 项目名称
- 文件数和 chunk 数
- 主要技术栈推测
- 目录结构
- 核心模块
- README 摘要
- 推荐新人优先阅读文件

### 6.3 代码库问答

用户可提问项目相关问题。回答结构：

```json
{
  "answer": "string",
  "key_points": ["string"],
  "related_files": [
    {
      "file_path": "string",
      "reason": "string"
    }
  ],
  "uncertainty": "string",
  "suggested_next_questions": ["string"]
}
```

规则：

- 只能基于检索到的代码和文档回答。
- 必须引用文件路径。
- 不确定时必须明确说明。
- 不编造文件、函数、接口或业务逻辑。

### 6.4 影响范围分析

用户输入计划改动，系统输出可能影响模块、风险等级、相关文件、测试建议和开放问题。

示例输入：

```text
我想给订单新增一个状态 partially_refunded，可能影响哪些地方？
```

输出结构：

```json
{
  "summary": "string",
  "impact_areas": [
    {
      "area": "Data Model",
      "files": ["string"],
      "risk_level": "low | medium | high",
      "reason": "string"
    }
  ],
  "testing_suggestions": ["string"],
  "open_questions": ["string"]
}
```

### 6.5 Agentic Impact Workflow

在普通影响范围分析之外，MVP 增加一个可解释的轻量 Agent 工作流。它不是自动改代码 Agent，而是面向“改动影响分析”的 LangGraph stateful workflow，用来展示 Agent 框架思维。

用户输入计划改动后，Agent 按步骤执行：

1. `classify_change_request`：识别改动类型，例如状态变更、数据模型变更、API 合约变更、UI 行为变更。
2. `retrieve_repository_chunks`：检索与请求最相关的代码和文档 chunks。
3. `expand_dependency_context`：扩展搜索 models、routes、services、UI、tests 等相邻风险区域。
4. `estimate_impact_risk`：按模块聚合影响范围，并给出风险等级。
5. `validate_citations`：执行引用 guardrail，确保影响范围引用的文件存在于当前仓库。
6. `compose_structured_answer`：输出 PM / QA 可读的影响摘要、测试建议和开放问题。

输出结构：

```json
{
  "agent": {
    "name": "Impact Analysis Agent",
    "pattern": "stateful multi-agent graph workflow",
    "framework_concepts": ["LangGraph StateGraph", "nodes", "state", "tools", "trace", "guardrails", "structured output", "memory"],
    "instructions": ["string"]
  },
  "summary": "string",
  "trace": [
    {
      "step": "string",
      "tool": "string",
      "purpose": "string",
      "input": {},
      "output": {},
      "citations": ["string"]
    }
  ],
  "impact_areas": [],
  "testing_suggestions": [],
  "open_questions": [],
  "guardrails": [],
  "uncertainty": "string"
}
```

该设计可映射到真实 Agent 框架：

- OpenAI Agents SDK：Agent instructions + tool calling + guardrails + tracing。
- LangGraph：将 classify / retrieve / expand / guardrail / finalize 建模为 stateful graph nodes。
- Vercel AI SDK：将 agent trace 和 structured outputs 渲染到前端工作台。

### 6.6 新人学习路径生成

用户选择角色和周期：

- Backend Engineer
- Frontend Engineer
- Product Manager
- QA
- 3 days / 5 days

输出结构：

```json
{
  "role": "Backend Engineer",
  "duration": "3 days",
  "goal": "string",
  "plan": [
    {
      "day": "Day 1",
      "focus": "string",
      "files_to_read": ["string"],
      "tasks": ["string"]
    }
  ]
}
```

### 6.7 AI 回答反馈

每个回答下方提供反馈按钮：

- Helpful
- Not helpful
- Inaccurate
- Missing citation
- Too generic

反馈进入 evaluation dashboard，用于衡量 AI 质量和定位失败原因。

### 6.8 Evaluation Dashboard

展示指标：

- Total Questions
- Helpful Rate
- Citation Coverage
- Uncertain Answer Rate
- Negative Feedback Rate
- High Risk Questions
- Agent Runs
- Top Failure Reasons
- Recent Feedback

## 7. 页面与信息架构

### 7.1 Product / Landing

目标：让面试官快速理解产品不是单纯聊天工具，而是研发 onboarding 工作台。

内容：

- 产品名称和一句话价值主张
- 核心功能入口
- 工作流预览：Import -> Understand -> Ask -> Analyze -> Evaluate
- Demo 入口

### 7.2 Import

目标：完成仓库导入和解析。

内容：

- GitHub repo URL 输入
- ZIP 上传
- Sample Repo
- 解析进度：Uploading / Parsing / Creating index / Summarizing / Ready
- 支持文件类型和忽略目录说明

### 7.3 Overview

目标：给用户一个“项目地图”。

内容：

- 项目摘要
- 技术栈
- 核心模块
- 目录树
- 推荐阅读文件
- 进入 Copilot 的主按钮

### 7.4 Copilot

目标：完成三类核心任务。

布局：

- 左侧：项目摘要、推荐问题、文件列表
- 右侧：Q&A / Impact Analysis / Agent Workflow / Onboarding Plan tabs

核心能力：

- 代码库问答
- 影响范围分析
- Agentic Impact Workflow
- 学习路径生成
- 回答反馈

### 7.5 Dashboard

目标：展示 AI 产品质量管理能力。

内容：

- AI 质量指标
- 用户反馈
- 常见失败原因
- 后续优化方向

## 8. RAG 与 AI 逻辑

### 8.1 文件处理

1. 读取 repo 文件。
2. 过滤不支持文件和依赖目录。
3. 按文件和行数切分 chunks。
4. 每个 chunk 保存 metadata：
   - `file_path`
   - `file_type`
   - `chunk_index`
   - `start_line`
   - `end_line`
   - `content`

### 8.2 检索逻辑

MVP 可先使用本地关键词检索或轻量向量检索：

1. 对问题进行 tokenization。
2. 对 chunk 内容、文件路径、符号名进行打分。
3. 返回 top 5-8 chunks。
4. 将 chunks 作为上下文传给回答生成模块。
5. 输出结构化 JSON。

后续可升级：

- OpenAI embeddings
- pgvector / Chroma / FAISS
- 代码符号图谱
- issue / PR / README 联合检索

### 8.3 系统 Prompt

```text
You are an AI Developer Onboarding Copilot.
Your job is to help engineers, product managers, and QA understand a codebase.

Rules:
1. Answer only based on the provided repository context.
2. Always cite file paths when making claims.
3. If the context is insufficient, say that you are not sure.
4. Do not invent files, functions, APIs, or business logic.
5. For code change questions, provide impact analysis and testing suggestions.
6. For onboarding questions, provide a structured learning path.
7. Keep answers practical and product-oriented.
```

## 9. Guardrails 与风险控制

| 风险 | 产品控制 |
| --- | --- |
| AI 编造文件或函数 | 回答必须基于 retrieved chunks，并显示文件引用 |
| 用户误信不完整答案 | 显示 uncertainty 字段 |
| 代码检索遗漏 | 展示 suggested next questions，引导用户继续追问 |
| 影响分析过度自信 | 输出 open questions 和 risk level |
| Agent 工作流黑盒化 | 展示 trace、tool、input/output summary 和 citations |
| Agent 引用不存在的文件 | `validate_citations` guardrail 校验文件是否存在 |
| 反馈无法沉淀 | 所有回答可反馈，并进入 dashboard |

## 10. 数据结构

### Project

```json
{
  "id": "string",
  "name": "string",
  "source": "github | zip-upload | sample",
  "fileCount": 0,
  "chunkCount": 0,
  "summary": {}
}
```

### Chunk

```json
{
  "id": "string",
  "file_path": "string",
  "file_type": "string",
  "chunk_index": 0,
  "start_line": 0,
  "end_line": 0,
  "content": "string"
}
```

### Answer

```json
{
  "id": "string",
  "projectId": "string",
  "questionId": "string",
  "kind": "qa | impact | agent_impact | onboarding",
  "payload": {},
  "responseTimeMs": 0,
  "createdAt": "string"
}
```

### Feedback

```json
{
  "id": "string",
  "projectId": "string",
  "answerId": "string",
  "type": "helpful | not_helpful | inaccurate | missing_citation | too_generic",
  "createdAt": "string"
}
```

## 11. AI 评估方案

### 离线评估

准备至少 20 个标准问题：

- 这个项目主要模块有哪些？
- 用户登录逻辑在哪里？
- 订单创建流程是怎样的？
- 支付失败如何处理？
- 如果新增订单状态，会影响哪些模块？
- 新人后端工程师应该先看哪些文件？
- QA 应该重点测试哪些场景？

人工标注：

- 是否准确
- 是否有引用
- 是否胡编
- 是否对用户有帮助
- 是否覆盖测试建议

### 在线评估

用用户反馈和系统日志计算：

- Helpful Rate
- Citation Coverage
- Uncertain Answer Rate
- Negative Feedback Rate
- Top Failure Reasons
- Average Response Time
- Agent Runs

## 12. 验收标准

### 功能验收

- 用户可以导入公开 GitHub repo 或上传 ZIP。
- 系统可以解析代码和 Markdown 文件。
- 系统可以生成项目摘要。
- 用户可以向 repo 提问。
- AI 回答可以引用文件来源。
- 用户可以发起影响范围分析。
- 用户可以运行 Agent Workflow，并看到工具步骤、trace、guardrails 和引用文件。
- 用户可以生成 onboarding plan。
- 用户可以对回答进行反馈。
- Dashboard 可以展示 AI 产品指标。

### 质量验收

- 常见问题回答必须带引用。
- 不相关问题或证据不足时必须显示不确定。
- 影响分析必须包含测试建议和开放问题。
- Agent Workflow 必须展示工具调用轨迹和 guardrail 状态。
- Dashboard 指标能基于真实反馈变化。

## 13. 迭代路线图

### V0.1 MVP

- 本地 ZIP / GitHub public repo 导入
- 本地 chunk 和检索
- 项目摘要
- Q&A / Impact / Onboarding
- Agentic Impact Workflow
- 反馈和 dashboard

### V0.2 AI 质量增强

- 接入 embeddings
- 增加引用片段预览
- 增加回答 confidence / evidence score
- 增加标准问题评估集

### V0.3 研发工作流增强

- GitHub issue / PR context 导入
- 代码符号关系图
- 影响范围图谱
- QA test case export
- 增加 supervisor 动态派发或 human-in-the-loop 审核节点
- 增加 human-in-the-loop 审核节点
- 详见 [MULTI_AGENT_PLAN.md](./MULTI_AGENT_PLAN.md) 多 Agent 协同计划书（scene#17）

### V0.4 团队化能力

- 多项目管理
- 成员反馈聚合
- 项目知识库更新时间检测
- 权限和审计日志

## 14. 简历包装文案

```text
AI Developer Onboarding Copilot｜AI 产品经理个人项目

- 面向新入职工程师、技术 PM 和 QA，设计并落地一款基于 RAG 的 AI Copilot 产品，解决代码库理解成本高、业务上下文分散和文档过期问题。
- 完成用户场景拆解、PRD、MVP 范围定义、核心流程设计和 AI 质量指标设计，核心功能包括代码库问答、影响范围分析、Agentic Impact Workflow 和新人学习路径生成。
- 设计回答引用机制和 guardrails，要求 AI 基于代码与文档回答，在上下文不足时提示不确定，降低幻觉风险。
- 搭建 AI evaluation dashboard，追踪 citation coverage、helpful rate、uncertain answer rate、negative feedback rate 等指标，用于指导产品迭代。
- 设计轻量 Agent 工作流，展示 instructions、tools、trace、guardrails 和 structured output，并将 Agent Runs 纳入质量指标。
- 基于真实或开源代码仓库完成 demo 验证，沉淀 20+ 标准测试问题，用于评估回答准确性和产品可用性。
```
