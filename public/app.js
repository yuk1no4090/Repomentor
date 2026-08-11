const state = {
  page: "landing",
  project: null,
  projects: [],
  loading: false,
  progress: [],
  messages: [],
  errorBanner: null,
  metrics: null,
  harnessAudit: null,
  memory: null,
  auth: { users: [], tokens: [], events: [], error: null, createdToken: null },
  authToken: localStorage.getItem("aido-api-token") || "",
  llmStatus: null,
  lang: localStorage.getItem("aido-lang") || "en",
  activeTab: "qa",
  draftQuestion: ""
};

const app = document.querySelector("#app");

const progressSteps = [
  "Uploading",
  "Parsing files",
  "Creating local retrieval index",
  "Generating project summary",
  "Ready"
];

const copy = {
  en: {
    brand: "Developer Onboarding Copilot",
    nav: { landing: "Product", import: "Import", overview: "Overview", chat: "Copilot", dashboard: "Evaluation", brandAria: "Go to product page", languageAria: "Language switch" },
    home: {
      title: "Repository onboarding, with evidence.",
      subtitle: "Import a repo, inspect the project map, ask grounded questions, analyze change impact, and measure answer quality.",
      launch: "Launch sample workspace",
      importRepo: "Import repository",
      workspace: "WORKSPACE",
      filesParsed: "Files parsed",
      chunksIndexed: "Chunks indexed",
      citationCoverage: "Citation coverage",
      evidence: "Evidence snippets",
      workflow: "MVP workflow",
      workflowTitle: "Designed around the onboarding job, not generic chat.",
      users: [
        ["New engineers", "Find entry points, core flows, and first-week reading priorities."],
        ["Technical PMs", "Translate code structure into features, APIs, dependencies, and product risk."],
        ["QA", "Turn code changes into test scenarios, boundary cases, and regression focus."]
      ],
      cards: [
        ["01", "Import", "Pull public GitHub repos or upload ZIP files.", "import"],
        ["02", "Understand", "Summarize stack, modules, README, and first reads.", "overview"],
        ["03", "Ask", "Answer repository questions with cited files.", "chat"],
        ["04", "Analyze", "Map code changes to risk and test coverage.", "chat"],
        ["05", "Evaluate", "Track feedback, citation coverage, and failure reasons.", "dashboard"]
      ]
    },
    import: {
      eyebrow: "Repository import",
      title: "Create a repository workspace",
      desc: "Parse source files and docs, skip build/dependency folders, create chunks with metadata, then generate the initial project map.",
      sample: "Use Sample Repo",
      github: "GitHub repo URL",
      analyze: "Analyze Repository",
      upload: "or upload source",
      zip: "Repository ZIP",
      zipHelp: "Supports Markdown, JS/TS/TSX, Python, Java, JSON, YAML, and TXT.",
      pipeline: "Analysis pipeline",
      caps: [
        ["Guardrails", "Answers require cited repository files."],
        ["Retrieval", "Top chunks include file path, type, and line ranges."],
        ["Metrics", "Feedback feeds the evaluation dashboard."]
      ]
    },
    pipeline: {
      Uploading: "Receive GitHub ZIP, uploaded ZIP, or sample repository.",
      "Parsing files": "Filter supported files and ignore dependency/build output.",
      "Creating local retrieval index": "Chunk files and score retrievable repository context.",
      "Generating project summary": "Infer stack, modules, README summary, and first reads.",
      Ready: "Workspace is ready for Q&A, impact analysis, and onboarding."
    },
    overview: {
      eyebrow: "Project overview",
      quality: "View Quality",
      open: "Open Copilot",
      summary: "Repository Summary",
      actions: "Next best actions",
      modules: "Core Modules",
      directory: "Directory Structure",
      stack: "Tech Stack",
      reads: "Recommended First Reads",
      evidence: "Evidence Index",
      retrievable: "retrievable chunks",
      docs: "docs",
      sourceFiles: "source files",
      filesParsed: "files parsed",
      chunksIndexed: "chunks indexed",
      firstReads: "first reads",
      safety: "Import Safety",
      safetyReview: "needs review",
      safetyPassed: "passed",
      promptRisks: "prompt-risk files",
      sensitiveFiles: "sensitive files",
      noRisks: "no risks",
      quickActions: [
        ["Explain architecture", "What are the core business modules?"],
        ["Find order logic", "Where is the order creation logic?"],
        ["Plan onboarding", "What should I read first as a new backend engineer?"]
      ]
    },
    chat: {
      current: "Current workspace",
      files: "files",
      chunks: "chunks",
      recommended: "Recommended questions",
      qualityRules: "Quality rules",
      rules: ["Answer from repository context", "Cite file paths for claims", "Flag uncertainty when evidence is thin"],
      modeAI: "AI-enhanced mode",
      modeFallback: "Offline retrieval mode",
      llmSource: "Data source",
      filesTitle: "Files",
      workspace: "Workspace",
      projectMap: "Project map",
      impact: "Impact Analysis",
      agent: "Agent Workflow",
      onboarding: "Onboarding Plan",
      evidenceDock: "Evidence dock",
      retrieval: "Retrieval sources",
      contract: "Answer contract",
      contractItems: ["Direct answer", "Key points", "Related files", "Uncertainty", "Feedback"],
      qualitySnapshot: "Quality snapshot",
      helpfulRate: "Helpful rate",
      qaEyebrow: "Repository Q&A",
      qaTitle: "Ask with citations",
      qaHelp: "Use this for codebase navigation, flow explanation, module discovery, and source-backed answers.",
      impactEyebrow: "Change intelligence",
      impactTitle: "Analyze impact before code changes",
      impactHelp: "Use this for change requests, new statuses, API changes, schema updates, and regression planning.",
      agentEyebrow: "Agentic workflow",
      agentTitle: "Run an impact analysis agent",
      agentHelp: "Use this to see a framework-style agent loop: classify the change, call retrieval tools, expand dependency context, run guardrails, and return structured output.",
      askPlaceholder: "Ask a codebase question, for example: Where is the login flow?",
      impactPlaceholder: "I want to add a new order status: partially_refunded. What could be impacted?",
      agentPlaceholder: "Add partially_refunded to order status and show me the agent trace.",
      repoGrounded: "Repo-grounded",
      riskAware: "Risk-aware",
      traceable: "Traceable",
      topChunks: "Top chunks",
      citationsRequired: "Citations required",
      ask: "Ask Copilot",
      analyze: "Analyze Impact",
      runAgent: "Run Agent",
      ready: "Codebase copilot ready",
      readyText: "Ask a project question and I will answer with file citations and uncertainty.",
      impactReady: "Impact analyst ready",
      impactReadyText: "Describe a planned change and I will map likely modules, risk, tests, and open questions.",
      agentReady: "Impact agent ready",
      agentReadyText: "Describe a planned code change and I will show every tool step, evidence source, guardrail, and final recommendation.",
      roleRamp: "Role-based ramp",
      planTitle: "Generate a practical onboarding path",
      planHelp: "Plans use recommended first reads and adapt focus by role, so PM, QA, frontend, and backend users start from different questions.",
      role: "Role",
      duration: "Duration",
      generatePlan: "Generate Plan",
      plannerReady: "Onboarding planner ready",
      plannerText: "Choose a role and duration to generate a reading path grounded in the imported repository.",
      answer: "Answer",
      keyPoints: "Key Points",
      related: "Related Files",
      uncertainty: "Uncertainty",
      next: "Suggested Next Questions",
      impactSummary: "Impact Summary",
      impactAreas: "Impact Areas",
      tests: "Testing Suggestions",
      openQuestions: "Open Questions",
      agentTrace: "Agent Trace",
      agentInstructions: "Agent Instructions",
      frameworkConcepts: "Framework Concepts",
      guardrails: "Guardrails",
      memory: "Memory",
      harness: "Harness",
      safety: "Safety",
      noMemory: "No confirmed preference memory",
      pendingMemory: "pending",
      agentRuntime: "Agent runtime",
      unknown: "unknown",
      steps: "steps",
      durationMs: "ms",
      fallbackUsed: "fallback",
      noFallback: "no fallback",
      budgetOk: "budget ok",
      budgetExceeded: "budget exceeded",
      guardrailsPassed: "guardrails passed",
      needsReview: "needs review",
      memorySuggestions: "Memory Suggestions",
      saveMemory: "Save",
      ignoreMemory: "Ignore",
      evidence: "Evidence Used",
      goal: "Goal",
      tasks: "Tasks",
      hitlPaused: "Human Review Required",
      hitlApprove: "Approve",
      hitlReject: "Reject",
      hitlApproved: "Approved by Reviewer",
      hitlRejected: "Rejected by Reviewer",
      hitlSubmitting: "Submitting decision...",
      hitlDefaultReason: "This high-risk change requires human approval before proceeding.",
      hitlApprovedMessage: "[HITL] Reviewer approved the high-risk change",
      hitlRejectedMessage: "[HITL] Reviewer rejected the high-risk change",
      agentRoster: "Agent Roster",
      agentHandoff: "Agent Handoff Flow",
      preferenceMemory: "Preference memory",
      noSavedPreferences: "No saved preferences",
      clearAll: "Clear all",
      removeMemory: "Remove",
      memoryAudit: "Memory audit",
      noMemoryEventsYet: "No memory events yet.",
      longTermMemory: "Long-term memory",
      noLongTermMemoriesYet: "No long-term memories yet.",
      agentSuggestions: [
        "Add partially_refunded to order status and show the agent trace.",
        "Change payment failure handling and show the agent steps.",
        "Use the agent to analyze order status dependencies."
      ],
      impactSuggestions: [
        "I want to add partially_refunded to order status. What could be impacted?",
        "If payment failure handling changes, what tests should QA run?",
        "What modules depend on order status?"
      ],
      q: [
        "Explain the user authentication flow.",
        "What are the core business modules?",
        "Where is the order creation logic?",
        "What should I read first as a new backend engineer?",
        "If we add a new order status, what could be impacted?"
      ]
    },
    feedback: [["helpful", "Helpful"], ["not_helpful", "Not helpful"], ["inaccurate", "Inaccurate"], ["missing_citation", "Missing citation"], ["too_generic", "Too generic"]],
    dashboard: {
      eyebrow: "Evaluation dashboard",
      title: "AI quality and feedback metrics",
      desc: "Metrics are recorded from actual demo usage: questions, answers, citations, uncertainty, and user feedback.",
      refresh: "Refresh",
      total: "Total Questions",
      agentRuns: "Agent Runs",
      helpful: "Helpful Rate",
      citation: "Citation Coverage",
      uncertain: "Uncertain Answer Rate",
      negative: "Negative Feedback Rate",
      highRisk: "High Risk Questions",
      guardrailHits: "Guardrail Hits",
      memorySaves: "Memory Saves",
      fallbackRuns: "Fallback Runs",
      avgResponse: "Avg Response",
      failures: "Top Failure Reasons",
      safetyRisks: "Safety Risk Types",
      safetyStatus: "Safety Status",
      citationStatus: "Citation Status",
      memoryStatus: "Memory Status",
      harnessRuntime: "Harness Runtime",
      modelMode: "Model Mode",
      toolPolicy: "Tool Policy",
      budgetStatus: "Budget Status",
      schemaStatus: "Schema Status",
      llmUsage: "LLM Usage",
      traceTools: "Trace Tools",
      fallbackReasons: "Fallback Reasons",
      recentSafety: "Recent Safety Events",
      recentMemory: "Recent Memory Events",
      recentRuns: "Recent Harness Runs",
      outputRedactions: "Output Redactions",
      redactedMatches: "Redacted Matches",
      harnessSnapshots: "Harness Snapshots",
      importSafetyTitle: "Import Safety",
      memoryEventsTitle: "Memory Events",
      recentToolPolicyTitle: "Recent Tool Policy",
      recentRedactionsTitle: "Recent Redactions",
      recent: "Recent Feedback",
      signals: "Product iteration signals",
      signalItems: [
        ["Low citation coverage", "Add stronger retrieval, larger top-k, or citation validation."],
        ["High uncertain rate", "Improve docs ingestion and expose missing-context prompts."],
        ["Too generic feedback", "Ask follow-up questions and require concrete files/functions."]
      ],
      occurrences: "occurrences"
    },
    auth: {
      title: "Auth Operations",
      tokenSet: "token set in this browser",
      noToken: "no browser token",
      usersLabel: "users",
      activeTokensLabel: "active tokens",
      apiToken: "API token",
      tokenPlaceholder: "Bearer token for protected APIs",
      saveToken: "Save token",
      clear: "Clear",
      oneTimeToken: "One-time token",
      createUser: "Create local user",
      userId: "User ID",
      scopes: "Scopes",
      orgId: "Org ID",
      optional: "optional",
      issueToken: "Issue token",
      createUserButton: "Create user",
      usersHeading: "Users",
      noUsers: "No users loaded.",
      noScopes: "no scopes",
      disable: "Disable",
      tokensHeading: "Tokens",
      noTokens: "No store-backed tokens loaded.",
      recentEvents: "Recent auth events",
      noEvents: "No auth events loaded.",
      authButton: "Auth",
      disableConfirmTemplate: "Disable local auth user \"{user}\" and all store-backed tokens for this user?"
    },
    harness: {
      auditTitle: "Harness Run Audit",
      runLabel: "run",
      runtimeLabel: "runtime",
      modelLabel: "model",
      schemaLabel: "schema",
      budgetLabel: "budget",
      safetyLabel: "safety",
      fallbackLabel: "fallback",
      schemaInvalid: "invalid",
      schemaValid: "valid",
      budgetContextExceeded: "context exceeded",
      budgetTimeoutExceeded: "timeout exceeded",
      budgetStepExceeded: "step exceeded",
      budgetWithinBudget: "within budget",
      fallbackTrue: "true",
      fallbackFalse: "false",
      riskDetails: "Risk Details",
      stepFallback: "step",
      toolFallback: "tool"
    },
    empty: {
      title: "No repository imported",
      button: "Go to Import",
      importOverview: "Import a repository to generate a project overview.",
      importCopilot: "Import a repository before asking the copilot.",
      importMetrics: "Import a repository before viewing evaluation metrics."
    }
  },
  zh: {
    brand: "研发知识助手",
    nav: { landing: "产品", import: "导入", overview: "总览", chat: "Copilot", dashboard: "评估", brandAria: "前往产品首页", languageAria: "语言切换" },
    home: {
      title: "有证据的代码库入门。",
      subtitle: "导入仓库，查看项目地图，提出有引用的问题，分析变更影响，并衡量 AI 回答质量。",
      launch: "启动示例工作区",
      importRepo: "导入仓库",
      workspace: "工作区",
      filesParsed: "已解析文件",
      chunksIndexed: "已索引片段",
      citationCoverage: "引用覆盖率",
      evidence: "证据片段",
      workflow: "MVP 流程",
      workflowTitle: "围绕研发入门任务设计，而不是普通聊天。",
      users: [
        ["新入职工程师", "快速找到入口文件、核心流程和第一周阅读重点。"],
        ["技术 PM", "把代码结构转成业务功能、接口依赖和需求风险。"],
        ["QA / 测试", "根据代码改动定位测试场景、边界条件和回归重点。"]
      ],
      cards: [
        ["01", "导入", "支持公开 GitHub 仓库或 ZIP 文件。", "import"],
        ["02", "理解", "总结技术栈、模块、README 和推荐阅读。", "overview"],
        ["03", "提问", "基于仓库内容回答，并引用文件来源。", "chat"],
        ["04", "分析", "评估代码改动影响范围和测试风险。", "chat"],
        ["05", "评估", "追踪反馈、引用覆盖率和失败原因。", "dashboard"]
      ]
    },
    import: {
      eyebrow: "仓库导入",
      title: "创建代码库工作区",
      desc: "解析源码和文档，跳过构建与依赖目录，生成带 metadata 的 chunks，并创建项目地图。",
      sample: "使用示例仓库",
      github: "GitHub 仓库 URL",
      analyze: "分析仓库",
      upload: "或上传源码",
      zip: "仓库 ZIP 文件",
      zipHelp: "支持 Markdown、JS/TS/TSX、Python、Java、JSON、YAML 和 TXT。",
      pipeline: "分析流程",
      caps: [
        ["Guardrails", "回答必须引用仓库文件。"],
        ["检索", "检索结果包含文件路径、类型和行号范围。"],
        ["指标", "用户反馈会进入评估仪表盘。"]
      ]
    },
    pipeline: {
      Uploading: "接收 GitHub ZIP、上传 ZIP 或示例仓库。",
      "Parsing files": "过滤支持的文件，并忽略依赖与构建目录。",
      "Creating local retrieval index": "切分文件，建立可检索的仓库上下文。",
      "Generating project summary": "推断技术栈、模块、README 摘要和推荐阅读。",
      Ready: "工作区已就绪，可进行问答、影响分析和入门规划。"
    },
    overview: {
      eyebrow: "项目总览",
      quality: "查看质量",
      open: "打开 Copilot",
      summary: "仓库摘要",
      actions: "下一步建议",
      modules: "核心模块",
      directory: "目录结构",
      stack: "技术栈",
      reads: "推荐优先阅读",
      evidence: "证据索引",
      retrievable: "可检索 chunks",
      docs: "文档",
      sourceFiles: "源码文件",
      filesParsed: "已解析文件",
      chunksIndexed: "已索引 chunks",
      firstReads: "推荐阅读",
      safety: "导入安全",
      safetyReview: "待复核",
      safetyPassed: "已通过",
      promptRisks: "存在提示注入风险的文件",
      sensitiveFiles: "敏感文件",
      noRisks: "无风险",
      quickActions: [
        ["解释架构", "这个项目的主要业务模块有哪些？"],
        ["查找订单逻辑", "订单创建逻辑在哪里？"],
        ["生成入门路径", "新人后端工程师应该先看哪些文件？"]
      ]
    },
    chat: {
      current: "当前工作区",
      files: "文件",
      chunks: "chunks",
      recommended: "推荐问题",
      qualityRules: "质量规则",
      rules: ["只基于仓库上下文回答", "关键结论必须引用文件路径", "证据不足时说明不确定"],
      modeAI: "AI 增强模式",
      modeFallback: "离线检索模式",
      llmSource: "数据来源",
      filesTitle: "文件",
      workspace: "工作区",
      projectMap: "项目地图",
      impact: "影响分析",
      agent: "Agent 工作流",
      onboarding: "入门计划",
      evidenceDock: "证据面板",
      retrieval: "检索来源",
      contract: "回答结构",
      contractItems: ["直接回答", "关键要点", "相关文件", "不确定性", "用户反馈"],
      qualitySnapshot: "质量快照",
      helpfulRate: "有帮助率",
      qaEyebrow: "代码库问答",
      qaTitle: "带引用地提问",
      qaHelp: "适合查找代码入口、解释流程、发现模块和生成有来源的答案。",
      impactEyebrow: "变更智能分析",
      impactTitle: "改代码前先分析影响",
      impactHelp: "适合新增状态、接口调整、字段变更、测试回归和风险评估。",
      agentEyebrow: "Agentic 工作流",
      agentTitle: "运行影响分析 Agent",
      agentHelp: "展示类似 Agent 框架的执行循环：识别改动、调用检索工具、扩展依赖上下文、执行 guardrails，并返回结构化结果。",
      askPlaceholder: "问一个代码库问题，例如：登录流程在哪里？",
      impactPlaceholder: "我想新增订单状态 partially_refunded，可能影响哪些地方？",
      agentPlaceholder: "新增订单状态 partially_refunded，并展示 agent 执行轨迹。",
      repoGrounded: "基于仓库",
      riskAware: "风险感知",
      traceable: "可追踪",
      topChunks: "Top chunks",
      citationsRequired: "必须引用",
      ask: "询问 Copilot",
      analyze: "分析影响",
      runAgent: "运行 Agent",
      ready: "代码库 Copilot 已就绪",
      readyText: "提出项目问题，我会基于文件引用和不确定性提示回答。",
      impactReady: "影响分析助手已就绪",
      impactReadyText: "描述一个计划改动，我会分析模块、风险、测试建议和开放问题。",
      agentReady: "影响分析 Agent 已就绪",
      agentReadyText: "描述一个代码改动，我会展示每一步工具调用、证据来源、guardrail 和最终建议。",
      roleRamp: "按角色入门",
      planTitle: "生成可执行的入门路径",
      planHelp: "根据推荐阅读文件和不同角色重点，生成 PM、QA、前端、后端各自的学习路径。",
      role: "角色",
      duration: "周期",
      generatePlan: "生成计划",
      plannerReady: "入门规划助手已就绪",
      plannerText: "选择角色和周期，生成基于当前仓库的阅读路径。",
      answer: "回答",
      keyPoints: "关键要点",
      related: "相关文件",
      uncertainty: "不确定性",
      next: "建议继续追问",
      impactSummary: "影响摘要",
      impactAreas: "影响范围",
      tests: "测试建议",
      openQuestions: "开放问题",
      agentTrace: "Agent 执行轨迹",
      agentInstructions: "Agent 指令",
      frameworkConcepts: "框架概念",
      guardrails: "Guardrails",
      memory: "记忆",
      harness: "Harness",
      safety: "安全",
      noMemory: "暂无已确认偏好记忆",
      pendingMemory: "待确认",
      agentRuntime: "Agent 运行时",
      unknown: "未知",
      steps: "步",
      durationMs: "毫秒",
      fallbackUsed: "已 fallback",
      noFallback: "无 fallback",
      budgetOk: "预算正常",
      budgetExceeded: "预算超限",
      guardrailsPassed: "护栏通过",
      needsReview: "需要复核",
      memorySuggestions: "记忆建议",
      saveMemory: "保存",
      ignoreMemory: "忽略",
      evidence: "使用的证据",
      goal: "目标",
      tasks: "任务",
      hitlPaused: "需要人工审核",
      hitlApprove: "通过",
      hitlReject: "拒绝",
      hitlApproved: "审核员已通过",
      hitlRejected: "审核员已拒绝",
      hitlSubmitting: "正在提交决定…",
      hitlDefaultReason: "此高风险改动需要人工审核通过后才能继续。",
      hitlApprovedMessage: "[HITL] 审核员已通过该高风险改动",
      hitlRejectedMessage: "[HITL] 审核员已拒绝该高风险改动",
      agentRoster: "Agent 角色列表",
      agentHandoff: "Agent 交接流程",
      preferenceMemory: "偏好记忆",
      noSavedPreferences: "暂无已保存偏好",
      clearAll: "清空",
      removeMemory: "删除",
      memoryAudit: "记忆审计",
      noMemoryEventsYet: "暂无记忆事件。",
      longTermMemory: "长期记忆",
      noLongTermMemoriesYet: "暂无长期记忆。",
      agentSuggestions: [
        "新增订单状态 partially_refunded，并展示 agent trace。",
        "修改支付失败逻辑，Agent 会怎样找影响范围？",
        "用 Agent 分析订单状态依赖。"
      ],
      impactSuggestions: [
        "我想新增订单状态 partially_refunded，可能影响哪些地方？",
        "如果修改支付失败逻辑，QA 需要测哪些场景？",
        "哪些模块依赖订单状态？"
      ],
      q: [
        "解释用户登录流程。",
        "这个项目的核心业务模块有哪些？",
        "订单创建逻辑在哪里？",
        "新人后端工程师应该先看哪些文件？",
        "如果新增订单状态，会影响哪些模块？"
      ]
    },
    feedback: [["helpful", "有帮助"], ["not_helpful", "没帮助"], ["inaccurate", "不准确"], ["missing_citation", "缺少引用"], ["too_generic", "太笼统"]],
    dashboard: {
      eyebrow: "评估仪表盘",
      title: "AI 质量与用户反馈指标",
      desc: "指标来自真实 demo 使用：问题、回答、引用、不确定性和用户反馈。",
      refresh: "刷新",
      total: "总提问数",
      agentRuns: "Agent 运行次数",
      helpful: "有帮助率",
      citation: "引用覆盖率",
      uncertain: "不确定回答率",
      negative: "负反馈率",
      highRisk: "高风险问题",
      guardrailHits: "护栏命中",
      memorySaves: "记忆保存",
      fallbackRuns: "Fallback 次数",
      avgResponse: "平均响应",
      failures: "主要失败原因",
      safetyRisks: "安全风险类型",
      safetyStatus: "安全状态",
      citationStatus: "引用状态",
      memoryStatus: "记忆状态",
      harnessRuntime: "Harness 运行时",
      modelMode: "模型模式",
      toolPolicy: "工具策略",
      budgetStatus: "预算状态",
      schemaStatus: "Schema 状态",
      llmUsage: "LLM 使用",
      traceTools: "Trace 工具",
      fallbackReasons: "Fallback 原因",
      recentSafety: "最近安全事件",
      recentMemory: "最近记忆事件",
      recentRuns: "最近运行",
      outputRedactions: "输出脱敏次数",
      redactedMatches: "脱敏命中数",
      harnessSnapshots: "Harness 快照数",
      importSafetyTitle: "导入安全",
      memoryEventsTitle: "记忆事件",
      recentToolPolicyTitle: "最近工具策略",
      recentRedactionsTitle: "最近脱敏记录",
      recent: "最近反馈",
      signals: "产品迭代信号",
      signalItems: [
        ["引用覆盖率低", "优化检索、扩大 top-k 或增加引用校验。"],
        ["不确定率高", "改进文档导入，并提示缺失上下文。"],
        ["反馈太笼统", "要求回答包含具体文件和函数。"]
      ],
      occurrences: "次"
    },
    auth: {
      title: "认证运维",
      tokenSet: "已在浏览器中设置 token",
      noToken: "浏览器未设置 token",
      usersLabel: "位用户",
      activeTokensLabel: "个已激活 token",
      apiToken: "API 令牌",
      tokenPlaceholder: "用于受保护接口的 Bearer token",
      saveToken: "保存 token",
      clear: "清除",
      oneTimeToken: "一次性 Token",
      createUser: "创建本地用户",
      userId: "用户 ID",
      scopes: "权限范围",
      orgId: "组织 ID",
      optional: "可选",
      issueToken: "签发 token",
      createUserButton: "创建用户",
      usersHeading: "用户列表",
      noUsers: "暂无用户数据。",
      noScopes: "无权限范围",
      disable: "禁用",
      tokensHeading: "Token 列表",
      noTokens: "暂无存储中的 token 数据。",
      recentEvents: "最近认证事件",
      noEvents: "暂无认证事件数据。",
      authButton: "认证",
      disableConfirmTemplate: "确定要禁用本地认证用户 \"{user}\" 及其所有基于存储的 token 吗？"
    },
    harness: {
      auditTitle: "Harness 运行审计",
      runLabel: "运行",
      runtimeLabel: "运行时",
      modelLabel: "模型",
      schemaLabel: "Schema",
      budgetLabel: "预算",
      safetyLabel: "安全",
      fallbackLabel: "Fallback",
      schemaInvalid: "无效",
      schemaValid: "有效",
      budgetContextExceeded: "上下文超限",
      budgetTimeoutExceeded: "超时",
      budgetStepExceeded: "步数超限",
      budgetWithinBudget: "预算正常",
      fallbackTrue: "是",
      fallbackFalse: "否",
      riskDetails: "风险详情",
      stepFallback: "步骤",
      toolFallback: "工具"
    },
    empty: {
      title: "还没有导入仓库",
      button: "去导入",
      importOverview: "导入仓库后即可生成项目总览。",
      importCopilot: "导入仓库后才能向 Copilot 提问。",
      importMetrics: "导入仓库后才能查看评估指标。"
    }
  }
};

