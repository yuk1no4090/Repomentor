# 多 Agent 协同计划书

> **场景编号**：scene#17「Agent 应用」
> **关联 PRD**：V0.3 "supervisor 动态派发 + human-in-the-loop 审核节点"
> **状态**：P1-P4 已全部实现（2026-08-07）
> **创建日期**：2026-08-07
> **维护人**：AI PM 作品集

---

## 1. 目标与课程对齐

| 课程评分点 | 对应章节 | 说明 |
|---|---|---|
| 多 Agent 架构设计 | §2 架构设计 | Supervisor + 7 专家 Agent，conditional edges 动态路由 |
| 角色分工 | §2.2 专家 Agent | 每 Agent 职责、工具子集、输入输出契约 |
| 通信/协调机制 | §2.3 状态与 handoff | State 字段（handoffs/routeDecisions/hitlRequest）、交接记录 |
| 演示场景 | §4 演示场景 | 高风险变更提问 → 路由 → HITL → 批准的端到端故事 |
| 评估指标 | §5 评估指标 | routing_accuracy / handoff_count / HITL 介入率 |
| 技术风险与可回退 | §6 风险与回退 | linear 模式开关 + HITL 默认关闭 + 确定性规则表 |

---

## 2. 多 Agent 架构设计

### 2.1 核心理念：从线性管道到 Supervisor 编排

**现状**：`createAgentGraph()`（server.js L4242-4484）定义了一条线性 9 节点图——

```text
input_safety → memory → classify → retrieve → expand_context
  → impact_analysis → qa_plan → guardrails → synthesize
```

每条边固定，无分支、无循环、无动态派发。

**目标**：新增 **Supervisor 节点**，用 `addConditionalEdges` 替代固定边，实现按状态信号的条件路由。

**路由策略（确定性优先）**：
- 路由决策以**确定性规则表 `ROUTE_RULES`** 为主，代码纯函数、单元可测。
- LLM 仅作为可选增强（如规则表中未覆盖的边缘 case），失败时回退规则表。
- 环境变量 `AGENT_GRAPH_MODE=linear` 一键回退旧图，保证交付安全。

### 2.2 专家 Agent 角色划分

将 9 个节点重组为 **7 个专家 Agent**，各配工具子集：

| # | Agent 名称 | 来自节点 | 核心职责 | 工具子集 | 走 modelAdapter？ |
|---|---|---|---|---|---|
| 1 | **SafetyGuard** | input_safety + guardrails | 输入安全扫描 + 输出安全审核 | `safety.scan_input`、`safety_guardrail_agent.validate_output` | 否 |
| 2 | **MemoryCurator** | memory | 加载用户偏好 / 建议新记忆 | `memory.load_preferences` | 否 |
| 3 | **Classifier** | classify | 变更分类 + 风险评级 + 路由信号 | 无（纯推理） | 否 |
| 4 | **Retriever** | retrieve + expand_context | 代码块检索 + 上下文扩展 | `retriever_agent.*`、`context_expander_agent.*` | 否 |
| 5 | **ImpactAnalyst** | impact_analysis | 影响范围分析 | `impact_analyst_agent.*` | **是（唯一）** |
| 6 | **QAPlanner** | qa_plan | 生成测试计划 | 无 | 否 |
| 7 | **Synthesizer** | synthesize | 汇总各 Agent 输出生成最终回答 | 无 | 否 |

### 2.3 状态扩展（State Annotation）

在 `createGraphStateAnnotation`（server.js ~L4216）中追加以下 channel（reducer 用 append 模式，与 trace 同款）：

```text
handoffs: Annotation({ reducer: append })
  // { sender, recipient, reason, step }
  // 每次 Agent 交接时追加一条

routeDecisions: Annotation({ reducer: append })
  // { from_node, to_node, signal, rule_matched, step }
  // supervisor 每次路由决策时追加

hitlRequest: null | { node, reason, checkpoint_id }
  // human_review 节点 interrupt() 前写入

agentRoster: {}
  // 角色名 → 工具子集列表，供 trace 和 UI 渲染
```

