# 开发日志 (CHANGELOG)

> 本文件记录 AI Developer Onboarding Copilot 项目的开发历程。
> 仓库：`yuk1no4090/AI-PM`，分支：`main`

---

## 2026-08-27 — 路由相位改为显式通道 + HITL 门控扩至四个触发信号 + 安全反洗白加固

背景：同一天内五张任务卡按顺序合并，全部围绕 `lib/agent-graph.js` 的路由机制与 HITL 门控——先把路由相位算法从对 trace 长度记账的隐式依赖改造成显式通道（为后续信号扩展打地基），再把 Supervisor 的 `require_human_review`、输入/检索安全标记、QACritic 未解决的 revise 判决依次接入 HITL 门控（从一个触发信号扩至四个），期间穿插一次评审沉淀的卫生债清理。全程 `npm test` 保持绿。

- **路由相位改为显式 phaseCursor 通道**（`a5cd2b6`，Task N1，reviewer 发现并推动修复一处 BLOCKER）：`decideNextRoute` 此前用 `trace.length - revisionRound*4` 反推当前相位，依赖一条没有任何机制强制的不变式——修订环内 4 个节点必须无条件恰好各追加一条 trace 步，且 `revisionRound` 自增必须与 trace 追加落在同一次状态更新；未来给某节点加早退或多记一步都会让路由静默跳错相位。改为显式 `phaseCursor` 状态通道：9 个相位节点各自在自己的原子状态更新里声明后继相位，取值经 `nextPhaseCursor()` 从 `ROUTE_RULES.phaseMap` 单一事实源推导，不再手打数字；修订环回到 `retrieve` 时游标由节点自身声明而自然回卷，无跨轮次算术。**评审拦下的 BLOCKER（端到端复现）**：LangGraph 反序列化缺失通道时会套用 Annotation 默认值而非留空——pre-`phaseCursor` 的旧快照恢复出的 `cursor` 是合法整数 `0` 而非 `undefined`，时间旅行恢复会静默从 `input_safety` 重跑前 4 个阶段（trace 从 9 步变 13 步，4 个工具被重复执行）。修复：以「`cursor==0` 且 `trace` 非空」作判别式——这一组合在新代码下结构性不可达（任何相位节点跑完 `cursor≥1`，且该通道 reducer 是 `replace`、不会被清零），命中即说明是旧快照，按旧算术推导相位；旧快照本就是由维护旧不变式的旧代码写出，对其套用旧算术在结构上仍然正确。该迁移分支会随 `CHECKPOINT_MAX_RUNS`（默认 50）的保留窗口自然退役。回归测试（`check-hitl-resume-behavior.js` 新增 step 4b）：真实服务器 + `node:sqlite`，剥掉一条持久化快照的 `phaseCursor` 通道后做显式 `checkpointId` 时间旅行恢复，断言其 trace 与未剥离的对照组一致——红（旧代码：13 步含 4 个重复工具）→绿（修复后：9/9 零重复）有实测依据；reviewer 用原始攻击装置重放确认闭环，并反向探测判别式在新代码全部可达路径上不会误触发。放弃的旧契约：`decideNextRoute` 对缺 `trace` 的状态不再抛 `TypeError`（改按新鲜状态处理）——该行为本是旧相位算术的副产品，非有意设计。单测 159→169（新增解耦路由证明用例与 4 个迁移场景回归用例），check 脚本仍为 31。
- **Supervisor 的 `require_human_review` 接入 HITL 门控，第二触发信号**（`4eeb64d`，Task N2）：Supervisor 契约一直要求产出经 schema 强制校验的 `require_human_review` 布尔值，但此前没有任何代码消费它——HITL 门控只看 ImpactAnalyst 推导的 `riskLevel`，一个被生产、被校验、然后被忽略的字段是纯粹的架构负债。新增纯函数 `hitlReviewTriggers(state)` → `hitlReviewRequired(state)` → `describeHitlReason(triggers)` 作为路由与可观测性共用的单一事实源，两个信号 OR 语义；判断用严格 `=== true` 而非真值，防止状态中可能出现的旧的或外来 `plan` 对象里一个字符串 `"false"` 被误判为触发。暂停 payload 新增 `hitl.triggers` 数组并扩展 `hitl.reason`，运维一眼可见是哪个信号触发；SSE `hitl_paused` 事件同步携带（前端未动，新字段被安全忽略——已核实其处理器只读 `elapsed_ms`）。post-`human_review` 高风险短路守卫刻意不扩展：经专门单测证明（非假设），Supervisor 触发的中风险暂停恢复后经 phase 查表（`cursor=8`，决策已设为不再暂停）自然到达 `synthesize`；而 pre-N1 的旧快照只可能因高风险暂停（`require_human_review` 当时还不存在），短路守卫总是先行拦截——不为对称而改动不理解的守卫。修订环优先级不变：revise 分支（`cursor 7`）先于 HITL 门控（`cursor 8`）评估，不会打断进行中的修订。行为不变性：确定性计划下 `require_human_review` 与 `risk_hypothesis==="high"` 同源（同一套问题关键词正则），既有全部 HITL 测试的问题文本两信号本就重合，逐一审计确认无既有流程行为改变；金丝雀 fixture 前后 payload 逐字节对比仅新增观测字段。新增行为检查 `scripts/check-hitl-supervisor-trigger.js`：假 LLM 端点构造 `flag=true` + 分析风险 `medium` 的隔离场景，断言暂停且 `hitl.triggers` 精确等于 `["supervisor_flag"]`，并验证恢复；对照组 `flag=false` 断言不暂停。红→绿有据：门控回退后检查在预期断言处失败；reviewer 独立复现红→绿、4 项 mutation 全部被捕获，并验证对照组断言能捕获"永远暂停"的退化。已知边界（fast-follow 文档补充）：离线确定性回退下该信号是问题关键词启发式，非证据支撑——仅影响 `AGENT_HITL_ENABLED=true` 且无 API key 的部署。单测 169→184（+15），check 脚本 31→32（+1）。
- **评审沉淀的三条卫生债修复**（`aa6bfda`，Task N5）：(1) `stripComments()` 的除法/正则判别此前把 `+`/`-` 当普通标点处理，`x++` 之后的真除号被误判为正则候选，导致类似 `x++ / y // comment` 写法的行注释剥不掉（静默漏检）。修复为 `++`/`--` 双字符前瞻，按其出现前 `prevTokenAllowsDivision` 的取值判定是后缀（保持除法上下文）还是前缀（由随后的操作数自然重置）。红→绿有据：修复前 3 条新用例失败、2 条前缀对照本就通过（证明缺陷特定于后缀场景）；reviewer 加测无空格 `x++/*c*/`、maximal-munch `x+++y`、`f()++ / b` 等 9 组边角全部正确，且对现有代码库的剥离输出字节级不变（reviewer 独立复算哈希证实；worker 自报的哈希数字有误，但"字节级不变"这一结论本身为真）。(2) 温度环境变量解析此前先过一道严格十进制正则再 `Number()`——`"0x1"` 会被静默接受为 `1`；本次一并拒绝科学计数法这类操作者不会手写的异体字面量。已知取舍：`".5"`/`"+1"`/`"1."` 也随之被拒收、回落默认值，与既有"非法输入→默认"路径一致。(3) `check-hitl-resume-behavior.js` 的 `trace_steps===4` 检查点选择器补上防复用注释：当前 fixture 无修订环，取首个匹配无歧义，但原样复制到会修订的 fixture 上会选错检查点。单测 184→197（+13），check 脚本仍为 32。禁改文件（scope 外文件）零触碰。
- **安全标记接入 HITL 门控，第三触发信号**（`7ac0ffa`，Task N3）：安全层（`lib/safety.js` + `SAFETY_POLICY`）此前只有检测没有后果——`decideNextRoute` 从不读安全状态，被标记的问题会跑完整个工作流、答案照常产出，唯二效果是跳过记忆学习与 Supervisor 的 LLM 规划调用。新增触发字面量 `input_safety_flag` / `retrieved_safety_flag`（严格 `=== "needs_review"`），经 N2 的 `hitlReviewTriggers` 单一事实源扩展，路由与可观测性（`hitl.triggers`、`reason` 携带具体 `risk_types`）同源。`outputSafety` 有意排除在外（在 `synthesize` 内计算，晚于门控时点），并用负向断言钉死这一排除，防止未来"顺手接上"造成一个永不生效的假门控。批准不洗白标记：`[HITL APPROVED]` 之后 `safety.status` 仍为 `needs_review`、`risk_types` 保留——审批评审的是这次运行，不是给内容开脱敏豁免。默认配置（HITL 关闭）行为完全惰性，reviewer 用真实恶意仓库 + 门控关闭验证 payload 字节形状不变。新增行为检查 `scripts/check-hitl-safety-trigger.js`（离线，无需 fake LLM——安全检测本就是确定性正则）：注入问题暂停且 `triggers` 精确等于 `["input_safety_flag"]`、批准/拒绝两路、门控关闭对照、良性问题对照。**隔离触发信号时的意外发现**：内置示例项目在结构上不可能为任何问题产出非 `high` 的风险等级——`expand_context` 的固定拓宽查询词会把高风险文件拖进每一次检索——因此改用词汇不相交的自建 zip fixture 才能把新触发信号从既有的 `high_risk` 信号中隔离出来。评审（独立复现红→绿与 3 项 mutation、自建恶意仓库实测确认间接注入确实会暂停）判 PASS，并确认两项非阻塞跟进（推进到下一张卡处理）：`retrievedSafety` 的 `replace` 语义让修订环第二轮的干净扫描可以覆盖第一轮的 `needs_review`——洗白窗口真实存在（与 `riskLevel` 同模式，是既有架构弱点的延伸，非本卡引入）；以及 `retrieved_safety_flag` 当时仅有单元级覆盖，还需要补一个服务器级行为场景。文档同步补上三信号触发列表（中英一致）与"确定性模式下安全信号是关键词启发式而非证据支撑"的边界说明。单测 197→211（+14），check 脚本 32→33（+1）。
- **安全门控加固：QACritic 获得阻断权 + retrievedSafety 反洗白 + 间接注入行为覆盖**（`2dc8c9e`，Task N4）：三项同主题加固，核心是"门控不可被时序或运气绕过"。(1) `critic_flag` 第四触发信号：修订环收敛（critic 在后续轮次判 approve）不暂停，但预算耗尽后 critic 仍判 `revise` 时——管线即将交付一个批判者自己仍拒绝的答案——此刻暂停待人裁决。谓词是修订环继续条件的精确逻辑否定（`verdict==="revise" && revisionRound >= AGENT_MAX_REVISION_ROUNDS`），且两者分别在 `phaseCursor` 的 7 和 8 两个不同时点求值，结构上不可能同时成立。刻意不按发现严重度触发——确定性 critic 对任何无引用区域都会例行产出高严重度发现，在离线 fixture 上很常见，按严重度触发会让几乎每个退化的离线运行都暂停。评审做了穷尽边界扫描：`max` 取 0/1/2 各档、轮数越界、`verdict` 缺失/`approve`、决策已设为不再暂停，全部正确。(2) `retrievedSafety` 反洗白：reducer 由 `replace` 改为 `mergeRetrievedSafety`——`status` 只能从 `passed` 升到 `needs_review`，不能反向；`risk_types`/`flagged_*` 是跨写入的集合并集而非替换；`checks` 等字段按同一升级规则合并，不让任何字段与 `status`/`risk_types` 矛盾。`riskLevel` 有意保持 `replace` 语义并在文档写明区别：ImpactAnalyst 逐轮重估风险是合法的判断更新（修订环存在目的之一），不是洗白；`retrievedSafety` 记录的是一个已经发生过的事件（恶意/敏感内容确实进入过这次运行的检索上下文），不会因后一轮更干净的扫描而"没发生过"。图级测试编译并运行一个用生产同款 `createGraphStateAnnotation()` 工厂构建的真实 `StateGraph`，证明 reducer 被正确接线进生产通道定义，不只是裸函数正确；评审用 mutation 证实：只回退 reducer 时纯函数测试全线通过，但图级测试会失败——证明图级测试层次有独立价值。(3) 间接注入行为覆盖（Scenario 4）：恶意内容仓库 + 良性问题 → 暂停，`triggers` 精确等于 `["retrieved_safety_flag"]`。隔离构造：被标记内容本身就是被引用的证据，critic 立即通过，`critic_flag` 不会并发触发；注入短语在检查脚本内于运行时由多个各自无害的词面量拼装而成，源码中不存在连续的字面量。**fixture 交互审计**：逐一核对新触发器对既有 HITL fixture 的影响——Scenario 1 的期望如实改为 `["input_safety_flag","critic_flag"]`（其空检索 fixture 永远不会收敛）；Scenario 3 的阴性对照换用一个真正能收敛的 fixture（旧对照被新触发器打破，是替换而非弱化断言）；其余 5 个 HITL fixture 不受影响（critic 均在首轮通过）。评审 PASS：互斥谓词边界全扫、消费者形状兼容性审计、3 项 mutation 在静态 pin/单测/行为断言三层分别被捕获、全部既有行为检查逐个重新跑通。一项 MINOR fast-follow：`docs/AGENT_RUNTIME_ARCHITECTURE.md` 反洗白小节的 round-robin 次要论证被 reviewer 用实验证伪——对 rank 2+ 不成立（主论证——固定拓宽查询每轮重新拉取——实验证实成立），措辞收紧留给了专门的文档卡（即本条日志所在的这次文档补账，已同步收紧）。单测 211→231（+20），check 脚本仍为 33。
- **测试**：五张卡累计把 `node:test` 单元测试从 159 推进到 231（净增 72），`scripts/check-*.js` 静态检查脚本从 31 增至 33（两次新增均来自新的 HITL 触发行为检查）。`npm test` 全量保持绿；离线/无 API key 路径行为在每一张卡落地后都被显式验证为不变。