function t() {
  return copy[state.lang] || copy.en;
}

function html(strings, ...values) {
  return strings.reduce((acc, string, index) => acc + string + (values[index] ?? ""), "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderList(items, mapper) {
  if (!items || items.length === 0) return `<p class="muted">${state.lang === "zh" ? "暂无数据。" : "No data yet."}</p>`;
  return items.map(mapper).join("");
}

function metricValue(value, fallback = "0") {
  return value === undefined || value === null ? fallback : value;
}

function sourceLabel(source = "") {
  if (source.startsWith("github:")) return "GitHub";
  if (source === "zip-upload") return "ZIP";
  if (source === "sample") return "Sample";
  return "Local";
}

function pipelineCopy(step) {
  return t().pipeline[step] || "";
}

function progressStepName(step) {
  if (state.lang !== "zh") return step;
  return {
    Uploading: "上传中",
    "Parsing files": "解析文件",
    "Creating local retrieval index": "创建检索索引",
    "Generating project summary": "生成项目摘要",
    Ready: "就绪"
  }[step] || step;
}

async function api(path, options = {}) {
  const { headers: optionHeaders = {}, ...fetchOptions } = options;
  const headers = { "content-type": "application/json", ...optionHeaders };
  if (state.authToken && !headers.Authorization) headers.Authorization = `Bearer ${state.authToken}`;
  const response = await fetch(path, {
    headers,
    ...fetchOptions
  });
  const contentType = response.headers.get("content-type") || "";
  let payload;
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
  }
  if (payload === undefined) {
    if (response.ok) return {};
    const error = new Error(`Request failed with HTTP ${response.status} (non-JSON response).`);
    error.status = response.status;
    error.code = "NON_JSON_RESPONSE";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload.error || "Request failed.");
    error.status = response.status;
    error.code = payload.code || "REQUEST_FAILED";
    error.payload = payload;
    throw error;
  }
  return payload;
}