### 2.4 路由规则表（确定性）

Supervisor 读取 state 信号后查表决策：

| 当前节点 | 条件 | 目标节点 |
|---|---|---|
| SafetyGuard | output_status = "safe" | MemoryCurator |
| SafetyGuard | output_status = "blocked" | Synthesizer（安全阻断回答） |
| MemoryCurator | 始终 | Classifier |
| Classifier | 始终 | Retriever |
| Retriever | retrieved_count >= threshold | ImpactAnalyst |
| Retriever | retrieved_count < threshold（第 1 次） | Retriever（重试） |
| Retriever | retrieved_count < threshold（第 2 次） | Synthesizer（检索不足降级） |
| ImpactAnalyst | riskLevel = "high" 且 HITL 开启 | HumanReview |
| ImpactAnalyst | riskLevel != "high" 或 HITL 关闭 | QAPlanner |
| HumanReview | decision = "approve" | Synthesizer |
| HumanReview | decision = "reject" | END |
| HumanReview | decision = "edit" | QAPlanner（用编辑内容重走后续流程） |
| QAPlanner | 始终 | Synthesizer |
| Synthesizer | 始终 | SafetyGuard（输出安全审核）→ END |

### 2.5 架构图

```text
                        ┌─────────────┐
                        │  SafetyGuard │
                        └──────┬──────┘
                               │
                        ┌──────▼──────┐
                        │ MemoryCurator│
                        └──────┬──────┘
                               │
                        ┌──────▼──────┐
                        │  Classifier  │───(路由信号: change_type, riskLevel)───┐
                        └──────┬──────┘                                       │
                               │                                               │
                        ┌──────▼──────┐                                       │
                 ┌─────│  Retriever  │◄──(检索不足, 重试≤2次)                  │
                 │     └──────┬──────┘                                       │
                 │            │                                               │
                 │     ┌──────▼──────┐                                       │
                 └────▸│ImpactAnalyst│──(riskLevel=high)→[HumanReview]        │
                       └──────┬──────┘                                       │
                              │                                               │
                       ┌──────▼──────┐        ┌──────────────┐                │
                       │  QAPlanner  │───◄────│ HumanReview  │(可选 HITL)     │
                       └──────┬──────┘        └──────────────┘                │
                              │                                               │
                       ┌──────▼──────┐                                       │
                       │ Synthesizer │                                       │
                       └──────┬──────┘                                       │
                              │                                               │
                       ┌──────▼──────┐                                       │
                       │ SafetyGuard │(输出安全审核)                            │
                       └──────┬──────┘                                       │
                              │                                               │
                             END                                              │
                                                                              │
              ◄── Supervisor 按 ROUTE_RULES 在每个节点后决策下一跳 ──────┘
```

---

## 3. 分阶段实施路线

### P1：Agent 角色显式化

**目标**：不改图结构，仅让 trace 和 harness 暴露 agent 角色元数据。

**改动点**：
- `AGENT_TOOL_REGISTRY`（L126）：每工具增加 `agent_role` 字段，7 个 Agent 各有对应工具子集。
- trace 输出：每个节点结束时 trace step 中推入 `agent_role: "Retriever"` 等标记。
- State annotation（L4216）：追加 `handoffs`、`agentRoster` 字段，仅填充，不参与路由。

**验收**：
- 20 个现有 check 全绿
- `/api/agent-impact` → harness.trace[].agent_role 非空
- 新增 `scripts/check-multi-agent-roles.js`：校验 tool→role 映射 1:1、7 个 Agent 全部定义、无孤岛工具

**不改**：图结构、路由逻辑、前端 UI。

---

### P2：Supervisor 动态路由

**目标**：引入 supervisor 节点 + conditional edges，替代线性 `addEdge`。