---

## 2026-08-25 — 文档全量校准：过期计数、Mermaid 路由图与运维环境变量

背景：四批功能改动（三模型 Agent 编排、HITL 原生 interrupt 恢复 + 有界修订环 + SSE 进度流、分角色模型选择，均见下文）落地后，文档只被各自的任务卡部分更新，多处仍在陈述已不存在的数字与架构。本次为纯文档准确性工作（`8f86ded`），无任何行为变更。

- **计数修正**（均在工作区实测推导，非估算）：单测数量 100/134 → 159（`node --test` 实跑）；测试文件数确认为 11；静态检查门禁 27 → 31（`ls` 计数 + `static-checks.js` 输出核对）；`lib/` 模块 12 → 13；`server.js` 约 1550 行（`wc -l` = 1552）；黑盒测试套件重新数过仍是 9 套（package.json 的 `test` 链），但 README 的测试命令清单此前漏列了 `npm run test:mcp`，已补；`docs/assets/banner.svg` 的质量行同步（新旧字符串同为 77 字符，渲染宽度不变）。
- **架构描述修正**：修掉一处真实的图错——README 的 Mermaid 图此前画的是 HITL `approve`→Guardrails、`reject`→Stop 两条不同的路径，但 `decideNextRoute` 对两种决策都无条件路由到 `synthesize`；Mermaid 图与两份 README 的 ASCII 管线同步修正。工作流图补上 QACritic revise 有界环及其重入点。`/api/langgraph-resume` 此前的文档只描述了 2 种恢复模式，README 中英文、`USER_GUIDE`、`OPERATIONS` 均缺 `native_interrupt_resume`，已补齐三选一。`USER_GUIDE` 的流程列表中 `human_review` 仍排在 QACritic 之前（2026-08-23 之前的旧序），已改正并补上修订环分支。`OPERATIONS` 环境变量表补上 `OPENAI_MODEL_*` / `OPENAI_TEMPERATURE_*` / `AGENT_MAX_REVISION_ROUNDS`；README 运行时配置表补上 `LLM_REQUEST_TIMEOUT_MS` / `CHECKPOINT_MAX_RUNS` / `STORE_MAX_*`。`docs/AGENT_RUNTIME_ARCHITECTURE.md` 的 "What's New (2026-08-07)" 标题下此前挂着被历次改动原地重写成后来能力、但日期从未更新的条目，改为日期区间并为每条标注真实落地日期。
- **措辞校准**：修订环相关表述与 `AGENT_RUNTIME_ARCHITECTURE.md` 既有的 "does and does not prove" 一节保持一致——检查证明的是机制（图上确实发生环、`additional_queries` 确实进入下一轮检索、循环在预算内终止），不声称普遍提升答案质量；离线确定性 critic 仅在影响区域完全为空时才触发 revise。全文未新增任何成本/延迟/质量提升的声明。
- **未改动**：`docs/CHANGELOG.md` 的历史条目（带日期的当时事实叙述，非现状声明）；`docs/HANDOVER.md`（头部已声明冻结于 `41bc3a1`）；`PRD.md` 与 `MULTI_AGENT_PLAN.md`（检查后确认无过期现状声明）。
- **评审**：reviewer 独立重新推导全部数字、逐条核对环境变量名与默认值、对照源码验证三种恢复模式与路由逻辑、对新增行做性能宣称关键词扫描——零事实错误，中英文实质一致。