function showError(error, retryFn = null) {
  const code = error?.code && error.code !== "REQUEST_FAILED" ? `\n[${error.code}]` : "";
  const message = `${error?.message || "Request failed."}${code}`;
  if (retryFn) {
    // Show inline retry banner instead of alert
    state.errorBanner = { message, retryFn };
    render();
  } else {
    alert(message);
  }
}
function clearError() {
  state.errorBanner = null;
  render();
}

async function loadProjects() {
  try {
    const payload = await api("/api/projects");
    state.projects = payload.projects;
    state.project ||= payload.projects.at(-1) || null;
  } catch {
    state.projects = [];
  }
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    state.llmStatus = await response.json();
  } catch {
    state.llmStatus = { llm: { configured: false }, version: "unknown" };
  }
}

async function refreshMemory(shouldRender = true) {
  if (!state.project) {
    state.memory = null;
    return;
  }
  const payload = await api(`/api/memory?projectId=${encodeURIComponent(state.project.id)}`);
  state.memory = payload;
  if (shouldRender) render();
}

function setPage(page) {
  state.page = page;
  if (page === "chat") Promise.all([checkHealth(), refreshMemory(false)]).then(render);
  if (page === "dashboard" && state.project) {
    refreshMetrics();
    refreshAuthAdmin(false);
  }
  render();
}

function setLanguage(lang) {
  state.lang = lang;
  localStorage.setItem("aido-lang", lang);
  render();
}

function nav() {
  const c = t();
  const items = [
    ["landing", c.nav.landing],
    ["import", c.nav.import],
    ["overview", c.nav.overview],
    ["chat", c.nav.chat],
    ["dashboard", c.nav.dashboard]
  ];
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  return html`
    <header class="topbar">
      <button class="brand" data-page="landing" aria-label="${escapeHtml(c.nav.brandAria)}">
        <span class="brand-mark">AI</span>
        <span>${c.brand}</span>
      </button>
      <div class="nav-right">
        <nav>
          ${items.map(([page, label]) => `<button class="nav-item ${state.page === page ? "active" : ""}" data-page="${page}">${label}</button>`).join("")}
        </nav>
        <div class="topbar-auth">
          <input data-auth-token-input type="password" autocomplete="off" value="${escapeHtml(state.authToken || "")}" placeholder="${escapeHtml(c.auth.apiToken)}">
          <button data-auth-action="save-token">${c.auth.authButton}</button>
        </div>
        <div class="language-toggle" aria-label="${escapeHtml(c.nav.languageAria)}">
          <button class="${state.lang === "en" ? "active" : ""}" data-lang="en">EN</button>
          <button class="${state.lang === "zh" ? "active" : ""}" data-lang="zh">中文</button>
        </div>
      </div>
    </header>
  `;
}

function landingPage() {
  const c = t();
  const projectName = state.project?.name || "Sample Commerce API";
  const summary = state.project?.summary?.overview || "A TypeScript-based e-commerce backend with authentication, order processing, and payment integration.";
  const cards = c.home.cards;
  return html`
    <main class="landing figma-home">
      <section class="figma-hero">
        <div class="hero-copy">
          <h1>${c.home.title}</h1>
          <p class="hero-text">${c.home.subtitle}</p>
          <div class="hero-actions">
            <button class="primary" data-action="sample" ${state.loading ? "disabled" : ""}>${c.home.launch}</button>
            <button class="secondary" data-page="import">${c.home.importRepo}</button>
          </div>
        </div>

        <section class="figma-preview" aria-label="Product workspace preview">
          <div class="command-body">
            <div class="preview-sidebar">
              <strong>${c.home.workspace}</strong>
              <span class="active">Overview</span>
              <span>Q&A</span>
              <span>Impact</span>
              <span>Evaluation</span>
            </div>
            <div class="preview-main">
              <h2>${escapeHtml(projectName)}</h2>
              <p>${escapeHtml(summary)}</p>
              <div class="mini-metrics">
                <span><small>${c.home.filesParsed}</small><strong>${metricValue(state.project?.fileCount, "248")}</strong></span>
                <span><small>${c.home.chunksIndexed}</small><strong>${metricValue(state.project?.chunkCount, "1,842")}</strong></span>
                <span><small>${c.home.citationCoverage}</small><strong>${metricValue(state.metrics?.citation_coverage, "94")}%</strong></span>
              </div>
              <div class="evidence-card">
                <span>${c.home.evidence}</span>
                <code>src/services/orderService.ts</code>
                <code>src/routes/auth.ts</code>
                <code>tests/order.test.ts</code>
              </div>
            </div>
          </div>
        </section>
      </section>

      <section class="workflow-band">
        <div class="section-head">
          <p class="eyebrow">${c.home.workflow}</p>
          <h2>${c.home.workflowTitle}</h2>
        </div>
        <div class="workflow-grid">
          ${cards.map(([num, title, copy, page]) => `
            <article class="workflow-card" data-page="${page}" role="button" tabindex="0">
              <span>${num}</span>
              <h3>${title}</h3>
              <p>${copy}</p>
            </article>
          `).join("")}
        </div>
      </section>

      <section class="band compact-band">
        <div class="three-col">
          ${c.home.users.map(([title, text]) => `<article class="feature"><h3>${title}</h3><p>${text}</p></article>`).join("")}
        </div>
      </section>
    </main>
  `;
}

function importPage() {
  const c = t();
  return html`
    <main class="page-shell">
      <div class="section-head row-head">
        <div>
          <p class="eyebrow">${c.import.eyebrow}</p>
          <h1>${c.import.title}</h1>
          <p>${c.import.desc}</p>
        </div>
        <button class="secondary" data-action="sample" ${state.loading ? "disabled" : ""}>${c.import.sample}</button>
      </div>

      <div class="import-layout">
        <section class="import-box">
          <div class="input-group">
            <label>
              <span>${c.import.github}</span>
              <input id="repoUrl" type="url" placeholder="https://github.com/owner/repo" />
            </label>
            <button class="primary" data-action="import" ${state.loading ? "disabled" : ""}>${c.import.analyze}</button>
          </div>
          <div class="split-label"><span>${c.import.upload}</span></div>
          <label class="upload-zone">
            <span>${c.import.zip}</span>
            <input id="zipFile" type="file" accept=".zip,application/zip" />
            <small>${c.import.zipHelp}</small>
          </label>
        </section>

        <section class="pipeline-panel">
          <h2>${c.import.pipeline}</h2>
          <div class="progress-box vertical">
            ${progressSteps.map((step, index) => `
              <div class="progress-step ${state.progress.includes(step) ? "done" : ""}">
                <span>${index + 1}</span>
                <div>
                  <strong>${progressStepName(step)}</strong>
                  <small>${pipelineCopy(step)}</small>
                </div>
              </div>
            `).join("")}
          </div>
        </section>
      </div>

      <section class="capability-strip">
        ${c.import.caps.map(([title, text]) => `<div><strong>${title}</strong><span>${text}</span></div>`).join("")}
      </section>
    </main>
  `;
}