**改动点**：
- server.js ~L4238：新增 `supervisor()` 节点函数
- `createAgentGraph()`：用 `addConditionalEdges("supervisor", decideNextAgent)` 替代所有 `addEdge`
- 新增 `ROUTE_RULES` 常量 + `decideNextAgent(state)` 纯函数（独立可测）
- 预算：`AGENT_MAX_STEPS=14`（原 9 → 14。14 覆盖 7 Agent + 1 supervisor + 重试 + HITL 等待），`AGENT_BUDGETS.max_steps` 改为读此环境变量
- 环境变量：`AGENT_GRAPH_MODE`，`linear`→旧图，`supervisor`→新图（默认 `supervisor`）

**验收**：
- `linear` 模式下 20 个 check 全绿
- `supervisor` 模式下同一问题不同 riskLevel 走不同路径
- 新增 `scripts/check-supervisor-routing.js`：全部 change_type 路由单测 + harness budget_status 验证 max_steps=14
- 路由决策从不依赖 LLM（除非 LLM 增强开启，失败时回退规则表）

**不改**：前端、HITL。

---

### P3：Human-in-the-Loop 审核

**目标**：高风险场景引入人工审核断点，实现"人在回路"。

**改动点**：
- 新增 `human_review` 节点：调用 LangGraph `interrupt()` 挂起，写入 `hitlRequest` 到 state
- supervisor 路由：`riskLevel === "high"` 且 `AGENT_HITL_ENABLED=true` 时路由到 `human_review`；关闭时直通（等价于无 HITL）
- `/api/langgraph-resume`：body 新增 `decision: "approve"|"edit"|"reject"` + 可选 `edited_payload`；resume 时 supervisor 根据 decision 路由后续
- 前端（P4 配合）：审核卡片（风险原因 + 批准/修改/拒绝按钮）

**验收**：
- HITL 关闭时视为直通，行为等价于 P2
- HITL 开启时 `high` risk 提问被 interrupt，resume 批准后正常 synthesize，拒绝后终止
- 新增 `scripts/check-hitl-resume.js`：覆盖 approve/edit/reject 三条 resume 路径
- 20 个旧 check 仍然全绿（HITL 关闭）

**不改**：线性模式（HITL 仅在 supervisor 模式下生效）。

---

### P4：前端协同视图

**目标**：public/app.js 展示多 Agent 协同过程。

**改动点**：
- 利用 harness trace + handoffs 数据，在现有工作台新增"Agent 泳道"面板
- 泳道按时间线渲染 sender→recipient 流转箭头，每跳标注 reason
- HITL 开启时：在答案面板顶部渲染审核卡片（风险原因 + 操作按钮）

**验收**：
- handoffs 数据完整时泳道正确渲染
- HITL 审核卡片可交互
- 不影响现有 Q&A / Impact / Onboarding 面板渲染

**不改**：nocode/ 原型。

---

## 4. 演示场景

课程展示用端到端故事线：

> **用户提问**：「如果我要把 auth middleware 从 Bearer token 改成 JWT + refresh token 方案，会影响哪些模块？」
>
> 1. **SafetyGuard** 扫描输入 → 安全通过
> 2. **MemoryCurator** 加载用户角色偏好（后端工程师）
> 3. **Classifier** 判定：CHANGE_TYPE="auth_refactor"，riskLevel="high"
> 4. **Retriever** 检索 auth 相关模块 + 中间件链（`server.js`、`public/app.js`、auth 工具函数）
> 5. **ImpactAnalyst** 调用 modelAdapter，分析影响范围：auth boundary、所有受保护路由、前端 token 存储
> 6. supervisor 发现 riskLevel=high → **路由到 HumanReview**，中断等待
> 7. 审核人看到风险摘要 → 点击"批准"
> 8. **QAPlanner** 生成测试清单
> 9. **Synthesizer** 汇总 → **SafetyGuard** 审核输出 → 返回最终回答
>
> 泳道面板显示完整 handoff 链路：SafetyGuard → MemoryCurator → Classifier → Retriever → ImpactAnalyst → ⏸ HumanReview → ✅ QAPlanner → Synthesizer → ✅

---

## 5. 评估指标

接入现有 evaluation dashboard（harness run 基于 `store.json` + 基准测试）：