---

## 2026-08-25 — HITL 原生 interrupt 恢复 + 有界 QACritic revise 环 + 节点级 SSE 进度流

背景：在三模型 Agent 编排（2026-08-23）落地之后、分角色模型选择（见下一条）之前，同一天内还有三张任务卡按顺序合并：HITL 升级为 LangGraph 原生 interrupt/Command 恢复、QACritic revise 驱动的有界修订环 + 逐查询检索、以及 `/api/agent-impact` 的节点级 SSE 进度流。三者都直接修改了 `lib/agent-graph.js` 的路由与执行边界，故合并记录为一条日志。

- **HITL 升级为 LangGraph 原生 interrupt/Command 恢复**（`a7f1db3`，merge `3dd9c5e`，reviewer 三轮通过）：`human_review` 节点从"设置一个暂停标记、图仍继续跑"的软暂停，升级为调用 LangGraph 真正的 `interrupt()`——执行确实停在该节点，state 冻结进 checkpoint，`graph.invoke()` 带着 `__interrupt__` 返回而不是 `finalPayload`。决策恢复不再是把整张图从 phase 0 重跑一遍，而是新增 `native_interrupt_resume` 模式：把持久化的 checkpoint payload 克隆进新的 harness run 线程，用 `new Command({ resume: decision })` 直接恢复到同一次暂停的执行，只重跑 `human_review` 和 `synthesize` 两个节点。原有的 `checkpoint_continuation`（未提供 decision 时原样重放暂停状态）与 `input_snapshot_reexecution`（checkpoint payload 已被保留窗口裁剪时的兜底）保持不变，`harness.resume.mode` 现在三选一如实上报。副带修复：`stripComments()` 补上正则字面量识别与逐文件隔离（此前跨文件状态可能残留注释误判），消灭了因此产生的静态断言重言式。
- **QACritic revise 驱动的有界修订环 + 逐查询检索**（`5966d04`/`53e65e7`/`f7cf15e`，reviewer 两轮，均以仓外副本独立复现问题）：图此前是纯线性管道，QACritic 早就会产出 `verdict` 和 `additional_queries`，但两者都是死数据——没有代码读它们、更没有代码据此改变路由。本次让 `qa_plan` 返回 `verdict="revise"` 时真的回到 `retrieve` 再走一轮 `retrieve→expand_context→impact_analysis→qa_plan`，把 critic 自己提出的 `additional_queries` 喂进下一轮检索；轮数由 `AGENT_MAX_REVISION_ROUNDS`（默认 `1`，设为 `0` 关闭）限界。`retrieve` 节点同时改为逐查询检索（原问题 + Supervisor 的 `retrieval_queries` + revise 轮的 `additional_queries` 分别独立检索，按 round-robin 交错合并、去重，而不是拼成一个字符串再检索一次）。因为 supervisor-hub 拓扑下每个业务节点都要经停 supervisor 一次，一次 9 阶段走位已经消耗约 19 个 LangGraph superstep，每轮 revise 再加约 8 个，遂新增 `computeGraphRecursionLimit()` 让 LangGraph 自己的 `recursionLimit` 与 `budget_status.step_budget_exceeded` 的判断基准都跟随 `AGENT_MAX_REVISION_ROUNDS` 缩放，避免用满修订预算的健康请求被误判为超出递归上限或步数预算。**诚实边界**：`scripts/check-revise-loop.js` 证明的是机制——图上确实发生了环、`additional_queries` 确实进入了下一轮检索、循环确实会在预算内终止；离线确定性 critic 只有在 `impact_areas` 完全为空时才会返回 `revise`，因此该脚本无法、也不声称证明修订轮能普遍提升引用覆盖率（详见 `docs/AGENT_RUNTIME_ARCHITECTURE.md` 的 "does and does not prove" 一节）。评审首轮曾抓到 `recursionLimit` 挂错了自变量（跟着 `AGENT_MAX_STEPS` 而不是修订轮数），`AGENT_MAX_REVISION_ROUNDS=3` 时会实测触发 LangGraph 递归上限错误、整份多 Agent 分析被丢弃退回确定性兜底；修复后新增 `scripts/check-recursion-limit-scaling.js`（轮数 0/1/2/3 全覆盖）与 `scripts/check-revise-hitl-cross.js`（用本地 fake OpenAI 兼容端点证明 revise 环与 L1 的 HITL 暂停能在同一个 `decideNextRoute`/持久化 state 上正确组合）。
- **节点级 SSE 进度流**（`ec0b9ea`/`39daf46`，reviewer 两轮，含真实浏览器验证与 TTFB 探测）：新增 `POST /api/agent-impact/stream`，原有 `POST /api/agent-impact` 字节级不变（`mcp-server.js` 和既有测试继续只走原路由）。两个路由共用同一份 `runAgenticImpactWorkflow()` 实现——不传 `onEvent` 时仍调用 `graph.invoke()`，传了才改用 `graph.stream(graphInput, { streamMode: ["updates", "values"] })`；图跑完之后的 checkpoint 落库、`isInterrupted()` 处理、兜底 fallback、`buildAgentHarnessReport()`、脱敏和最终 payload 全部共享，因此两个端点在剔除 `run_id`/时间戳等易变字段后必须深度相等，由 `scripts/check-agent-impact-stream.js` 离线断言。事件顺序为 `workflow_started` → 每个真实节点一条 `node_completed` → 有 revise 轮时每轮一条 `revise_round_entered` → 若触发 HITL 暂停则一条 `hitl_paused` → 最终一条 `final`（与非流式响应体同形状）。客户端断开连接会通过既有超时机制复用的同一个 `AbortController` 中止底层 LangGraph 运行，并在提交前检查连接是否已断开，避免中止的运行残留半条答案记录。鉴权与其余路由一致走 `Authorization` 头，不使用无法带自定义头的浏览器 `EventSource`、也不把 token 放进 query string。**评审返修**：首轮曾把新路由的 pathname 判断从字面量改成标识符常量派发，使其绕过了 `check-api-docs.js` 的文档同步 grep（属于"写代码专门躲开检查"的阻塞项），复审要求撤销并改回字面量派发，同时把该路由补进 README/README.zh-CN/USER_GUIDE 的路由表（检查覆盖路由数 26→27）；另补了锚定首个 `node_completed`（而非天然最先发出、因此不具区分力的 `workflow_started`）的时序断言，防止实现退化成"算完再一次性刷送"。
- **测试**：这三张卡落地后，`node:test` 单元测试数量为 134（HITL 卡新增路由/恢复相关用例，revise 与 streaming 两卡均未新增 `test/` 用例，只新增了对应的 `scripts/check-*.js` 集成检查），`scripts/check-*.js` 静态检查脚本数量 27 → 30（revise 卡新增 3 个）→ 31（streaming 卡新增 1 个）。`npm test` 全量保持绿；离线/无 API key 路径行为不变。