function overviewPage() {
  if (!state.project) return emptyProject(t().empty.importOverview);
  const c = t();
  const { summary } = state.project;
  const safetyReview = summary.safetyReview || {};
  const quickActions = c.overview.quickActions;
  return html`
    <main class="page-shell">
      <div class="section-head row-head">
        <div>
          <p class="eyebrow">${c.overview.eyebrow}</p>
          <h1>${escapeHtml(state.project.name)}</h1>
          <p>${escapeHtml(summary.overview)}</p>
        </div>
        <div class="header-actions">
          <button class="secondary" data-page="dashboard">${c.overview.quality}</button>
          <button class="primary" data-page="chat">${c.overview.open}</button>
        </div>
      </div>

      <div class="overview-grid">
        <section class="panel span-2 overview-summary">
          <div class="panel-title-row">
            <h2>${c.overview.summary}</h2>
            <span class="source-pill">${escapeHtml(sourceLabel(state.project.source))}</span>
          </div>
          <p>${escapeHtml(summary.readmeSummary)}</p>
          <div class="stat-strip strong">
            <span><strong>${state.project.fileCount}</strong> ${c.overview.filesParsed}</span>
            <span><strong>${state.project.chunkCount}</strong> ${c.overview.chunksIndexed}</span>
            <span><strong>${summary.recommendedFiles.length}</strong> ${c.overview.firstReads}</span>
          </div>
        </section>

        <section class="panel action-panel">
          <h2>${c.overview.actions}</h2>
          <div class="action-list">
            ${quickActions.map(([label, question]) => `<button data-question="${escapeHtml(question)}"><strong>${label}</strong><span>${escapeHtml(question)}</span></button>`).join("")}
          </div>
        </section>

        <section class="panel">
          <h2>${c.overview.modules}</h2>
          <div class="tag-list">${renderList(summary.coreModules, (item) => `<span>${escapeHtml(item)}</span>`)}</div>
        </section>

        <section class="panel span-2">
          <h2>${c.overview.directory}</h2>
          <pre class="tree">${escapeHtml(summary.directoryTree)}</pre>
        </section>

        <section class="panel">
          <h2>${c.overview.stack}</h2>
          <div class="tag-list">${renderList(summary.techStack, (item) => `<span>${escapeHtml(item)}</span>`)}</div>
        </section>

        <section class="panel span-2">
          <h2>${c.overview.reads}</h2>
          <ol class="file-list two-col-list">
            ${renderList(summary.recommendedFiles, (file) => `<li><code>${escapeHtml(file)}</code></li>`)}
          </ol>
        </section>

        <section class="panel evidence-panel">
          <h2>${c.overview.evidence}</h2>
          <div class="evidence-stats">
            <div><strong>${state.project.chunkCount}</strong><span>${c.overview.retrievable}</span></div>
            <div><strong>${state.project.files.filter((file) => file.type === "md").length}</strong><span>${c.overview.docs}</span></div>
            <div><strong>${state.project.files.filter((file) => ["ts", "tsx", "js", "py", "java"].includes(file.type)).length}</strong><span>${c.overview.sourceFiles}</span></div>
          </div>
        </section>

        <section class="panel evidence-panel">
          <h2>${escapeHtml(c.overview.safety || "Import Safety")}</h2>
          <div class="evidence-stats">
            <div><strong>${escapeHtml(safetyReview.status === "needs_review" ? (c.overview.safetyReview || "needs review") : (c.overview.safetyPassed || "passed"))}</strong><span>${escapeHtml((safetyReview.risk_types || []).join(", ") || c.overview.noRisks)}</span></div>
            <div><strong>${safetyReview.prompt_injection_file_count || 0}</strong><span>${escapeHtml(c.overview.promptRisks || "prompt-risk files")}</span></div>
            <div><strong>${safetyReview.sensitive_file_count || 0}</strong><span>${escapeHtml(c.overview.sensitiveFiles || "sensitive files")}</span></div>
          </div>
        </section>
      </div>
    </main>
  `;
}

function llmModeBadge() {
  const c = t();
  const configured = state.llmStatus?.llm?.configured;
  const provider = state.llmStatus?.llm?.provider || "";
  const timeout = state.llmStatus?.llm?.request_timeout_ms;
  const timeoutTitle = Number.isFinite(timeout) ? ` | timeout ${timeout}ms` : "";
  if (configured) {
    return `<span class="llm-badge active" title="LLM: ${escapeHtml(provider)} - ${escapeHtml(state.llmStatus?.llm?.model || "")}${escapeHtml(timeoutTitle)}">AI ${escapeHtml(c.chat.modeAI)}</span>`;
  }
  return `<span class="llm-badge fallback" title="Set OPENAI_API_KEY to enable AI mode${escapeHtml(timeoutTitle)}">OFF ${escapeHtml(c.chat.modeFallback)}</span>`;
}