| 指标 | 含义 | 数据来源 | 阈值 |
|---|---|---|---|
| `routing_accuracy` | 确定性路由命中预期路径的比例 | 离线 agent-benchmark.js 扩展计算 | ≥ 95% |
| `handoff_count` | 单次运行 Agent 交接次数 | harness.handoff_count（与 budget_status 平级） | ≤ max_steps |
| `hitl_intervention_rate` | HITL 触发率（高风险管理） | harness.hitl_requested / total_runs | 监控用，无硬阈值 |
| `supervisor_overhead_steps` | supervisor 自身消耗步数 | harness.supervisor_overhead_steps | ≤ 3 |
| `fallback_rate` | 路由回退到 linear 模式的次数 | harness.fallback_mode_used | 0（除非 LLM 增强异常） |

新增 `scripts/check-agent-benchmark.js` 检查以上阈值。

---

## 6. 风险与回退

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| conditional edges + interrupt 改变 checkpoint 形状，破坏旧 resume 语义 | 高 | `AGENT_GRAPH_MODE=linear` 一键回退旧图；P2 不改 checkpoint schema，仅改边 |
| 预算 9→14 步可能导致部分请求超时 | 中 | `AGENT_MAX_STEPS` 环境变量可配，必要时降回 9；harness 超时保护不变（LLM_REQUEST_TIMEOUT_MS） |
| 路由规则表覆盖不全、某些 change_type 漏网 | 中 | 规则表 `switch(change_type) { default → linear_path }` 兜底；单元测覆盖全部枚举值 |
| HITL 中断后用户不操作，线程长时间占用 | 低 | checkpoint 持久化到 SQLite，用户可随时 resume；不操作则保持 checkpoint（无泄漏） |

**核心原则**：
1. 确定性优先 —— LLM 不参与关键路由（除非显式开启增强模式并标注 `LLM_ASSISTED_ROUTE=true`）
2. 环境变量开关 —— 每一项新能力都可一键回退
3. 新 check 脚本先写后改码 —— 20 个旧 check 全程不红

---

## 7. 关键文件清单

### 需要修改

| 文件 | 改动范围 | 阶段 |
|---|---|---|
| `server.js` | State annotation（L4216）、`createAgentGraph()`（L4238-4484）、工具注册表（L126-138）、预算常量（L111-115、L3980-3989） | P1-P3 |
| `public/app.js` | 工作台新增 Agent 泳道面板 + HITL 审核卡片 | P4 |
| `docs/PRD.md` | V0.3 小节加一行引用 → 本计划书 | 本次 |
| `scripts/agent-benchmark.js` | 扩展路由准确率 + handoff 计数 | P2-P4 |

### 需要新增

| 文件 | 用途 | 阶段 |
|---|---|---|
| `scripts/check-multi-agent-roles.js` | 校验 Agent 角色-工具映射 | P1 |
| `scripts/check-supervisor-routing.js` | 路由决策单元测试 | P2 |
| `scripts/check-hitl-resume.js` | HITL approve/edit/reject 三条路径测试 | P3 |

### 实现阶段再更新

| 文件 | 说明 |
|---|---|
| `docs/AGENT_RUNTIME_ARCHITECTURE.md` | 补充 supervisor + HITL 运行时描述 |
| `docs/HANDOVER.md` | 追加多 Agent 交接内容 |

---

## 8. 附录：当前系统关键行号索引（server.js）

| 组件 | 行号 |
|---|---|
| AGENT_TOOL_REGISTRY | ~L126 |
| 预算常量 | L111-115 |
| harness 预算状态 | L3980-3989 |
| StateGraph annotation | ~L4216 |
| createAgentGraph() | ~L4238 |
| 图节点 + addEdge | ~L4242-4484 |
| modelAdapter: resolveLlmEndpoint() | ~L3042 |
| modelAdapter: maybeCallOpenAI() | ~L3111 |
| /api/langgraph-resume | ~L5593 |

> 行号来源于探索阶段（2026-08-07），实际编码时请重新验证，server.js 可能已有增量修改。