---

## 2026-08-25 — 分角色模型选择：三个 Agent 可独立配置模型

背景：三个模型驱动 Agent（Supervisor、ImpactAnalyst、QACritic）此前共用 `lib/llm.js` 的单一全局 `resolveLlmModel()`（`OPENAI_MODEL` 或默认 `gpt-4o-mini`），尽管三者的 prompt、输出 schema 和职责完全独立——Supervisor 输出简短结构化计划，QACritic 做有界判断，ImpactAnalyst 承担重度仓库推理。本轮让模型（以及可选的采样温度）成为按角色可独立配置的项，把“三个 Agent”从命名约定变成真正可调的架构决策。

- **按角色环境变量**：新增 `OPENAI_MODEL_SUPERVISOR` / `OPENAI_MODEL_IMPACT_ANALYST` / `OPENAI_MODEL_QA_CRITIC`，解析顺序为「角色专属变量 → 共享 `OPENAI_MODEL` → 硬编码默认值」。角色到环境变量的映射是以 `lib/agent-contracts.js` 中导出的 `SUPERVISOR_AGENT.role`/`IMPACT_ANALYST_AGENT.role`/`QA_CRITIC_AGENT.role` 为键的显式查找表，不是对 `agent.role` 字符串做拼接/变形——未知或被改名的角色会直接落回共享解析路径，而不会读到拼错的变量或报错。空字符串/纯空白的环境变量按未设置处理。非 Agent 的 `/api/chat` 路径（`runModelAdapter`）继续调用原有的 `resolveLlmModel()`，不受影响。
- **按角色采样温度（可选）**：`temperature` 之前对所有调用硬编码为 `0.2`；现在新增 `OPENAI_TEMPERATURE` / `OPENAI_TEMPERATURE_SUPERVISOR` / `OPENAI_TEMPERATURE_IMPACT_ANALYST` / `OPENAI_TEMPERATURE_QA_CRITIC`，解析顺序、未知角色回退、空白值处理均与模型完全一致；无效数值（非数字、超出 `[0, 2]`）按未设置处理，绝不会把 `NaN` 发给 provider。
- **可观测性修复**：`buildModelAdapterResult()`（`lib/llm.js`）此前无论调用哪个角色，事件里的 `model` 字段都重新调用全局 `resolveLlmModel()`——这意味着 `harness.model_calls[].model` 即使三个角色配置了不同模型，也会全部显示成同一个全局值。现在 `maybeCallOpenAI()` 把它实际解析并发送给 provider 的 `model`/`temperature` 一路带回到 `modelCall`，`buildModelAdapterResult()` 直接使用这个值，使 `model_calls[]` 逐条如实反映每个角色实际使用的模型。`buildAgentHarnessReport()` 新增 `harness.model_config`，按角色展示当前生效的模型/温度，以及是角色专属覆盖还是继承共享默认值——独立于这条请求本身是否调用了该角色。
- **诚实的收益表述**：文档只声明「按角色可配置、可观测」，不声明任何成本或延迟节省——本仓库的所有测试都离线运行，没有测量任何真实调用的成本或延迟。README、README.zh-CN、`docs/USER_GUIDE.md`、`docs/AGENT_RUNTIME_ARCHITECTURE.md` 同步更新新增的环境变量与用途说明。
- **回归修复（review 中发现）**：`normalizeHarnessRun()` 逐字段规范化 `model_calls[]` 时，最初把 `temperature` 按其余数值字段的既有写法处理（`Number.isFinite(Number(x)) ? Number(x) : fallback`）；但 `temperature` 语义上是可空的（离线/无 API key 路径下为 `null`，而 `0` 本身又是合法配置值），而 `Number(null) === 0`，会把持久化的离线运行悄悄写成 `temperature: 0`。改为 `typeof call.temperature === "number"` 判断，null 与合法的 0 都被正确保留，并补了三条针对性回归测试。
- **测试**：新增 `test/llm-model-config.test.js`（25 条 `node:test` 单元测试）覆盖解析优先级、空白值、越界温度、未知角色回退、`normalizeHarnessRun` 的 null/0 温度回归，以及一个使用本地假 OpenAI-compatible 端点的集成性断言——证明 Supervisor/ImpactAnalyst/QACritic 三个角色各自把配置的模型/温度真正发进了请求体，且 `runAgentModelAdapter()` 返回的 event（`buildAgentHarnessReport()` 逐字段拷贝进 `harness.model_calls[]` 的正是这个 event）如实携带角色专属模型。`npm test` 全量保持绿：31 个静态检查脚本、159 条 `node:test` 单元测试（134 条既有 + 25 条新增），以及 smoke、UI、安全红队、记忆压缩、用户记忆隔离、认证、embedding provider、benchmark、MCP 全部通过；离线/无 API key 路径行为不变。