function chatPage() {
  if (!state.project) return emptyProject(t().empty.importCopilot);
  const c = t();
  return html`
    <main class="chat-layout deerflow-inspired">
      <aside class="sidebar">
        <div class="workspace-card">
          <p class="eyebrow">${c.chat.current}</p>
          <h2>${escapeHtml(state.project.name)}</h2>
          <p>${escapeHtml(state.project.summary.overview)}</p>
          <div class="sidebar-stats">
            <span><strong>${state.project.fileCount}</strong> ${c.chat.files}</span>
            <span><strong>${state.project.chunkCount}</strong> ${c.chat.chunks}</span>
          </div>
        </div>
        <h3>${c.chat.recommended}</h3>
        <div class="question-list">
          ${c.chat.q.map((question) => `<button data-question="${escapeHtml(question)}">${escapeHtml(question)}</button>`).join("")}
        </div>
        <h3>${c.chat.qualityRules}</h3>
        <div class="rule-list">
          ${c.chat.rules.map((rule) => `<span>${rule}</span>`).join("")}
        </div>
        <h3>${c.chat.filesTitle}</h3>
        <div class="compact-files">
          ${state.project.files.slice(0, 14).map((file) => `<code>${escapeHtml(file.path)}</code>`).join("")}
        </div>
      </aside>

      <section class="workspace">
        <div class="workspace-topline">
          <div>
            <span>${c.chat.workspace}</span>
            <strong>${escapeHtml(state.project.name)}</strong>
          </div>
          <div class="topline-right">
            ${llmModeBadge()}
            <button class="secondary" data-page="overview">${c.chat.projectMap}</button>
          </div>
        </div>
        <div class="tabs">
          ${[
            ["qa", "Q&A"],
            ["impact", c.chat.impact],
            ["agent", c.chat.agent],
            ["onboarding", c.chat.onboarding]
          ].map(([id, label]) => `<button class="tab ${state.activeTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`).join("")}
        </div>
        <div id="tabContent">
          ${renderTabContent(state.activeTab)}
        </div>
      </section>

      <aside class="inspector">
        <div class="inspector-section">
          <p class="eyebrow">${c.chat.evidenceDock}</p>
          <h3>${c.chat.retrieval}</h3>
          <div class="compact-files">
            ${state.project.summary.recommendedFiles.slice(0, 8).map((file) => `<code>${escapeHtml(file)}</code>`).join("")}
          </div>
        </div>
        <div class="inspector-section">
          <h3>${c.chat.contract}</h3>
          <div class="contract-list">
            ${c.chat.contractItems.map((item) => `<span>${item}</span>`).join("")}
          </div>
        </div>
        <div class="inspector-section quality-meter">
          <h3>${c.chat.qualitySnapshot}</h3>
          <div><strong>${metricValue(state.metrics?.citation_coverage)}%</strong><span>${c.home.citationCoverage}</span></div>
          <div><strong>${metricValue(state.metrics?.helpful_rate)}%</strong><span>${c.chat.helpfulRate}</span></div>
        </div>
        ${renderMemoryManager()}
      </aside>
    </main>
  `;
}

function memoryPreferenceRows(preferences = {}) {
  const rows = [];
  if (preferences.role) rows.push(["role", preferences.role]);
  if (preferences.language) rows.push(["language", preferences.language]);
  if (preferences.detailLevel) rows.push(["detailLevel", preferences.detailLevel]);
  (preferences.focusAreas || []).forEach((value) => rows.push(["focusAreas", value]));
  (preferences.taskTypes || []).forEach((value) => rows.push(["taskTypes", value]));
  return rows;
}

function renderMemoryManager() {
  const c = t();
  const title = c.chat.preferenceMemory;
  const empty = c.chat.noSavedPreferences;
  const clear = c.chat.clearAll;
  const remove = c.chat.removeMemory;
  const preferences = state.memory?.preferences || {};
  const events = (state.memory?.events || []).slice(0, 5);
  const longTermMemories = (state.memory?.long_term_memories || []).slice(0, 5);
  const rows = memoryPreferenceRows(preferences);
  return html`
    <div class="inspector-section memory-manager">
      <h3>${title}</h3>
      ${rows.length ? `
        <div class="memory-preferences">
          ${rows.map(([key, value]) => `
            <div>
              <span><strong>${escapeHtml(key)}</strong>${escapeHtml(String(value))}</span>
              <button data-memory-forget-key="${escapeHtml(key)}" data-memory-forget-value="${escapeHtml(String(value))}">${remove}</button>
            </div>
          `).join("")}
        </div>
        <button class="secondary memory-clear" data-memory-forget-all="true">${clear}</button>
      ` : `<p class="muted">${empty}</p>`}
      <div class="memory-events">
        <h4>${c.chat.memoryAudit}</h4>
        ${events.length ? `
          <div class="feedback-log">
            ${events.map((item) => {
              const preference = [item.key, item.value].filter(Boolean).join(": ");
              return `<div>
                <code>${escapeHtml(item.status || item.action || "event")}</code>
                <span>${escapeHtml(preference || item.label || "memory")}</span>
                <span>${escapeHtml(item.createdAt ? new Date(item.createdAt).toLocaleString() : "")}</span>
              </div>`;
            }).join("")}
          </div>
        ` : `<p class="muted">${c.chat.noMemoryEventsYet}</p>`}
      </div>
      <div class="memory-events">
        <h4>${c.chat.longTermMemory}</h4>
        ${longTermMemories.length ? `
          <div class="feedback-log">
            ${longTermMemories.map((item) => `<div>
              <code>${escapeHtml(item.type || "memory")}</code>
              <span>${escapeHtml([item.key, item.value].filter(Boolean).join(": ") || item.content || "memory")}</span>
              <span>${escapeHtml(item.confidence || "medium")}</span>
            </div>`).join("")}
          </div>
        ` : `<p class="muted">${c.chat.noLongTermMemoriesYet}</p>`}
      </div>
    </div>
  `;
}

function renderTabContent(tab) {
  if (tab === "impact") return qaTab("impact");
  if (tab === "agent") return qaTab("agent");
  if (tab === "onboarding") return onboardingTab();
  return qaTab("qa");
}

function qaTab(kind = "qa") {
  const c = t();
  const isImpact = kind === "impact";
  const isAgent = kind === "agent";
  const placeholder = isAgent ? c.chat.agentPlaceholder : isImpact ? c.chat.impactPlaceholder : c.chat.askPlaceholder;
  const helper = isAgent ? c.chat.agentHelp : isImpact ? c.chat.impactHelp : c.chat.qaHelp;
  const eyebrow = isAgent ? c.chat.agentEyebrow : isImpact ? c.chat.impactEyebrow : c.chat.qaEyebrow;
  const title = isAgent ? c.chat.agentTitle : isImpact ? c.chat.impactTitle : c.chat.qaTitle;
  const action = isAgent ? "agentImpact" : isImpact ? "impact" : "ask";
  const buttonLabel = isAgent ? c.chat.runAgent : isImpact ? c.chat.analyze : c.chat.ask;
  return html`
    <div class="task-intro">
      <div>
        <p class="eyebrow">${eyebrow}</p>
        <h2>${title}</h2>
      </div>
      <p>${helper}</p>
    </div>
    <div class="messages">
      ${state.messages.length ? state.messages.map(renderMessage).join("") : emptyChatState(kind)}
    </div>
    <div class="composer prompt-composer">
      <textarea id="questionInput" rows="3" placeholder="${placeholder}">${escapeHtml(state.draftQuestion)}</textarea>
      <div class="composer-footer">
        <div class="composer-tools">
          <span>${isAgent ? c.chat.traceable : isImpact ? c.chat.riskAware : c.chat.repoGrounded}</span>
          <span>${c.chat.topChunks}</span>
          <span>${c.chat.citationsRequired}</span>
        </div>
        <button class="primary" data-action="${action}" ${state.loading ? "disabled" : ""}>${buttonLabel}</button>
      </div>
    </div>
  `;
}

function emptyChatState(kind) {
  const c = t();
  const items = kind === "agent"
    ? c.chat.agentSuggestions
    : kind === "impact"
    ? c.chat.impactSuggestions
    : c.chat.q.slice(0, 3);
  const title = kind === "agent" ? c.chat.agentReady : kind === "impact" ? c.chat.impactReady : c.chat.ready;
  const body = kind === "agent" ? c.chat.agentReadyText : kind === "impact" ? c.chat.impactReadyText : c.chat.readyText;
  return html`
    <div class="agent-welcome">
      <div class="agent-avatar">AI</div>
      <h2>${title}</h2>
      <p>${body}</p>
      <div class="suggestion-grid">
        ${items.map((item) => `<button data-question="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}
      </div>
    </div>
  `;
}

function onboardingTab() {
  const c = t();
  return html`
    <div class="task-intro">
      <div>
        <p class="eyebrow">${c.chat.roleRamp}</p>
        <h2>${c.chat.planTitle}</h2>
      </div>
      <p>${c.chat.planHelp}</p>
    </div>
    <div class="onboarding-form">
      <label>
        <span>${c.chat.role}</span>
        <select id="roleSelect">
          <option>Backend Engineer</option>
          <option>Frontend Engineer</option>
          <option>Product Manager</option>
          <option>QA</option>
        </select>
      </label>
      <label>
        <span>${c.chat.duration}</span>
        <select id="durationSelect">
          <option>3 days</option>
          <option>5 days</option>
        </select>
      </label>
      <button class="primary" data-action="onboarding">${c.chat.generatePlan}</button>
    </div>
    <div class="messages">
      ${state.messages.length ? state.messages.map(renderMessage).join("") : `
        <div class="agent-welcome">
          <div class="agent-avatar">AI</div>
          <h2>${c.chat.plannerReady}</h2>
          <p>${c.chat.plannerText}</p>
        </div>
      `}
    </div>
  `;
}

function renderMessage(message) {
  const c = t();
  const payload = message.payload;
  if (message.kind === "impact") return renderImpactMessage(message);
  if (message.kind === "agent_impact") return renderAgentImpactMessage(message);
  if (message.kind === "onboarding") return renderOnboardingMessage(message);

  return html`
    <article class="message">
      <div class="question">${escapeHtml(message.question)}</div>
      <div class="answer">
        <div class="answer-meta">
          ${payload.llm_used
            ? `<span class="llm-source ai">AI ${escapeHtml(c.chat.modeAI)}</span>`
            : `<span class="llm-source fallback">OFF ${escapeHtml(c.chat.modeFallback)}</span>`}
        </div>
        ${renderOptionalRuntimeStatus(payload)}
        <h3>${c.chat.answer}</h3>
        <p>${escapeHtml(payload.answer)}</p>
        <h3>${c.chat.keyPoints}</h3>
        <ul>${renderList(payload.key_points, (point) => `<li>${escapeHtml(point)}</li>`)}</ul>
        <h3>${c.chat.related}</h3>
        <div class="citation-list">
          ${renderList(payload.related_files, (file) => `<div><code>${escapeHtml(file.file_path)}</code><span>${escapeHtml(file.reason)}</span></div>`)}
        </div>
        <h3>${c.chat.uncertainty}</h3>
        <p>${escapeHtml(payload.uncertainty)}</p>
        <h3>${c.chat.next}</h3>
        <div class="chip-row">${renderList(payload.suggested_next_questions, (question) => `<button data-question="${escapeHtml(question)}">${escapeHtml(question)}</button>`)}</div>
        ${feedbackBar(message.answerId)}
      </div>
    </article>
  `;
}

function renderJsonSummary(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join(", ") : item}`)
      .join(" | ");
  }
  return String(value ?? "");
}

function renderRuntimeStatus(payload) {
  const c = t();
  const memory = payload.memory_used || {};
  const harness = payload.harness || {};
  const safety = payload.safety || {};
  const outputRedaction = safety.output_redaction || {};
  const budget = harness.budget_status || {};
  const modelAdapter = harness.model_adapter || {};
  const pendingMemory = (payload.memory_suggestions || []).filter((item) => item.status === "pending").length;
  const memoryStatus = [
    memory.used ? memory.summary : c.chat.noMemory,
    `${pendingMemory} ${c.chat.pendingMemory}`
  ].filter(Boolean).join(" | ");
  const harnessStatus = [
    harness.run_id ? `run ${String(harness.run_id).slice(0, 18)}` : null,
    harness.runtime || c.chat.agentRuntime,
    harness.model_mode || c.chat.unknown,
    `${harness.steps_executed || 0} ${c.chat.steps}`,
    `${harness.duration_ms ?? 0}${c.chat.durationMs}`,
    harness.fallback_used ? c.chat.fallbackUsed : c.chat.noFallback,
    harness.fallback_reason,
    modelAdapter.error_code,
    modelAdapter.http_status ? `HTTP ${modelAdapter.http_status}` : null,
    budget.step_budget_exceeded || budget.timeout_exceeded || budget.context_budget_exceeded ? c.chat.budgetExceeded : c.chat.budgetOk
  ].filter(Boolean).join(" | ");
  const safetyStatus = [
    safety.status || c.chat.unknown,
    ...(safety.risk_types || []),
    outputRedaction.applied ? `redacted ${outputRedaction.match_count || 0}` : null
  ].filter(Boolean).join(" | ");
  const cards = [
    [c.chat.memory, memoryStatus],
    [c.chat.harness, harnessStatus],
    [c.chat.safety, safetyStatus]
  ];
  return html`
    <div class="runtime-status">
      ${cards.map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`).join("")}
    </div>
  `;
}

function renderOptionalRuntimeStatus(payload) {
  return payload?.harness || payload?.safety ? renderRuntimeStatus(payload) : "";
}

function renderMemorySuggestions(suggestions = []) {
  const c = t();
  const visible = suggestions.slice(0, 3);
  if (!visible.length) return "";
  return html`
    <h3>${c.chat.memorySuggestions}</h3>
    <div class="memory-suggestions">
      ${visible.map((item) => `
        <div>
          <strong>${escapeHtml(item.label || item.key)}</strong>
          <span>${escapeHtml(item.key)} = ${escapeHtml(String(item.value))} / ${escapeHtml(item.confidence || "medium")}</span>
          <p>${escapeHtml(item.reason || "")}</p>
          ${item.status === "pending"
            ? `<div class="memory-actions">
                <button data-memory-action="confirm" data-suggestion="${escapeHtml(item.id)}">${c.chat.saveMemory}</button>
                <button data-memory-action="ignore" data-suggestion="${escapeHtml(item.id)}">${c.chat.ignoreMemory}</button>
              </div>`
            : `<span class="memory-state">${escapeHtml(item.status || c.chat.unknown)}</span>`}
        </div>
      `).join("")}
    </div>
  `;
}

function renderAgentImpactMessage(message) {
  const c = t();
  const payload = message.payload;
  return html`
    <article class="message agent-message">
      <div class="question">${escapeHtml(message.question)}</div>
      <div class="answer">
        <div class="agent-header">
          <div>
            <h3>${escapeHtml(payload.agent?.name || "Impact Analysis Agent")}</h3>
            <p>${escapeHtml(payload.agent?.pattern || "stateful multi-agent graph workflow")}</p>
          </div>
          <span>${escapeHtml(payload.guardrails?.every((guardrail) => guardrail.status === "passed") ? c.chat.guardrailsPassed : c.chat.needsReview)}</span>
        </div>

        ${renderRuntimeStatus(payload)}

        ${payload.hitl?.paused ? html`
          <div class="hitl-card paused" id="hitl-${escapeHtml(message.answerId)}">
            <h3>&#9888; ${c.chat.hitlPaused || "Human Review Required"}</h3>
            <p>${escapeHtml(payload.hitl.reason || c.chat.hitlDefaultReason)}</p>
            <div class="hitl-actions">
              <button class="primary" data-hitl-action="approve" data-answer-id="${escapeHtml(message.answerId)}" data-run-id="${escapeHtml(payload.harness?.run_id || "")}">&#10003; ${c.chat.hitlApprove || "Approve"}</button>
              <button class="danger" data-hitl-action="reject" data-answer-id="${escapeHtml(message.answerId)}" data-run-id="${escapeHtml(payload.harness?.run_id || "")}">&#10007; ${c.chat.hitlReject || "Reject"}</button>
            </div>
          </div>
        ` : ""}
        ${payload.hitl?.approved ? html`
          <div class="hitl-card approved"><h3>&#10003; ${c.chat.hitlApproved || "Approved by Reviewer"}</h3></div>
        ` : ""}
        ${payload.hitl?.rejected ? html`
          <div class="hitl-card rejected"><h3>&#10007; ${c.chat.hitlRejected || "Rejected by Reviewer"}</h3></div>
        ` : ""}

        ${payload.agent_roster ? html`
          <div class="agent-roster">
            <h3>${c.chat.agentRoster || "Agent Roster"}</h3>
            <div class="agent-roster-list">
              ${renderList(Object.keys(payload.agent_roster), (role) => `
                <span class="agent-badge" title="${escapeHtml((payload.agent_roster[role] || []).join(', '))}">${escapeHtml(role)}</span>
              `)}
            </div>
          </div>
        ` : ""}

        ${payload.handoffs?.length ? html`
          <div class="agent-handoff">
            <h3>${c.chat.agentHandoff || "Agent Handoff Flow"}</h3>
            <div class="handoff-chain">
              ${payload.handoffs.map((h) => html`
                <span class="handoff-item" title="${escapeHtml(h.reason || '')}">${escapeHtml(h.sender)} &rarr; ${escapeHtml(h.recipient)}</span>
              `).join("")}
            </div>
          </div>
        ` : ""}

        <h3>${c.chat.impactSummary}</h3>
        <p>${escapeHtml(payload.summary)}</p>

        <div class="agent-meta-grid">
          <section>
            <h3>${c.chat.agentInstructions}</h3>
            <ul>${renderList(payload.agent?.instructions, (item) => `<li>${escapeHtml(item)}</li>`)}</ul>
          </section>
          <section>
            <h3>${c.chat.frameworkConcepts}</h3>
            <div class="tag-list">${renderList(payload.agent?.framework_concepts, (item) => `<span>${escapeHtml(item)}</span>`)}</div>
          </section>
        </div>

        <h3>${c.chat.agentTrace}</h3>
        <div class="trace-list">
          ${renderList(payload.trace, (step) => html`
            <div class="trace-step">
              <strong>${escapeHtml(step.step)}</strong>
              ${step.agent_role ? html`<span class="agent-role-badge">${escapeHtml(step.agent_role)}</span>` : ""}
              <code>${escapeHtml(step.tool)}</code>
              <p>${escapeHtml(step.purpose)}</p>
              <small>${escapeHtml(renderJsonSummary(step.output))}</small>
              ${(step.citations || []).length ? `<div class="compact-files">${step.citations.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>` : ""}
            </div>
          `)}
        </div>

        <h3>${c.chat.impactAreas}</h3>
        <div class="impact-list">
          ${renderList(payload.impact_areas, (area) => `
            <div>
              <strong>${escapeHtml(area.area)} <span class="risk ${escapeHtml(area.risk_level)}">${escapeHtml(area.risk_level)}</span></strong>
              <p>${escapeHtml(area.reason)}</p>
              <div class="compact-files">${(area.files || []).map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>
            </div>
          `)}
        </div>

        <h3>${c.chat.guardrails}</h3>
        <div class="guardrail-list">
          ${renderList(payload.guardrails, (guardrail) => `
            <div class="${escapeHtml(guardrail.status)}">
              <strong>${escapeHtml(guardrail.name)}</strong>
              <span>${escapeHtml(guardrail.status)}</span>
              <p>${escapeHtml(guardrail.detail)}</p>
            </div>
          `)}
        </div>

        ${renderMemorySuggestions(payload.memory_suggestions)}

        <h3>${c.chat.evidence}</h3>
        <div class="citation-list">
          ${renderList(payload.related_files, (file) => `<div><code>${escapeHtml(file.file_path)}</code><span>${escapeHtml(file.reason)}</span></div>`)}
        </div>
        <h3>${c.chat.tests}</h3>
        <ul>${renderList(payload.testing_suggestions, (item) => `<li>${escapeHtml(item)}</li>`)}</ul>
        <h3>${c.chat.openQuestions}</h3>
        <ul>${renderList(payload.open_questions, (item) => `<li>${escapeHtml(item)}</li>`)}</ul>
        <h3>${c.chat.uncertainty}</h3>
        <p>${escapeHtml(payload.uncertainty)}</p>
        ${feedbackBar(message.answerId)}
      </div>
    </article>
  `;
}

function renderImpactMessage(message) {
  const c = t();
  const payload = message.payload;
  return html`
    <article class="message">
      <div class="question">${escapeHtml(message.question)}</div>
      <div class="answer">
        <h3>${c.chat.impactSummary}</h3>
        <p>${escapeHtml(payload.summary)}</p>
        <h3>${c.chat.impactAreas}</h3>
        <div class="impact-list">
          ${renderList(payload.impact_areas, (area) => `
            <div>
              <strong>${escapeHtml(area.area)} <span class="risk ${escapeHtml(area.risk_level)}">${escapeHtml(area.risk_level)}</span></strong>
              <p>${escapeHtml(area.reason)}</p>
              <div class="compact-files">${(area.files || []).map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>
            </div>
          `)}
        </div>
        <h3>${c.chat.tests}</h3>
        <ul>${renderList(payload.testing_suggestions, (item) => `<li>${escapeHtml(item)}</li>`)}</ul>
        <h3>${c.chat.openQuestions}</h3>
        <ul>${renderList(payload.open_questions, (item) => `<li>${escapeHtml(item)}</li>`)}</ul>
        ${feedbackBar(message.answerId)}
      </div>
    </article>
  `;
}

function renderOnboardingMessage(message) {
  const c = t();
  const payload = message.payload;
  return html`
    <article class="message">
      <div class="question">${escapeHtml(payload.role)} · ${escapeHtml(payload.duration)}</div>
      <div class="answer">
        ${renderOptionalRuntimeStatus(payload)}
        <h3>${c.chat.goal}</h3>
        <p>${escapeHtml(payload.goal)}</p>
        <div class="plan-grid">
          ${renderList(payload.plan, (day) => `
            <div class="plan-day">
              <strong>${escapeHtml(day.day)}</strong>
              <p>${escapeHtml(day.focus)}</p>
              <h4>${c.chat.filesTitle}</h4>
              <div class="compact-files">${(day.files_to_read || []).map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>
              <h4>${c.chat.tasks}</h4>
              <ul>${(day.tasks || []).map((task) => `<li>${escapeHtml(task)}</li>`).join("")}</ul>
            </div>
          `)}
        </div>
        <h3>${c.chat.guardrails}</h3>
        <div class="guardrail-list">
          ${renderList(payload.guardrails, (guardrail) => `
            <div class="${escapeHtml(guardrail.status)}">
              <strong>${escapeHtml(guardrail.name)}</strong>
              <span>${escapeHtml(guardrail.status)}</span>
              <p>${escapeHtml(guardrail.detail)}</p>
            </div>
          `)}
        </div>
        ${renderMemorySuggestions(payload.memory_suggestions)}
        ${feedbackBar(message.answerId)}
      </div>
    </article>
  `;
}

function feedbackBar(answerId) {
  const types = t().feedback;
  return `<div class="feedback">${types.map(([type, label]) => `<button data-feedback="${type}" data-answer="${escapeHtml(answerId)}">${label}</button>`).join("")}</div>`;
}

function failureReasons(metrics) {
  const c = t();
  const reasons = metrics.top_failure_reasons?.length
    ? metrics.top_failure_reasons
    : [
        { type: "missing_citation", count: 12 },
        { type: "too_generic", count: 8 },
        { type: "inaccurate", count: 7 }
      ];
  const max = Math.max(...reasons.map((item) => item.count), 1);
  return html`
    <div class="failure-bars">
      ${reasons.map((item) => `
        <div class="failure-bar">
          <div>
            <strong>${escapeHtml(item.type.replaceAll("_", " "))}</strong>
            <span>${escapeHtml(String(item.count))} ${c.dashboard.occurrences}</span>
          </div>
          <i style="--value:${Math.max(8, Math.round((item.count / max) * 100))}%"></i>
        </div>
      `).join("")}
    </div>
  `;
}

function rankedBars(items = []) {
  const c = t();
  const values = items.length ? items : [{ type: "none", count: 0 }];
  const max = Math.max(...values.map((item) => item.count), 1);
  return html`
    <div class="failure-bars">
      ${values.map((item) => `
        <div class="failure-bar">
          <div>
            <strong>${escapeHtml(String(item.type).replaceAll("_", " "))}</strong>
            <span>${escapeHtml(String(item.count))} ${c.dashboard.occurrences}</span>
          </div>
          <i style="width:${Math.max(6, (item.count / max) * 100)}%"></i>
        </div>
      `).join("")}
    </div>
  `;
}

function recentHarnessRuns(items = []) {
  if (!items.length) return `<p class="empty-inline">No harness runs yet.</p>`;
  return html`
    <div class="feedback-log">
      ${items.map((item) => {
        const risks = (item.risk_types || []).slice(0, 2).join(", ");
        const budget = item.budget_status?.context_budget_exceeded
          ? "context budget"
          : item.budget_status?.timeout_exceeded
            ? "timeout"
            : item.budget_status?.step_budget_exceeded
              ? "step budget"
              : "within budget";
        const status = [
          item.safety_status || "unknown",
          item.schema_valid === false ? "schema invalid" : "schema valid",
          budget,
          item.fallback_used ? "fallback" : "no fallback",
          `${item.duration_ms || 0}ms`
        ].join(" | ");
        return `<div>
          <code>${escapeHtml(String(item.run_id || "").slice(0, 18))}</code>
          <span>${escapeHtml(item.kind || "run")} | ${escapeHtml(item.runtime || "runtime")} | ${escapeHtml(item.model_provider || "")}</span>
          <span>${escapeHtml(status)}${risks ? ` | ${escapeHtml(risks)}` : ""}</span>
          <button class="text-button" data-harness-run="${escapeHtml(item.run_id || "")}">Audit</button>
        </div>`;
      }).join("")}
    </div>
  `;
}

function harnessAuditPanel(audit) {
  if (!audit) return "";
  const c = t();
  const trace = audit.answer?.trace || [];
  const harness = audit.answer?.harness || {};
  const safety = audit.answer?.safety || {};
  const riskDetails = audit.run?.risk_details || safety.risk_details || [];
  const budget = audit.run?.budget_status || harness.budget_status || {};
  const adapter = audit.run?.model_adapter || harness.model_adapter || {};
  return html`
    <section class="panel span-3">
      <h2>${c.harness.auditTitle}</h2>
      <div class="runtime-status">
        <div><strong>${c.harness.runLabel}</strong><span>${escapeHtml(audit.run?.run_id || "")}</span></div>
        <div><strong>${c.harness.runtimeLabel}</strong><span>${escapeHtml(audit.run?.runtime || harness.runtime || "")}</span></div>
        <div><strong>${c.harness.modelLabel}</strong><span>${escapeHtml([adapter.provider, adapter.model].filter(Boolean).join(" / ") || audit.run?.model_provider || "")}</span></div>
        <div><strong>${c.harness.schemaLabel}</strong><span>${escapeHtml((audit.run?.schema_valid ?? harness.schema_valid) === false ? c.harness.schemaInvalid : c.harness.schemaValid)}</span></div>
        <div><strong>${c.harness.budgetLabel}</strong><span>${escapeHtml(budget.context_budget_exceeded ? c.harness.budgetContextExceeded : budget.timeout_exceeded ? c.harness.budgetTimeoutExceeded : budget.step_budget_exceeded ? c.harness.budgetStepExceeded : c.harness.budgetWithinBudget)}</span></div>
        <div><strong>${c.harness.safetyLabel}</strong><span>${escapeHtml(audit.run?.safety_status || safety.status || c.chat.unknown)}</span></div>
        <div><strong>${c.harness.fallbackLabel}</strong><span>${escapeHtml(audit.run?.fallback_used ? c.harness.fallbackTrue : c.harness.fallbackFalse)}</span></div>
      </div>
      <div class="trace-list compact-trace">
        ${riskDetails.length ? `
          <div class="trace-step">
            <strong>${c.harness.riskDetails}</strong>
            <span>${escapeHtml(riskDetails.map((item) => item.type).join(", "))}</span>
            <p>${escapeHtml(riskDetails.map((item) => item.description).join(" "))}</p>
          </div>
        ` : ""}
        ${renderList(trace, (step) => `
          <div class="trace-step">
            <strong>${escapeHtml(step.step || step.tool || c.harness.stepFallback)}</strong>
            <span>${escapeHtml(step.tool || c.harness.toolFallback)}</span>
            <p>${escapeHtml(step.purpose || "")}</p>
          </div>
        `)}
      </div>
    </section>
  `;
}

function recentSafetyEvents(items = []) {
  if (!items.length) return `<p class="empty-inline">No safety events yet.</p>`;
  return html`
    <div class="feedback-log">
      ${items.map((item) => {
        const risks = (item.risk_types || []).slice(0, 3).join(", ") || item.safety_status || "unknown";
        const guardrails = (item.guardrails || []).slice(0, 2).join(", ");
        return `<div>
          <code>${escapeHtml(String(item.run_id || item.answer_id || "").slice(0, 18))}</code>
          <span>${escapeHtml(item.kind || "answer")} | ${escapeHtml(risks)}</span>
          <span>${guardrails ? escapeHtml(guardrails) : escapeHtml(item.safety_status || "needs review")}</span>
        </div>`;
      }).join("")}
    </div>
  `;
}

function recentRedactionEvents(items = []) {
  if (!items.length) return `<p class="empty-inline">No redactions yet.</p>`;
  return html`
    <div class="feedback-log">
      ${items.map((item) => `<div>
        <code>${escapeHtml(String(item.run_id || item.answer_id || "").slice(0, 18))}</code>
        <span>${escapeHtml(item.kind || "answer")} | ${escapeHtml(String(item.marker || "[REDACTED_SECRET]"))}</span>
        <span>${escapeHtml(`${item.match_count || 0} matches`)}</span>
      </div>`).join("")}
    </div>
  `;
}

function recentToolPolicyEvents(items = []) {
  if (!items.length) return `<p class="empty-inline">No tool policy events yet.</p>`;
  return html`
    <div class="feedback-log">
      ${items.map((item) => {
        const tools = (item.trace_tools || []).slice(0, 2).join(", ");
        return `<div>
          <code>${escapeHtml(String(item.run_id || item.answer_id || "").slice(0, 18))}</code>
          <span>${escapeHtml(item.kind || "answer")} | ${escapeHtml(item.policy_mode || "unknown")} | ${escapeHtml(item.status || "passed")}</span>
          <span>${escapeHtml(tools || "no trace tools")}</span>
        </div>`;
      }).join("")}
    </div>
  `;
}

function recentMemoryEvents(items = []) {
  if (!items.length) return `<p class="empty-inline">No memory events yet.</p>`;
  return html`
    <div class="feedback-log">
      ${items.map((item) => {
        const preference = [item.key, item.value].filter(Boolean).join(": ");
        return `<div>
          <code>${escapeHtml(item.status || "pending")}</code>
          <span>${escapeHtml(preference || item.label || "memory")}</span>
          <span>${escapeHtml(item.confidence || "medium")}</span>
        </div>`;
      }).join("")}
    </div>
  `;
}

function renderAuthOperationsPanel() {
  const c = t();
  const auth = state.auth || {};
  const users = auth.users || [];
  const tokens = auth.tokens || [];
  const events = auth.events || [];
  const activeTokens = tokens.filter((item) => item.status === "active").length;
  const tokenStatus = state.authToken ? c.auth.tokenSet : c.auth.noToken;
  return html`
    <section class="panel span-3 auth-ops">
      <div class="panel-title-row">
        <div>
          <h2>${c.auth.title}</h2>
          <p>${escapeHtml(tokenStatus)} | ${users.length} ${escapeHtml(c.auth.usersLabel)} | ${activeTokens} ${escapeHtml(c.auth.activeTokensLabel)}</p>
        </div>
        <button class="secondary" data-auth-action="refresh">${c.dashboard.refresh}</button>
      </div>

      <div class="auth-token-row">
        <label>
          <span>${c.auth.apiToken}</span>
          <input data-auth-token-input type="password" autocomplete="off" value="${escapeHtml(state.authToken || "")}" placeholder="${escapeHtml(c.auth.tokenPlaceholder)}">
        </label>
        <button data-auth-action="save-token">${c.auth.saveToken}</button>
        <button class="secondary" data-auth-action="clear-token">${c.auth.clear}</button>
      </div>

      ${auth.error ? `<p class="auth-error">${escapeHtml(auth.error)}</p>` : ""}
      ${auth.createdToken ? `<div class="auth-created-token">
        <strong>${c.auth.oneTimeToken}</strong>
        <code>${escapeHtml(auth.createdToken)}</code>
      </div>` : ""}

      <div class="auth-grid">
        <div class="auth-form">
          <h3>${c.auth.createUser}</h3>
          <label><span>${c.auth.userId}</span><input id="authUserIdInput" autocomplete="off" placeholder="pm-user"></label>
          <label><span>${c.chat.role}</span><input id="authRoleInput" autocomplete="off" value="viewer"></label>
          <label><span>${c.auth.scopes}</span><input id="authScopesInput" autocomplete="off" value="project:read"></label>
          <label><span>${c.auth.orgId}</span><input id="authOrgInput" autocomplete="off" placeholder="${escapeHtml(c.auth.optional)}"></label>
          <label class="auth-checkbox"><input id="authIssueTokenInput" type="checkbox" checked><span>${c.auth.issueToken}</span></label>
          <button data-auth-action="create-user">${c.auth.createUserButton}</button>
        </div>

        <div class="auth-list">
          <h3>${c.auth.usersHeading}</h3>
          ${users.length ? users.map((user) => `
            <div>
              <span>
                <strong>${escapeHtml(user.id || user.userId || c.chat.unknown)}</strong>
                <small>${escapeHtml([user.role, user.source, user.status].filter(Boolean).join(" | "))}</small>
                <small>${escapeHtml((user.scopes || []).join(", ") || c.auth.noScopes)}</small>
              </span>
              ${user.source === "store" && user.status !== "disabled"
                ? `<button class="text-button danger-text" data-auth-disable-user="${escapeHtml(user.id || user.userId || "")}">${c.auth.disable}</button>`
                : ""}
            </div>
          `).join("") : `<p class="empty-inline">${c.auth.noUsers}</p>`}
        </div>

        <div class="auth-list">
          <h3>${c.auth.tokensHeading}</h3>
          ${tokens.length ? tokens.map((token) => `
            <div>
              <span>
                <strong>${escapeHtml(token.userId || c.chat.unknown)}</strong>
                <small>${escapeHtml([token.tokenPrefix, token.status, token.source].filter(Boolean).join(" | "))}</small>
                <small>${escapeHtml((token.scopes || []).join(", ") || c.auth.noScopes)}</small>
              </span>
            </div>
          `).join("") : `<p class="empty-inline">${c.auth.noTokens}</p>`}
        </div>

        <div class="auth-list">
          <h3>${c.auth.recentEvents}</h3>
          ${events.length ? events.slice(0, 6).map((event) => `
            <div>
              <span>
                <strong>${escapeHtml(event.status || c.chat.unknown)}</strong>
                <small>${escapeHtml([event.userId, event.requiredScope, event.reason].filter(Boolean).join(" | "))}</small>
                <small>${escapeHtml(event.pathname || "")}</small>
              </span>
            </div>
          `).join("") : `<p class="empty-inline">${c.auth.noEvents}</p>`}
        </div>
      </div>
    </section>
  `;
}

function dashboardPage() {
  if (!state.project) return emptyProject(t().empty.importMetrics);
  const c = t();
  const metrics = state.metrics || {
    total_questions: 0,
    helpful_rate: 0,
    citation_coverage: 0,
    uncertain_answer_rate: 0,
    negative_feedback_rate: 0,
    agent_runs: 0,
    high_risk_questions: 0,
    guardrail_hits: 0,
    output_redaction_runs: 0,
    output_redaction_matches: 0,
    memory_confirmations: 0,
    fallback_runs: 0,
    harness_run_snapshots: 0,
    average_response_time_ms: 0,
    safety_risk_counts: [],
    safety_status_counts: [],
    citation_status_counts: [],
    memory_status_counts: [],
    memory_event_counts: [],
    harness_runtime_counts: [],
    model_mode_counts: [],
    tool_policy_counts: [],
    budget_status_counts: [],
    schema_status_counts: [],
    llm_usage_counts: [],
    trace_tool_counts: [],
    import_safety_status: "not_applicable",
    import_safety_risk_counts: [],
    import_prompt_risk_file_count: 0,
    import_sensitive_file_count: 0,
    import_prompt_risk_files: [],
    import_sensitive_files: [],
    fallback_reasons: [],
    recent_harness_runs: [],
    recent_safety_events: [],
    recent_tool_policy_events: [],
    recent_redaction_events: [],
    recent_memory_events: [],
    top_failure_reasons: [],
    recent_feedback: []
  };
  const metricCards = [
    [c.dashboard.total, metrics.total_questions],
    [c.dashboard.agentRuns, metrics.agent_runs || 0],
    [c.dashboard.helpful, `${metrics.helpful_rate}%`],
    [c.dashboard.citation, `${metrics.citation_coverage}%`],
    [c.dashboard.uncertain, `${metrics.uncertain_answer_rate}%`],
    [c.dashboard.negative, `${metrics.negative_feedback_rate}%`],
    [c.dashboard.highRisk, metrics.high_risk_questions],
    [c.dashboard.guardrailHits, metrics.guardrail_hits || 0],
    [c.dashboard.outputRedactions, metrics.output_redaction_runs || 0],
    [c.dashboard.redactedMatches, metrics.output_redaction_matches || 0],
    [c.dashboard.memorySaves, metrics.memory_confirmations || 0],
    [c.dashboard.fallbackRuns, metrics.fallback_runs || 0],
    [c.dashboard.harnessSnapshots, metrics.harness_run_snapshots || 0],
    [c.dashboard.avgResponse, `${metrics.average_response_time_ms || 0}ms`]
  ];
  const citationStatusLabel = c.dashboard.citationStatus || "引用状态";
  return html`
    <main class="page-shell">
      <div class="section-head row-head">
        <div>
          <p class="eyebrow">${c.dashboard.eyebrow}</p>
          <h1>${c.dashboard.title}</h1>
          <p>${c.dashboard.desc}</p>
        </div>
        <button class="secondary" data-action="refreshMetrics">${c.dashboard.refresh}</button>
      </div>

      <section class="metrics-grid">
        ${metricCards.map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("")}
      </section>

      <div class="overview-grid">
        <section class="panel">
          <h2>${c.dashboard.failures}</h2>
          ${failureReasons(metrics)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.safetyRisks}</h2>
          ${rankedBars(metrics.safety_risk_counts)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.importSafetyTitle}</h2>
          <div class="evidence-stats">
            <div><strong>${escapeHtml(metrics.import_safety_status || "not_applicable")}</strong><span>${escapeHtml((metrics.import_safety_risk_counts || []).map((item) => item.type).join(", ") || c.overview.noRisks)}</span></div>
            <div><strong>${metrics.import_prompt_risk_file_count || 0}</strong><span>${c.overview.promptRisks}</span></div>
            <div><strong>${metrics.import_sensitive_file_count || 0}</strong><span>${c.overview.sensitiveFiles}</span></div>
          </div>
        </section>
        <section class="panel">
          <h2>${c.dashboard.safetyStatus}</h2>
          ${rankedBars(metrics.safety_status_counts)}
        </section>
        <section class="panel">
          <h2>${citationStatusLabel}</h2>
          ${rankedBars(metrics.citation_status_counts)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.memoryStatus}</h2>
          ${rankedBars(metrics.memory_status_counts)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.memoryEventsTitle}</h2>
          ${rankedBars(metrics.memory_event_counts)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.harnessRuntime}</h2>
          ${rankedBars(metrics.harness_runtime_counts)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.modelMode}</h2>
          ${rankedBars(metrics.model_mode_counts)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.toolPolicy}</h2>
          ${rankedBars(metrics.tool_policy_counts)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.budgetStatus}</h2>
          ${rankedBars(metrics.budget_status_counts)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.schemaStatus}</h2>
          ${rankedBars(metrics.schema_status_counts)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.llmUsage}</h2>
          ${rankedBars(metrics.llm_usage_counts)}
        </section>
        <section class="panel span-2">
          <h2>${c.dashboard.traceTools}</h2>
          ${rankedBars(metrics.trace_tool_counts)}
        </section>
        <section class="panel span-2">
          <h2>${c.dashboard.recentToolPolicyTitle}</h2>
          ${recentToolPolicyEvents(metrics.recent_tool_policy_events)}
        </section>
        <section class="panel span-2">
          <h2>${c.dashboard.recentSafety}</h2>
          ${recentSafetyEvents(metrics.recent_safety_events)}
        </section>
        <section class="panel span-2">
          <h2>${c.dashboard.recentRedactionsTitle}</h2>
          ${recentRedactionEvents(metrics.recent_redaction_events)}
        </section>
        <section class="panel span-2">
          <h2>${c.dashboard.recentMemory}</h2>
          ${recentMemoryEvents(metrics.recent_memory_events)}
        </section>
        <section class="panel">
          <h2>${c.dashboard.fallbackReasons}</h2>
          ${rankedBars(metrics.fallback_reasons)}
        </section>
        <section class="panel span-2">
          <h2>${c.dashboard.recentRuns}</h2>
          ${recentHarnessRuns(metrics.recent_harness_runs)}
        </section>
        ${harnessAuditPanel(state.harnessAudit)}
        ${renderAuthOperationsPanel()}
        <section class="panel span-2">
          <h2>${c.dashboard.recent}</h2>
          <div class="feedback-log">
            ${renderList(metrics.recent_feedback, (item) => {
              const run = item.harness_run_id ? `run ${String(item.harness_run_id).slice(0, 18)}` : item.answer_kind || "answer";
              const status = [item.answer_kind, item.safety_status].filter(Boolean).join(" / ");
              return `<div><code>${escapeHtml(item.type)}</code><span>${escapeHtml(run)}</span><span>${escapeHtml(status || new Date(item.createdAt).toLocaleString())}</span></div>`;
            })}
          </div>
        </section>
        <section class="panel span-3 improvement-panel">
          <h2>${c.dashboard.signals}</h2>
          <div class="iteration-grid">
            ${c.dashboard.signalItems.map(([title, text]) => `<div><strong>${title}</strong><span>${text}</span></div>`).join("")}
          </div>
        </section>
      </div>
    </main>
  `;
}

function emptyProject(message) {
  const c = t();
  return html`
    <main class="page-shell narrow empty">
      <h1>${c.empty.title}</h1>
      <p>${escapeHtml(message)}</p>
      <button class="primary" data-page="import">${c.empty.button}</button>
    </main>
  `;
}

function render() {
  const questionInput = document.querySelector("#questionInput");
  if (questionInput) state.draftQuestion = questionInput.value;
  const pages = {
    landing: landingPage,
    import: importPage,
    overview: overviewPage,
    chat: chatPage,
    dashboard: dashboardPage
  };
  app.innerHTML = nav() + (state.errorBanner ? html`
    <div class="error-banner">
      <span>${escapeHtml(state.errorBanner.message)}</span>
      <button data-retry>Retry</button>
      <button data-dismiss-error>Dismiss</button>
    </div>
  ` : "") + pages[state.page]();
}

async function importRepository({ sample = false } = {}) {
  if (state.loading) return;
  try {
    state.loading = true;
    state.progress = [];
    render();
    for (const step of progressSteps.slice(0, -1)) {
      state.progress.push(step);
      render();
      await new Promise((resolve) => setTimeout(resolve, 220));
    }

    let body = { sample };
    if (!sample) {
      const repoUrl = document.querySelector("#repoUrl")?.value.trim();
      const file = document.querySelector("#zipFile")?.files?.[0];
      if (file) {
        const zipBase64 = await fileToBase64(file);
        body = { zipBase64, fileName: file.name };
      } else {
        body = { repoUrl };
      }
    }

    const payload = await api("/api/import", {
      method: "POST",
      body: JSON.stringify(body)
    });
    state.project = payload.project;
    state.projects.push(payload.project);
    state.messages = [];
    state.memory = null;
    state.progress.push("Ready");
    state.page = "overview";
    await refreshMetrics(false);
    await refreshMemory(false);
    render();
  } catch (error) {
    showError(error);
    state.progress = [];
    render();
  } finally {
    state.loading = false;
    render();
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read ZIP file."));
    reader.readAsDataURL(file);
  });
}

async function ask(kind = "qa", questionOverride = "") {
  if (state.loading) return;
  const input = document.querySelector("#questionInput");
  const question = questionOverride || input?.value.trim();
  if (!question) return;
  if (input) input.value = "";
  state.loading = true;
  state.messages.unshift({
    kind: "local",
    answerId: "pending",
    question,
    payload: { answer: "Thinking...", key_points: [], related_files: [], uncertainty: "", suggested_next_questions: [] }
  });
  render();
  try {
    const payload = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ projectId: state.project.id, question, kind })
    });
    state.messages = state.messages.filter((item) => item.answerId !== "pending");
    state.messages.unshift({
      kind: payload.kind,
      answerId: payload.answerId,
      question,
      payload: payload.payload
    });
    await refreshMetrics(false);
    await refreshMemory(false);
  } catch (error) {
    showError(error, () => ask(kind, question));
    state.messages = state.messages.filter((item) => item.answerId !== "pending");
  } finally {
    state.loading = false;
    render();
  }
}

