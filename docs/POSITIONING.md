# Positioning One-Pager｜AI Developer Onboarding Copilot

> 产品名 Repomentor（2026-08-18 定名），品类：AI Developer Onboarding Copilot。

> 面试随身页：一句话定位 → 市场验证 → 差异化切入 → 可验证的能力证据。数据截至 2026-08-12，市场信息来自桌面调研（来源见 PRD 第 15 节）。

## 一句话定位

面向新入职工程师、技术 PM 和 QA 的代码库理解 Copilot：导入仓库即获得带引用的代码问答、非工程师可读的改动影响简报、个性化 onboarding 计划——并用产品内置的 AI 质量看板证明自己可信。

## 问题与市场验证

**问题**：新成员建立项目上下文平均需要数天到数周；文档过期、知识散落，PM/QA 无法判断"这个需求会动到哪里、该测什么"。

**市场同向验证**（选题判断的外部佐证）：
- Google Code Wiki（2025-11 公开预览）、Cognition DeepWiki（5 万+ 仓库）、GitHub Copilot Spaces（2025-09 GA）先后收敛到「仓库 → 自动知识库 → 带引用问答」同一范式——巨头验证了问题真实性；
- 教训同样明确：单点"代码理解"产品难独立存活（CodeSee 被收购后雪藏、Bloop 关停）——所以本项目的价值主张是**角色扩展与信任设计的组合**，不是单点功能。

## 差异化切入（两点，均有调研背书）

**1. 把影响分析翻译给不写代码的人。** 现有变更影响工具（CodeScene、Moderne、SeaLights、Launchable）清一色服务工程师与 CI；AI 代码审查（Greptile、CodeRabbit）无一把 PM/QA 列为用户。本项目：输入一句需求描述 → 输出受影响模块、业务链路、风险级别、测试重点的自然语言简报。这是「代码理解引擎 + 非技术角色」的空白交叉点。*（诚实边界：该空白可能反映需求刚性不足，作为产品假设持续验证。）*

**2. 质量指标是产品的一部分，不是外挂工具。** 行业默认做法是接 LangSmith/Langfuse 给工程师看；本项目把引用覆盖率、答案 schema 合规率、guardrail 命中、Agent trace 审计直接做进产品 UI——用户不需要相信 AI，用户可以查账。"PM/QA 无需工程介入即可评估"正是 2026 年评估工具行业的公认演进方向。

## 能力证据（全部可在仓库验证）

| 能力关键词 | 仓库证据 |
|---|---|
| RAG | 分块/检索/查询扩展，回答逐条带文件引用 |
| Agentic Workflow | Supervisor/ImpactAnalyst/QACritic 三个独立模型 Agent + LangGraph supervisor 路由、有界 QACritic revise 环（图上唯一真实环路）、基于原生 interrupt/Command 的 HITL 人工审批、checkpoint 断点续跑、节点级 SSE 进度流、分角色模型/温度配置、预算与超时控制、结构化输出 |
| Guardrails | 输入/检索/输出三级安全扫描、敏感信息脱敏、红队测试脚本 |
| Evals | 内置评估看板 + agent benchmark（5 案例全过）+ 237 条 node:test 单元测试 + 34 项静态检查门禁 |
| 记忆与个性化 | 用户偏好长期记忆（SQLite+FTS+向量）、记忆确认闭环、用户隔离 |
| 工程素养 | 单文件 6029 行重构为 13 模块（约 1550 行主文件）、CI、Docker、双语文档、全程测试全绿 |

## AI-native 工作方式（过程本身即证据）

本项目两轮大规模重构由**多 Agent 工程流水线**完成：主控编排 + 任务卡（scope/forbidden/acceptance）+ 独立 worktree worker + 只读 reviewer 门禁 + 全量回归后合并。两天内 14 张任务卡、11 次合并、评审拦下 6 个真实问题、零回归——全程留痕于 git log 与 CHANGELOG，可逐条验证。

## 不做什么（边界即判断力）

不做企业权限系统的深化、不再扩展向量库适配器、不做自动改代码/提 PR、不与 IDE 类产品（Cursor）竞争工程师编码场景。理由：作品集的目标是展示 AI PM 的问题定义、方案取舍与质量管理能力——每一条投入都对应一个能力证据，边际收益归零即停。