---

## 2026-08-23 — 从角色标签升级为三模型 Agent 编排 + PRD 口径校正

背景：此前 LangGraph 虽然为多个节点标注了 `agent_role`，但影响分析主链只有一次真正的 LLM 调用，其余大多是确定性函数。严格来说，这是“单模型 Agent + 多角色工具节点”，不能充分支撑“多 Agent 编排”的产品表述。本轮按真实执行边界完成最小多 Agent 升级，并同步修正 PRD、README 和架构文档。

- **三个独立模型 Agent**：新增 `lib/agent-contracts.js`，分别定义 Supervisor、ImpactAnalyst、QACritic 的独立 prompt、输出 schema、校验器、证据约束和确定性 fallback。三个角色各自产生一次可审计的模型调用；它们默认可以共用同一个 provider/model，因此这里的“三模型 Agent”指三个独立的 model-backed agent calls，不等于强制使用三个不同基础模型。
- **Supervisor**：在输入安全检查后理解改动意图，生成风险假设、必须参与的专家、1-4 条仓库检索查询和 HITL 建议。检索节点把 Supervisor 计划合并进查询，使计划实际影响 RAG，而不是只作为展示字段。
- **ImpactAnalyst**：读取 Supervisor 计划和检索到的仓库证据，独立生成带文件引用的影响范围、风险等级、测试建议和开放问题。
- **QACritic**：使用不同于 ImpactAnalyst 的 prompt/schema 独立复核引用、证据缺口、遗漏范围和回归测试建议；不存在于当前仓库的引用会被约束移除，复核建议经过去重后合并回最终影响分析。为兼容既有 checkpoint，LangGraph node 名仍保留 `qa_plan`，但执行角色和工具已改为 QACritic。
- **Agent 与工具边界校正**：只有 Supervisor、ImpactAnalyst、QACritic 被定义为模型 Agent。SafetyGuard、MemoryCurator、Classifier、Retriever、OnboardingPlanner、Synthesizer、Harness 保持为确定性角色、工具节点或基础设施，不再因为出现在 StateGraph 中就被描述成独立 Agent。
- **LangGraph/HITL 顺序**：共享 state 新增 `supervisorPlan`、`qaReview` 和逐角色模型事件；高风险 HITL 从 ImpactAnalyst 后移到 QACritic 和输出 guardrails 之后，保证人工审核看到的是已经独立复核和安全检查过的结果。`harness.model_calls` 逐项记录角色、模型、耗时、schema、fallback 和 token 估算，兼容字段 `harness.model_adapter` 继续汇总 ImpactAnalyst。
- **前端和评估指标**：Agent 技术详情新增 Supervisor 执行计划、QACritic 独立复核和 Model Agent Calls；Dashboard 新增完整三 Agent 运行数、模型 Agent 调用总数、成功/fallback 调用数和角色分布。
- **配置可靠性修复**：`.env` 加载器改为只在环境变量确实不存在时写入，显式传入 `OPENAI_API_KEY=""` 不再被 `.env` 中的值覆盖，确保离线/fallback 测试和部署覆盖行为可预测。
- **文档同步**：更新 `docs/PRD.md`、`docs/AGENT_RUNTIME_ARCHITECTURE.md`、`docs/MULTI_AGENT_PLAN.md`、`docs/USER_GUIDE.md`、`docs/HANDOVER.md`、中英文 README 和定位文档，统一三 Agent 与确定性工具节点的口径。
- **测试**：新增 Agent contract 单元测试并扩展 fake OpenAI-compatible smoke server，使其按角色返回不同 schema，断言一次影响分析按 `Supervisor → ImpactAnalyst → QACritic` 产生 3 次独立调用。最终 `npm test` 全量通过：27 个静态检查脚本、100 条 `node:test` 单元测试，以及 smoke、UI、安全红队、记忆压缩、用户记忆隔离、认证、embedding provider、benchmark、MCP 全部通过。