async function runAgentImpact(questionOverride = "") {
  if (state.loading) return;
  const input = document.querySelector("#questionInput");
  const question = questionOverride || input?.value.trim();
  if (!question) return;
  if (input) input.value = "";
  state.loading = true;
  state.messages.unshift({
    kind: "local",
    answerId: "pending",
    question,
    payload: { answer: "Running agent workflow...", key_points: [], related_files: [], uncertainty: "", suggested_next_questions: [] }
  });
  render();
  try {
    const payload = await api("/api/agent-impact", {
      method: "POST",
      body: JSON.stringify({ projectId: state.project.id, question })
    });
    state.messages = state.messages.filter((item) => item.answerId !== "pending");
    state.messages.unshift({
      kind: payload.kind,
      answerId: payload.answerId,
      question,
      payload: payload.payload
    });
    await refreshMetrics(false);
    await refreshMemory(false);
  } catch (error) {
    showError(error, () => runAgentImpact(question));
    state.messages = state.messages.filter((item) => item.answerId !== "pending");
  } finally {
    state.loading = false;
    render();
  }
}

async function generateOnboarding() {
  try {
    const role = document.querySelector("#roleSelect")?.value || "Backend Engineer";
    const duration = document.querySelector("#durationSelect")?.value || "3 days";
    const payload = await api("/api/onboarding", {
      method: "POST",
      body: JSON.stringify({ projectId: state.project.id, role, duration })
    });
    state.messages.unshift({
      kind: "onboarding",
      answerId: payload.answerId,
      question: `Generate onboarding plan for ${role}, ${duration}`,
      payload: payload.payload
    });
    await refreshMetrics(false);
    render();
  } catch (error) {
    showError(error);
  }
}

async function sendFeedback(answerId, type) {
  try {
    const payload = await api("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ answerId, type })
    });
    state.metrics = payload.metrics;
    const button = document.querySelector(`[data-answer="${answerId}"][data-feedback="${type}"]`);
    if (button) button.classList.add("selected");
  } catch (error) {
    showError(error);
  }
}

async function handleHitlDecision(decision, answerId, runId) {
  const c = t();
  try {
    const card = document.getElementById(`hitl-${answerId}`);
    if (card) card.innerHTML = `<p>${escapeHtml(c.chat.hitlSubmitting || "Submitting decision...")}</p>`;
    const resumed = await api("/api/langgraph-resume", {
      method: "POST",
      body: JSON.stringify({ projectId: state.project?.id, runId, decision })
    });
    state.messages = state.messages.map((message) => {
      if (message.answerId !== answerId || !message.payload?.hitl) return message;
      return {
        ...message,
        payload: {
          ...message.payload,
          hitl: {
            ...message.payload.hitl,
            paused: false,
            approved: decision === "approve",
            rejected: decision === "reject"
          }
        }
      };
    });
    if (decision === "approve") {
      state.messages.unshift({
        question: c.chat.hitlApprovedMessage,
        kind: "agent_impact",
        payload: resumed.payload,
        answerId: resumed.answerId
      });
    } else {
      state.messages.unshift({
        question: c.chat.hitlRejectedMessage,
        kind: "agent_impact",
        payload: resumed.payload,
        answerId: resumed.answerId
      });
    }
    render();
  } catch (error) {
    showError(error);
  }
}