---

## 2026-08-18 下午 — 影响简报 briefing + 无界增长治理 + 看板故事化 + 写锁粒度收窄

本轮同样由多个 worker agent 在独立分支/worktree 并行完成，逐一经 reviewer 审核通过后合并（`A`/`G`/`B`/`D`），全程 `npm test` 保持全绿。

### A — 影响分析新增 PM/QA 业务简报 briefing（`d6693a9`，merge `8bb2cad`，reviewer 通过，零阻塞）

- `lib/answers.js` 新增 `buildImpactBriefing(impactAreas)`：纯规则确定性构建器，从 `impact_areas` 推出 `{ summary, affected_flows, testing_focus, risk_note }`。两层映射识别业务流程——`BUSINESS_FLOW_RULES` 先按文件路径关键词识别具体业务域（如 `auth` → "Login & permissions"），命中不了再用 `AREA_FLOW_FALLBACK` 按技术层兜底。
- **开发中发现的 bug**：最初设计打算用带 `\b` 单词边界的正则做关键词匹配，但真实文件名常见 `authService.ts`/`userController.ts` 这类驼峰拼接——`\bauth\b` 这种边界锚点在 `"auth"` 和紧跟着的大写字母之间没有单词边界，会完全匹配不上。改为子串匹配（沿用本文件 `generateImpactAnswer` 里 `areaRules` 的既有写法）并补了测试覆盖这一场景。
- `applyPreferencesToImpact()` 新增兜底：LLM 提供的 `briefing` 形状合法则保留，否则（旧数据/LLM 未提供/形状不合法）从最终 `impact_areas` 确定性重建，保证 `/api/chat` 与 `lib/agent-graph.js` 的 agent 工作流两条路径产出的 impact payload 都一定带一份可用的 briefing；`validateImpactPayload()` 新增可选校验（不带 briefing 不算 schema 违规，带了就必须形状合法）。`lib/llm.js` 的 schema 指令同步追加 briefing 完整形状声明。
- 前端 `public/app.js` 新增 `renderImpactBriefing()`，置顶渲染业务叙事；原技术清单（agent 元信息/trace/impact_areas/引用/测试建议/开放问题）收进 `<details class="tech-details">` 折叠区，旧数据（无 briefing）逐字节回退原始铺开渲染。
- 新增 `test/briefing.test.js`（25 例），`npm test` 全量通过。

### G — 无界增长治理：store 上限裁剪 + checkpoint 保留窗口（`ce83b60`，merge `e05915c`，reviewer 通过，零阻塞）

- `store.json` 的 `questions`/`answers`/`harnessRuns`/`memoryEvents` 此前只增不减，SQLite 的 `langgraph_checkpoints`/`langgraph_checkpoint_payloads` 每次 persist 都写入一份 base64 全量快照且从不清理，长期运行会无界膨胀。
- `lib/config.js` 新增 `STORE_MAX_QUESTIONS`/`STORE_MAX_ANSWERS`（默认 500）、`STORE_MAX_HARNESS_RUNS`/`STORE_MAX_MEMORY_EVENTS`（默认 200）、`CHECKPOINT_MAX_RUNS`（默认 50），均可通过同名环境变量覆盖。`lib/store.js` 的 `normalizeStore()` 按时间序裁剪，并过滤引用了已被裁掉的 answer 的孤儿 feedback 记录；`lib/checkpoints.js` 新增 `pruneOldLangGraphCheckpointRuns()`，按 run 维度只保留最近 `CHECKPOINT_MAX_RUNS` 个 run 的快照。
- 新增 `test/limits.test.js`（10 例），`npm test` 全绿连跑两遍。

### B — 评估看板故事化：质量摘要 + 四组重排 + 评估体系说明卡（`502d0bf`，merge `4b83b0e`，reviewer 通过，零阻塞）

- 看板顶部新增「质量摘要」区，从 `computeMetrics` 既有字段拼出 en/zh 自然语言结论；原来铺开的 14 张数字卡片 + 20 个排行/事件面板按叙事重组为「可信度」「安全」「可靠性」「使用与反馈」四个小节；尾部新增「评估体系」折叠说明卡（复用 A 卡 briefing 引入的 `<details class="tech-details">` 模式）。纯前端重组，`lib/metrics.js` 字段不增不减。

### D — 写锁粒度收窄至 store 临界区 + LangGraph 超时取消（`b9f3a64` + `a0c7b43`，merge `0e236a5`，reviewer 两轮通过）