async function handleMemorySuggestion(suggestionId, action) {
  try {
    const endpoint = action === "confirm" ? "/api/memory/confirm" : "/api/memory/forget";
    await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ suggestionId, projectId: state.project?.id })
    });
    state.messages = state.messages.map((message) => {
      const suggestions = message.payload?.memory_suggestions;
      if (!Array.isArray(suggestions)) return message;
      return {
        ...message,
        payload: {
          ...message.payload,
          memory_suggestions: suggestions.map((item) => item.id === suggestionId
            ? { ...item, status: action === "confirm" ? "confirmed" : "ignored" }
            : item)
        }
      };
    });
    await refreshMetrics(false);
    await refreshMemory(false);
    render();
  } catch (error) {
    showError(error);
  }
}

async function forgetMemoryPreference(key, value) {
  try {
    const body = key
      ? { projectId: state.project?.id, key, value }
      : { projectId: state.project?.id };
    const payload = await api("/api/memory/forget", {
      method: "POST",
      body: JSON.stringify(body)
    });
    state.memory = {
      preferences: payload.preferences,
      suggestions: payload.suggestions || state.memory?.suggestions || [],
      events: payload.events || state.memory?.events || [],
      long_term_memories: payload.long_term_memories || state.memory?.long_term_memories || []
    };
    await refreshMetrics(false);
    await refreshMemory(false);
    render();
  } catch (error) {
    showError(error);
  }
}

async function refreshMetrics(shouldRender = true) {
  if (!state.project) return;
  const payload = await api(`/api/evaluation?projectId=${encodeURIComponent(state.project.id)}`);
  state.metrics = payload.metrics;
  if (shouldRender) render();
}

async function refreshAuthAdmin(shouldRender = true) {
  try {
    const [usersPayload, eventsPayload] = await Promise.all([
      api("/api/auth/users"),
      api("/api/auth/events?limit=20")
    ]);
    state.auth = {
      users: usersPayload.users || [],
      tokens: usersPayload.tokens || [],
      events: eventsPayload.events || [],
      error: null,
      createdToken: state.auth?.createdToken || null
    };
  } catch (error) {
    state.auth = {
      users: [],
      tokens: [],
      events: [],
      error: `${error.message || "Auth endpoints unavailable."}${error.code ? ` [${error.code}]` : ""}`,
      createdToken: null
    };
  }
  if (shouldRender) render();
}

function saveBrowserAuthToken(sourceElement = null) {
  const token = sourceElement?.closest(".auth-token-row, .topbar-auth")?.querySelector("[data-auth-token-input]")?.value?.trim()
    || document.querySelector("[data-auth-token-input]")?.value?.trim()
    || "";
  state.authToken = token;
  if (token) localStorage.setItem("aido-api-token", token);
  else localStorage.removeItem("aido-api-token");
  state.auth = { ...(state.auth || {}), createdToken: null };
  refreshAuthAdmin();
}

async function createAuthUserFromForm() {
  try {
    const userId = document.querySelector("#authUserIdInput")?.value?.trim();
    const role = document.querySelector("#authRoleInput")?.value?.trim() || "viewer";
    const scopes = (document.querySelector("#authScopesInput")?.value || "project:read")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const orgId = document.querySelector("#authOrgInput")?.value?.trim() || null;
    const issueToken = !!document.querySelector("#authIssueTokenInput")?.checked;
    const payload = await api("/api/auth/users", {
      method: "POST",
      body: JSON.stringify({ userId, role, scopes, orgId, issueToken })
    });
    await refreshAuthAdmin(false);
    state.auth = { ...(state.auth || {}), error: null, createdToken: payload.token || null };
    render();
  } catch (error) {
    showError(error);
  }
}

async function disableAuthUser(userId) {
  if (!userId) return;
  const c = t();
  const confirmMessage = (c.auth.disableConfirmTemplate || "").replace("{user}", userId);
  if (!confirm(confirmMessage)) return;
  try {
    await api("/api/auth/users/disable", {
      method: "POST",
      body: JSON.stringify({ userId })
    });
    state.auth = { ...(state.auth || {}), createdToken: null };
    await refreshAuthAdmin();
  } catch (error) {
    showError(error);
  }
}

async function loadHarnessAudit(runId) {
  if (!state.project || !runId) return;
  try {
    state.harnessAudit = await api(`/api/harness-run?projectId=${encodeURIComponent(state.project.id)}&runId=${encodeURIComponent(runId)}`);
    render();
  } catch (error) {
    showError(error);
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  render();
}

document.addEventListener("click", (event) => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    setPage(pageButton.dataset.page);
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    const action = actionButton.dataset.action;
    if (action === "sample") importRepository({ sample: true });
    if (action === "import") importRepository();
    if (action === "ask") ask("qa");
    if (action === "impact") ask("impact");
    if (action === "agentImpact") runAgentImpact();
    if (action === "onboarding") generateOnboarding();
    if (action === "refreshMetrics") refreshMetrics();
    return;
  }

  const langButton = event.target.closest("[data-lang]");
  if (langButton) {
    setLanguage(langButton.dataset.lang);
    return;
  }

  const tab = event.target.closest("[data-tab]");
  if (tab) {
    switchTab(tab.dataset.tab);
    return;
  }

  const question = event.target.closest("[data-question]");
  if (question) {
    setPage("chat");
    requestAnimationFrame(() => {
      const input = document.querySelector("#questionInput");
      if (input) input.value = question.dataset.question;
    });
    return;
  }

  const feedback = event.target.closest("[data-feedback]");
  if (feedback) {
    sendFeedback(feedback.dataset.answer, feedback.dataset.feedback);
    return;
  }

  const forgetAllMemory = event.target.closest("[data-memory-forget-all]");
  if (forgetAllMemory) {
    forgetMemoryPreference();
    return;
  }

  const forgetMemory = event.target.closest("[data-memory-forget-key]");
  if (forgetMemory) {
    forgetMemoryPreference(forgetMemory.dataset.memoryForgetKey, forgetMemory.dataset.memoryForgetValue);
    return;
  }

  const memoryButton = event.target.closest("[data-memory-action]");
  if (memoryButton) {
    handleMemorySuggestion(memoryButton.dataset.suggestion, memoryButton.dataset.memoryAction);
    return;
  }

  const authAction = event.target.closest("[data-auth-action]");
  if (authAction) {
    const action = authAction.dataset.authAction;
    if (action === "refresh") refreshAuthAdmin();
    if (action === "save-token") saveBrowserAuthToken(authAction);
    if (action === "clear-token") {
      state.authToken = "";
      localStorage.removeItem("aido-api-token");
      state.auth = { users: [], tokens: [], events: [], error: null, createdToken: null };
      render();
    }
    if (action === "create-user") createAuthUserFromForm();
    return;
  }

  const disableAuth = event.target.closest("[data-auth-disable-user]");
  if (disableAuth) {
    disableAuthUser(disableAuth.dataset.authDisableUser);
    return;
  }

  const harnessRunButton = event.target.closest("[data-harness-run]");
  if (harnessRunButton) {
    loadHarnessAudit(harnessRunButton.dataset.harnessRun);
    return;
  }

  const hitlButton = event.target.closest("[data-hitl-action]");
  if (hitlButton) {
    handleHitlDecision(hitlButton.dataset.hitlAction, hitlButton.dataset.answerId, hitlButton.dataset.runId);
    return;
  }

  const retryButton = event.target.closest("[data-retry]");
  if (retryButton && state.errorBanner?.retryFn) {
    const retryFn = state.errorBanner.retryFn;
    clearError();
    retryFn();
    return;
  }

  const dismissError = event.target.closest("[data-dismiss-error]");
  if (dismissError) {
    clearError();
    return;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.target?.id === "questionInput") {
    event.preventDefault();
    const submitButton = event.target.closest(".composer")?.querySelector("[data-action]");
    if (submitButton && !submitButton.disabled) submitButton.click();
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    const workflowCard = event.target.closest?.(".workflow-card[role=\"button\"]");
    if (workflowCard) {
      event.preventDefault();
      setPage(workflowCard.dataset.page);
    }
  }
});

await loadProjects();
await checkHealth();
render();