- 背景：`handleApi()` 曾把整个请求处理（含 4 个重路由 30 秒级的 LLM/LangGraph 调用）串行化在一个全局 `withWriteLock` 里，一个慢请求会阻塞所有其他 POST（及 `AUTH_REQUIRED` 下的所有 GET）；`withWorkflowTimeout` 超时返回 fallback 后也不取消底层 `graph.invoke`。首轮改造把 4 个重路由改为「短 gate 锁（store 初始化 + 鉴权审计）→ 锁外检索/LLM/LangGraph 计算 → 短 commit 锁（重新校验项目仍存在 + 写入）」，并给 `withWorkflowTimeout` 加了可选 `AbortController`，超时时先 `abort()` 再 `reject`。
- **首轮评审 BLOCK**：reviewer 发现锁粒度收窄后，4 条重路由的锁外计算阶段仍存在两处隐藏 store 写入，与并发请求竞态——(1) `getUserPreferences()` 首次访问某 `userId` 时会惰性写入 `store.userPreferencesByUser[userId]`，命中 `/api/chat`、`createMemorySuggestions()`、agent-graph 的 memory 节点等全部 4 条重路由；(2) 4 条重路由体内第二次调用 `resolveAuthenticatedUserId` 发生在 gate 锁释放后，对 store-backed token 会再次在锁外写 `tokenRecord.lastUsedAt`。
- 修复（`a0c7b43`）：`getUserPreferences()` 改为纯读——缺项直接返回规范化默认值，不再回写 store，`setUserPreferences()` 保持是唯一写入点；新增 `resolveHeavyRouteUserId(req, body)`（无 `store` 参数，结构上不可能碰 store）复用 gate 锁内 `requireAuthScope` 已解析的 `req.auth`，只在锁外做一致性校验，不再重新派生身份写 `lastUsedAt`。新增 `test/preferences.test.js`（7 例，断言调用前后 store 序列化完全一致）与 `scripts/check-store-schema.js` 结构性回归门禁后，二轮评审通过。
- 并发验证（`scripts/concurrency-smoke.js`，手动运行）：重构前旧代码下，轻量 `POST /api/onboarding` 被并发的慢 `/api/agent-impact` 阻塞约 **2854ms**；修复后锁粒度收益仍在，`light_post_onboarding_ms≈9ms`（< 10ms）。
- `npm test` 全量（10 个子命令）连跑两遍，退出码均为 0；`node --test "test/**/*.js"` 80/80 通过。

### 已知跟进项（非阻塞）

- **G × D 叠加下高并发时 HITL checkpoint 可能被保留窗口裁剪**：G 卡的 `pruneOldLangGraphCheckpointRuns()` 按 run 维度只保留最近 `CHECKPOINT_MAX_RUNS`（默认 50）个 run；D 卡把重路由的计算阶段移到锁外、耗时可达 30 秒级。如果同一时间窗口内有 `CHECKPOINT_MAX_RUNS` 个以上其他 run 持续写入 checkpoint，一个已暂停等待人工审核（`human_review`）的高风险 run 理论上可能在被 resume 之前就被裁剪出保留窗口。当前无自动豁免机制，缓解手段是调大环境变量 `CHECKPOINT_MAX_RUNS`。
- **LLM fetch 在 abort 后仍有一个受 `LLM_REQUEST_TIMEOUT_MS` 约束的残余窗口**：D 卡的 `runAgenticImpactWorkflow()` 超时会 `abort()` LangGraph 的 `graph.invoke()`（pregel loop 原生支持 `config.signal`，当前 in-flight 节点结束后立即停止调度后续 superstep），但 `lib/llm.js` 单个 LLM fetch 自身的 `AbortController` 未接入这个外部 signal，仍受自己的 `LLM_REQUEST_TIMEOUT_MS` 约束——已在途的那一次 LLM 调用可能跑满自己的超时窗口才真正终止。这是有限、已知的残留窗口，而非无界的后台执行。

---

## 2026-08-18 — 品牌定名 Repomentor + Live Demo 上线 + LLM schema 校验修复

背景：项目对外可见度提升（README 作品集化、MCP Server 上线）后统一品牌名称，避免仓库/文档里新旧命名混用；同时产品已部署上线，README 补充可直接访问的 live demo 链接。

- **品牌统一为 Repomentor**（2026-08-18 定名，品类仍为 AI Developer Onboarding Copilot）：GitHub 仓库从 `yuk1no4090/AI-PM` 更名为 [`yuk1no4090/Repomentor.git`](https://github.com/yuk1no4090/Repomentor)；同步改名的位置包括 README.md / README.zh-CN.md 的 H1、`docs/assets/banner.svg` 的 `aria-label` 与标题文字、`public/index.html` 的 `<title>`、`package.json`（及 `package-lock.json`）的 `name`、`mcp-server.js` 里 MCP `serverInfo.name`（连带同步 `scripts/mcp-server-test.js` 的期望断言）；`docs/POSITIONING.md`、`docs/PRD.md` 第 15 节各补充一行命名说明。
- **Live Demo 上线**：README.md / README.zh-CN.md 横幅图下方新增一行，指向已部署实例 https://pm.yuk1no4090.site 与作品集主页 https://yuk1no4090.site。
- **LLM schema 校验修复**（`bd73106`，见 `git log d930949..main`）：`lib/llm.js` 给模型的 schema 指令此前只列字段名、未说明形状，DeepSeek 等模型把 `related_files` 返回成裸路径字符串数组，被 `lib/answers.js` 的严格校验判定为 `LLM_SCHEMA_INVALID` 并整份丢弃、静默退回确定性检索答案——尽管 API 调用本身成功。改为在 prompt 指令里写出完整 JSON 形状，并点明两条最容易猜错的约束（`related_files` 条目不能是裸路径字符串、`risk_level` 只能取 low/medium/high 枚举）。

---

## 2026-08-14 — README 作品集化：定位头部 + Mermaid 架构图 + 双语重排

背景：本仓库是公开的求职作品集，面试官平均停留 2 分钟，但原 README（英文 310 行/中文对应镜像）是纯运维手册结构（Run/Test/Config/Docker/MCP/Notes/Features/Architecture/API），前 50 行看不出"这是什么、为什么值得看、质量如何"。本轮改造把定位信息前置，内容全部保留、只做移位与新增。

- README.md / README.zh-CN.md 顶部新增头部区块：一句话定位 + 2 句问题陈述（口径取自 [docs/POSITIONING.md](docs/POSITIONING.md) 与 [docs/PRD.md](docs/PRD.md) 第 15 节，未发明新定位）、4 条亮点（LangGraph 多 Agent 编排/supervisor 路由/HITL/checkpoint 续跑；面向 PM/QA 的改动影响简报；产品内置 AI 质量看板；MCP Server 4 tools）、一行经核实的质量证据（41 条 `node:test` 单测、25 项静态检查门禁、9 套运行时黑盒测试套件、无需 API key 端到端运行）、指向 POSITIONING/AGENT_RUNTIME_ARCHITECTURE/PRD/CHANGELOG 的导航行。
- 新增「Architecture」（中文「架构」）小节，含两张 GitHub 原生渲染的 Mermaid 图：一张按 `server.js` 路由层 → `lib/` 12 模块（config/存储/领域三组）→ 数据层（`data/store.json`/`data/memory.sqlite`）分层，事实来源为 [docs/AGENT_RUNTIME_ARCHITECTURE.md 的 Code Organization 小节](docs/AGENT_RUNTIME_ARCHITECTURE.md#code-organization)；另一张为简化版 Agent 工作流图（分类 → 检索 → 影响分析 → 安全护栏 → 合成），标出高风险变更触发 HITL（`human_review` 暂停、经 `POST /api/langgraph-resume` 续跑）与 checkpoint（MemorySaver → SQLite `langgraph_checkpoints`）的位置。
- 正文重排为：定位/亮点/架构图 → Quick Start（原 Run 小节改名，追加"无需 API key + 3 个可选环境变量"提示）→ Features（原 Current MVP Features 改名）→ MCP Server → Operations & Reference（完整 Test/Runtime Configuration/Docker Deployment/Notes/Agent Runtime Architecture/API Surface 原样顺延后移，仅移位不删减）。
- 改造前逐条提取了 `scripts/check-api-docs.js`、`check-runtime-deps.js`、`check-architecture-docs.js`、`check-operations-docs.js`、`check-agent-benchmark.js`、`check-agent-contract.js`、`check-langgraph-checkpoints.js`、`check-long-term-memory.js`、`check-memory-compaction.js`、`check-safety-guardrails.js`、`check-safety-redteam.js`、`check-smoke-reliability.js`、`check-tool-policy.js`、`check-ui-acceptance.js`、`check-auth-boundary.js`、`check-user-memory-isolation.js` 对 README.md 的全部逐字子串/路由表断言，确认这些断言都是位置无关的 `String.includes()` 或 `matchAll()` 扫描；采用"只做整段搬移，不改动任何既有字符"的重排策略，因此无需改动任何 `check-*.js` 断言。`npm test` 全量回归通过（10 个子命令、41 条单测全绿）。

---

## 2026-08-12 — 新增 MCP Server（仓库问答/影响分析/onboarding 暴露为 AI agent 可调用的 MCP tools）

作品集新亮点：产品同时服务人类 Web UI 和 AI agent。架构决策为瘦代理而非直接读写 store——`lib/store.js` 是单进程写锁 + 常驻内存缓存设计，第二个进程直接写会与主服务竞争并可能丢数据；走 HTTP API 则复用现有 guardrails/harness 记录/鉴权。

- 新增 `mcp-server.js`：基于官方 `@modelcontextprotocol/sdk`（Node，stdio transport）的瘦代理，不直接 import `lib/` 任何模块。全部工具调用通过 `fetch` 打到已经在运行的本地 HTTP API（`AI_PM_BASE_URL`，默认 `http://127.0.0.1:3000`；可选 `AI_PM_API_TOKEN` 透传为 `Authorization: Bearer`；可选 `AI_PM_PROJECT_ID` 作为默认项目）。启动时探测一次 `GET /api/health`，不可达时打印可操作的错误指引（提示 `npm start`）并以退出码 1 结束，而不是注册一批注定调用失败的工具。
- 暴露 4 个工具，均为对应 API 端点的直接映射：`list_projects`（`GET /api/projects`）、`ask_codebase`（`POST /api/chat`）、`analyze_impact`（`POST /api/agent-impact`，完整多 Agent LangGraph 影响分析工作流）、`get_onboarding_plan`（`POST /api/onboarding`）。当前 API 面没有独立的检索/搜索端点——`retrieveChunks()`（`lib/retrieval.js`）只在 `/api/chat`、`/api/agent-impact` 内部被调用——因此按计划未新增第五个纯检索工具。每个工具的 `description` 面向调用它的 AI agent 撰写，说明与其它工具的选用边界（例如 `ask_codebase` 的 `kind=impact` 与 `analyze_impact` 的差异）。响应转成紧凑文本（含文件引用列表、不确定性/风险级别、安全状态），出错时返回带 HTTP 状态与错误码的 `isError: true` 内容而非抛裸异常。
- `package.json` 新增依赖 `@modelcontextprotocol/sdk@^1.30.0`（本仓库刻意精简依赖策略下的一次有意扩项，是官方 MCP TypeScript SDK，随附约 92 个传递依赖，其中 `zod` 作为 SDK 自身依赖被间接安装，`mcp-server.js` 未直接 import 它——改用低层 `Server`/`StdioServerTransport` API + 手写 JSON Schema 定义 `inputSchema`，避免再引入一个显式的顶层依赖）；新增 `npm run mcp` 与 `npm run test:mcp` 脚本，`test:mcp` 追加进 `npm test` 串联链末尾；`scripts/check-runtime-deps.js` 依赖白名单同步加入新依赖。
- 新增 `scripts/mcp-server-test.js`：仿照 `scripts/smoke-test.js` 模式拉起真实 `server.js`（临时端口 + 隔离 `DATA_DIR`）并导入 sample 项目，再以子进程方式启动 `mcp-server.js`，通过手写的、模拟 `StdioServerTransport` 换行分帧协议的 JSON-RPC 客户端完成 `initialize` → `notifications/initialized` → `tools/list` → `tools/call` 全链路实调。断言：工具数量恰为 4 且名称集合匹配、`ask_codebase` 返回非空文件引用列表、`analyze_impact` 返回 harness run 元数据、未知工具名触发协议级 RPC 错误、缺少必填参数返回 `isError: true` 而非协议异常，以及主服务未启动时的启动报错路径（子进程退出码 1，stderr 包含可操作的 `npm start` 提示）。
- README.md / README.zh-CN.md 各新增「MCP Server」小节：启动方式（`npm start` + `npm run mcp` 两个终端）、环境变量表、Claude Code/Cursor/Claude Desktop 的 `mcpServers` 配置 JSON 示例、工具清单表（工具名/映射端点/使用场景）。

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
