import { buildImportRequestBody } from "./import-request.js";

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
  // 顶部导航和 Auth Operations 面板里各有一份 token 输入框（同一个逻辑值的
  // 两处 UI 呈现）。draftAuthToken 是它们共用的"正在编辑中"的镜像值：null 表示
  // 当前没有未保存的编辑，直接显示 authToken；一旦用户在任意一处输入，
  // captureFormStateBeforeRender() 会把当前值写进这里，后续任何后台触发的
  // render() 都用它回填两处输入框，而不是回退成已保存的 authToken 把输入清空。
  draftAuthToken: null,
  llmStatus: null,
  lang: localStorage.getItem("aido-lang") || "en",
  activeTab: "qa",
  // 每个 tab (qa/impact/agent) 各自独立的未提交草稿，切 tab 不再互相覆盖或清空
  // 对方的输入。onboarding tab 没有自由文本框，不需要在这里占位。
  drafts: { qa: "", impact: "", agent: "" },
  // Onboarding 计划的角色/时长 <select> 选中值镜像。默认值对应模板里两个
  // <select> 的第一个 <option>，与 generateOnboarding() 的 DOM 兜底默认一致。
  onboardingRole: "Backend Engineer",
  onboardingDuration: "3 days",
  // "创建本地用户"表单的镜像值，用于在表单填写过程中被 refreshMetrics() 等
  // 后台异步刷新触发的 render() 打断时保留已输入内容。真正提交时
  // createAuthUserFromForm() 仍然直接读 DOM（更接近用户提交那一刻的真实值），
  // 这里只用于渲染回填。
  authUserForm: { userId: "", role: "viewer", scopes: "project:read", orgId: "", issueToken: true },
  // 展开中的 <details class="tech-details"> 集合，成员是渲染时赋给该元素的
  // data-details-id（详情见 techDetailsWrapper()）。原生 <summary> 点击会直接
  // 切换该 DOM 节点的 open 属性，不需要 JS 介入；这里只是在下一次全局 render()
  // 清空 DOM 之前，把"当前哪些还开着"读出来记进 state，render 时再按这份记录
  // 决定要不要带 open 属性。
  expandedDetails: new Set(),
  // 正在提交反馈、尚未拿到响应的 answerId 集合。message.feedbackGiven 只在
  // 响应回来之后才会被写入，feedbackBar() 的 disabled 属性也只在下一次
  // render() 才生效——两者都覆盖不了"点击那一刻到响应返回之前"这段窗口：
  // 同一个按钮被快速连点两次，或者同一条消息的两个不同按钮被快速点两次，
  // 都会在这段窗口内让两个 sendFeedback() 调用同时越过检查，各自发出一次
  // /api/feedback 请求，写进 store 两条重复或互相矛盾的反馈记录。这个 Set
  // 在 sendFeedback() 入口处、任何 await 之前同步检查并写入，把这段窗口也
  // 锁住。
  feedbackInFlight: new Set(),
  // 已经播放过打字机渐显动画的消息 answerId 集合；一旦某个 id 进入这个集合就
  // 永远不再重播（即便动画途中被重渲染打断），重渲染时只会把全文直接显示出来。
  playedMessages: new Set(),
  // 通用"正在处理中"操作键集合，横向复用 feedbackInFlight 的同步加锁模式，
  // 但覆盖 sendFeedback 之外的所有会并发触发多个请求的异步操作（生成
  // onboarding 计划、确认/忽略记忆建议、创建/禁用认证用户、拉取 harness
  // 审计等）。key 按"操作类型:目标 id"拼接（例如 `memory-suggestion:${id}`、
  // `auth-disable:${userId}`），同一个 key 在进入 await 之前同步 add()、
  // finally 里统一 delete()，配合 render() 时按 key 判断 disabled，避免每个
  // 操作都单独发明一个专属布尔字段。
  busyKeys: new Set(),
  // 已经成功从 GET /api/answers 拉取过历史问答、重建进 state.messages 的
  // projectId。restoreConversationHistory() 用它把"每次 setPage 进
  // chat tab"这个天然会被反复触发的入口收窄成"每个项目至多真正发一次请求"：
  // 命中同一个项目直接短路返回，避免每次切 tab/刷新触发的 setPage("chat")
  // 都重新拉一遍已经拉过的历史（接口本身是幂等只读的，重复调用不会出错，
  // 这里纯粹是省一次没必要的网络请求）。切换到别的项目后这个值不匹配，会
  // 重新拉一次该项目的历史。
  //
  // 项目切换器落地（switchProject()，见下方）已经处理了 reviewer 之前留下的
  // 两个待办：① 切换项目时把这个标记重置为 null，让切回一个曾经恢复过的旧
  // 项目也能重新拉一次（这期间 store 里可能已经有新问答写入）；② state.messages
  // 本身依然不按 projectId 过滤（messagesForTab() 只按 message.tab 过滤），
  // 所以 switchProject() 里连同这个标记一起清空 state.messages，不依赖这里
  // 单独加过滤逻辑。
  historyRestoredForProjectId: null
};

const app = document.querySelector("#app");

// 打字机渐显：逐块（15-25 字符/步）显示新到达的回答主文本，总时长目标封顶
// ~1.2s。注意 TYPEWRITER_MAX_DURATION_MS 是"目标"总时长，不是硬上限：每步
// 间隔会被 clamp 到 TYPEWRITER_MIN_INTERVAL_MS（约一帧）为下限，避免 interval
// 被要求以不现实的速度触发；文本特别长、需要的步数特别多时，
// 步数 × TYPEWRITER_MIN_INTERVAL_MS 可能超过 1200ms，实际播放时间会比目标
// 略长——这是"保证每一步间隔仍然有意义"和"总时长绝对不超过 1.2s"两者之间
// 有意的取舍，不是 bug。
const TYPEWRITER_STEP_CHARS = 20;
const TYPEWRITER_MAX_DURATION_MS = 1200;
const TYPEWRITER_MIN_INTERVAL_MS = 16;
// answerId -> setInterval 句柄，记录当前正在播放的动画，便于重渲染前统一清理，
// 避免它们在下一次 innerHTML 重建后继续对已经被丢弃的旧 DOM 节点写入。
const activeTypewriterTimers = new Map();

const progressSteps = [
  "Uploading",
  "Parsing files",
  "Creating local retrieval index",
  "Generating project summary",
  "Ready"
];

const copy = {
  en: {
    brand: "Repomentor",
    nav: { landing: "Product", import: "Import", overview: "Overview", chat: "Copilot", dashboard: "Evaluation", brandAria: "Go to product page", languageAria: "Language switch" },
    common: { retry: "Retry", dismiss: "Dismiss" },
    projectSwitcher: {
      label: "Project",
      aria: "Switch project",
      switching: "Switching...",
      empty: "No projects yet"
    },
    home: {
      title: "Repository onboarding, with evidence.",
      subtitle: "Import a repo, inspect the project map, ask grounded questions, analyze change impact, and measure answer quality.",
      launch: "Launch sample workspace",
      importRepo: "Import repository",
      workspace: "WORKSPACE",
      previewNav: { overview: "Overview", qa: "Q&A", impact: "Impact", evaluation: "Evaluation" },
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
        ["03", "Ask", "Answer repository questions with cited files.", "chat", "qa"],
        ["04", "Analyze", "Map code changes to risk and test coverage.", "chat", "impact"],
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
      ],
      switchExisting: "Or switch to an existing project"
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
      briefingTitle: "Business Impact Briefing",
      briefingFlows: "Affected Flows",
      briefingTesting: "What to Verify",
      briefingRisk: "Risk & Recommendation",
      techDetails: "Technical details (modules, citations, trace)",
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
      modelAgents: "Model Agent Calls",
      supervisorPlan: "Supervisor Plan",
      criticReview: "QA Critic Review",
      preferenceMemory: "Preference memory",
      noSavedPreferences: "No saved preferences",
      clearAll: "Clear all",
      removeMemory: "Remove",
      // Confirmation prompts for the two destructive memory-forget entry points
      // (parity with c.auth.disableConfirmTemplate's {placeholder} convention).
      clearAllConfirm: "Clear all saved preferences? This cannot be undone.",
      removeMemoryConfirm: "Remove the saved preference \"{key} = {value}\"?",
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
      occurrences: "occurrences",
      qualitySummary: {
        title: "Quality summary",
        empty: "Ask a few questions in Copilot to generate a quality summary from real usage.",
        citation: "Across {total} questions, {citationPct}% of answers cite the exact files behind them — grounded, not guessed.",
        guardrail: "Guardrails flagged {guardrailHits} answers for safety review and automatically redacted {redactionMatches} sensitive matches — every answer is scanned, none pass silently.",
        fallback: "The LLM call failed or was skipped {fallbackRuns} times; the system fell back to deterministic retrieval instead of producing an ungrounded answer.",
        feedback: "Of the feedback collected, {helpfulRate}% marked answers helpful and {negativeRate}% flagged an issue for follow-up."
      },
      groups: {
        trust: {
          title: "Trustworthiness",
          desc: "Whether answers are grounded in real files and pass schema validation — the basis for trusting any single answer."
        },
        safety: {
          title: "Safety",
          desc: "What guardrails caught, what got redacted, and what import-time risks were flagged before they reached a user."
        },
        reliability: {
          title: "Reliability",
          desc: "How the system behaves when the model is slow, unavailable, or over budget — and whether it degrades gracefully."
        },
        usage: {
          title: "Usage & feedback",
          desc: "How much the product is actually used, and what real users say about the answers it gives."
        }
      },
      methodology: {
        title: "How this evaluation works",
        intro: "Every answer automatically records a harness run snapshot (trace, schema validation, budget/timeout status), a citation check against the imported repository, and an input/retrieval/output safety scan — no external LLMOps tool is wired in.",
        bullet1: "Harness snapshot: runtime, model mode, budget status, and fallback state are captured on every agent run.",
        bullet2: "Citation validation: every answer's file references are checked against the actual imported repository.",
        bullet3: "Safety scan: input, retrieval, and output are scanned for injection, secrets, and policy violations before an answer is returned.",
        link: "Read the full harness/safety implementation in docs/AGENT_RUNTIME_ARCHITECTURE.md"
      }
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
      importImpact: "Import a repository before analyzing change impact.",
      importMetrics: "Import a repository before viewing evaluation metrics."
    }
  },
  zh: {
    brand: "Repomentor",
    nav: { landing: "产品", import: "导入", overview: "总览", chat: "Copilot", dashboard: "评估", brandAria: "前往产品首页", languageAria: "语言切换" },
    common: { retry: "重试", dismiss: "关闭" },
    projectSwitcher: {
      label: "项目",
      aria: "切换项目",
      switching: "切换中…",
      empty: "暂无项目"
    },
    home: {
      title: "有证据的代码库入门。",
      subtitle: "导入仓库，查看项目地图，提出有引用的问题，分析变更影响，并衡量 AI 回答质量。",
      launch: "启动示例工作区",
      importRepo: "导入仓库",
      workspace: "工作区",
      previewNav: { overview: "总览", qa: "问答", impact: "影响分析", evaluation: "评估" },
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
        ["03", "提问", "基于仓库内容回答，并引用文件来源。", "chat", "qa"],
        ["04", "分析", "评估代码改动影响范围和测试风险。", "chat", "impact"],
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
      ],
      switchExisting: "或切换到已有项目"
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
      briefingTitle: "业务影响简报",
      briefingFlows: "受影响的业务流程",
      briefingTesting: "需要验证什么",
      briefingRisk: "风险与建议",
      techDetails: "技术详情（模块、引用、执行轨迹）",
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
      modelAgents: "模型 Agent 调用",
      supervisorPlan: "Supervisor 执行计划",
      criticReview: "QA Critic 独立复核",
      preferenceMemory: "偏好记忆",
      noSavedPreferences: "暂无已保存偏好",
      clearAll: "清空",
      removeMemory: "删除",
      clearAllConfirm: "确定要清空全部已保存的偏好吗？此操作无法撤销。",
      removeMemoryConfirm: "确定要删除已保存的偏好 \"{key} = {value}\" 吗？",
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
      occurrences: "次",
      qualitySummary: {
        title: "质量摘要",
        empty: "先在 Copilot 里提几个问题，看板会基于真实使用数据生成质量摘要。",
        citation: "过去 {total} 个问题中，引用覆盖率为 {citationPct}%——多数回答能定位到具体代码文件，不是凭空生成。",
        guardrail: "护栏对 {guardrailHits} 次回答标记待复核，并自动脱敏 {redactionMatches} 处敏感信息匹配——每次回答都会被扫描，没有一次静默放行。",
        fallback: "模型调用失败或被跳过时，系统 {fallbackRuns} 次自动回退到确定性检索，没有输出无依据的回答。",
        feedback: "在收集到的反馈中，{helpfulRate}% 标记为有帮助，{negativeRate}% 标记出了需要跟进的问题。"
      },
      groups: {
        trust: {
          title: "可信度",
          desc: "回答是否基于真实文件、是否通过 schema 校验——这是能不能相信单条回答的基础。"
        },
        safety: {
          title: "安全",
          desc: "护栏拦下了什么、脱敏处理了什么、导入时又标记出哪些风险——在触达用户之前先过一道。"
        },
        reliability: {
          title: "可靠性",
          desc: "模型变慢、不可用或超预算时系统如何应对——是否能优雅降级而不是直接报错。"
        },
        usage: {
          title: "使用与反馈",
          desc: "产品实际被用了多少、真实用户对回答给出了什么反馈。"
        }
      },
      methodology: {
        title: "这套评估体系是怎么采集的",
        intro: "每次回答都会自动记录一份 harness 运行快照（执行轨迹、schema 校验、预算/超时状态）、一次针对导入仓库的引用校验，以及一轮输入/检索/输出三级安全扫描——不需要接入任何外部 LLMOps 工具。",
        bullet1: "Harness 快照：每次 agent 运行都会记录运行时、模型模式、预算状态和 fallback 状态。",
        bullet2: "引用校验：每条回答里的文件引用都会对照实际导入的仓库进行核实。",
        bullet3: "安全扫描：回答返回前，输入、检索内容和输出都会被扫描 prompt 注入、密钥泄露和策略违规。",
        link: "完整的 harness/安全实现见 docs/AGENT_RUNTIME_ARCHITECTURE.md"
      }
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
      importImpact: "导入仓库后才能分析变更影响。",
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

// Boot-time default: before the project switcher existed, this always
// resolved to "whatever was imported most recently" (payload.projects.at(-1))
// with no way to land anywhere else after a refresh -- there was nothing to
// choose between since only the last import was ever reachable. Now that
// switchProject() lets a session have several live projects, a refresh
// should restore *the one the user was actually looking at*, not silently
// snap back to the newest import out from under them. switchProject()
// persists the chosen id to localStorage on every switch; this prefers that
// id (if it still resolves to a project the server returned) and only falls
// back to "most recent" for a first-ever visit or a persisted id that no
// longer exists (e.g. a different browser/profile with its own project
// list).
async function loadProjects() {
  try {
    const payload = await api("/api/projects");
    state.projects = payload.projects;
    if (!state.project) {
      const persistedId = localStorage.getItem("aido-active-project");
      const persisted = persistedId ? payload.projects.find((item) => item.id === persistedId) : null;
      state.project = persisted || payload.projects.at(-1) || null;
    }
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
  // Captured up front so the response can be checked against whatever
  // state.project is by the time the request actually resolves -- see the
  // guard right after the await below.
  const projectId = state.project.id;
  // Mirrors checkHealth()'s own try/catch just above: this is a best-effort
  // background refresh of a side panel, called both directly from setPage()
  // (via Promise.all(...).then(render), which has no .catch of its own) and
  // from inside half a dozen other actions' own try blocks after their
  // primary request already succeeded. Left uncaught, a failure here used to
  // reject the Promise.all() in setPage() with no handler (an unhandled
  // rejection that silently left llmStatus/memory stale) and, worse, could
  // abort whichever *other* action's try block happened to be awaiting it
  // mid-flight, misattributing a memory-panel hiccup to that action's own
  // error banner. Swallow it here (log only) so callers only ever see
  // failures in the request they actually care about.
  try {
    const payload = await api(`/api/memory?projectId=${encodeURIComponent(projectId)}`);
    // switchProject() can reassign state.project while this request is still
    // in flight (e.g. the user switches again before the first switch's own
    // memory refresh has resolved). Committing a response keyed by the *old*
    // projectId at that point would overwrite the new project's memory panel
    // with the previous project's data -- discard it instead of applying it.
    if (state.project?.id === projectId) state.memory = payload;
  } catch (error) {
    console.error("refreshMemory failed:", error);
  }
  if (shouldRender) render();
}

// Maps a stored answer's `kind` (the values server.js's answer records use:
// "qa"/"impact" from /api/chat, "agent_impact" from /api/agent-impact,
// "onboarding" from /api/onboarding) to the chat tab id that owns it. This is
// the same kind-to-tab mapping ask()/runAgentImpact()/generateOnboarding()
// already bake into every message they push live (see message.tab --
// messagesForTab() filters on it); restoreConversationHistory() below needs
// it to reconstruct that same `tab` field for messages that were never
// pushed live in this session at all.
function tabForAnswerKind(kind) {
  if (kind === "agent_impact") return "agent";
  if (kind === "onboarding") return "onboarding";
  if (kind === "impact") return "impact";
  return "qa";
}

// Refresh-survives-conversation-history: GET /api/answers replays a
// project's persisted Q&A/impact/agent-impact/onboarding history. server.js
// already stores the full answer payload (trace, harness, safety, citations
// -- everything renderMessage() needs), so this reconstructs state.messages
// at full fidelity instead of a stub, keyed by the same answerId the live
// flow already uses.
//
// Called from setPage() every time the chat page is entered (see below), but
// state.historyRestoredForProjectId short-circuits every call after the
// first successful one for the same project: this is meant to run once per
// project per session (right after a refresh, or the first time a returning
// visitor opens the chat tab), not to re-fetch on every tab click. A failed
// attempt deliberately leaves that flag unset (only a *successful* restore
// counts), so a transient failure gets a real retry the next time the user
// enters the chat tab instead of being stuck silently empty for the rest of
// the session; state.busyKeys still guards against two of those retries
// racing each other concurrently.
//
// Historical messages must not replay the typewriter animation (they were
// already "typed" in a previous session) -- see mountTypewriters()/
// typewriterParagraph(), which skip any answerId already in
// state.playedMessages. Restored messages are deduplicated against whatever
// is already in state.messages by answerId, so a restore that races with (or
// follows) a live answer already pushed into memory this session can't
// duplicate it.
async function restoreConversationHistory() {
  if (!state.project) return;
  const projectId = state.project.id;
  if (state.historyRestoredForProjectId === projectId) return;
  const busyKey = `history-restore:${projectId}`;
  if (state.busyKeys.has(busyKey)) return;
  state.busyKeys.add(busyKey);
  try {
    const payload = await api(`/api/answers?projectId=${encodeURIComponent(projectId)}&limit=50`);
    // switchProject() can move state.project on to a *different* project
    // while this fetch is still in flight (e.g. two switches fired in quick
    // succession). Merging this response at that point would splice the
    // first project's history into whatever the second project has already
    // rendered -- the exact cross-project leakage the switcher is supposed
    // to prevent. Bail out without merging and, importantly, without setting
    // historyRestoredForProjectId: the next time the user lands back on this
    // project, restoreConversationHistory() should still treat it as
    // "never successfully restored" and actually retry the fetch.
    if (state.project?.id !== projectId) return;
    const existingIds = new Set(state.messages.map((message) => message.answerId));
    const restored = (payload.answers || [])
      .filter((answer) => !existingIds.has(answer.answerId))
      .map((answer) => ({
        kind: answer.kind,
        tab: tabForAnswerKind(answer.kind),
        answerId: answer.answerId,
        question: answer.question,
        payload: answer.payload,
        ...(answer.feedbackGiven ? { feedbackGiven: answer.feedbackGiven } : {})
      }));
    // Older messages first: this history came from the same store-persisted
    // project state.project already points at, so nothing already in
    // state.messages this session can predate it.
    state.messages = [...restored, ...state.messages];
    restored.forEach((message) => state.playedMessages.add(message.answerId));
    state.historyRestoredForProjectId = projectId;
  } catch (error) {
    // Best-effort enhancement, not a critical path: restoring history is not
    // allowed to block or fail the rest of the page, so this only logs.
    console.error("restoreConversationHistory failed:", error);
  } finally {
    state.busyKeys.delete(busyKey);
  }
}

// localStorage key for the last project the user explicitly switched to (or
// imported). Read by loadProjects() on boot so a refresh lands back on the
// project the user was actually looking at instead of always snapping to
// "whatever was imported most recently" -- see the comment on loadProjects().
const ACTIVE_PROJECT_STORAGE_KEY = "aido-active-project";

// Switches the workspace to a different already-imported project (picked
// from the project switcher in nav(), or the "switch to an existing project"
// shortcut on the import page). Before this existed, state.project could
// only ever move forward to whatever importRepository() had just created --
// there was no UI path back to an earlier import, even though both
// state.projects and GET /api/projects already supported it.
//
// Three things have to happen together, all called out in the reviewer note
// that used to sit on historyRestoredForProjectId's declaration:
//   1. state.messages must be cleared. It is not filtered by projectId
//      anywhere (messagesForTab() only filters by message.tab), so leaving
//      it populated would show the previous project's Q&A/impact/agent
//      history mixed into the new project's chat tabs.
//   2. state.historyRestoredForProjectId must be reset to null so
//      restoreConversationHistory() actually re-fetches for the new project
//      instead of short-circuiting on a stale "already restored" comparison
//      (it compares against state.project.id, which just changed).
//   3. Everything else that is a per-project *snapshot* rather than
//      per-message UI state -- state.memory, state.metrics, state.harnessAudit --
//      must also be cleared so a stale render doesn't briefly (or, if the
//      refetch fails, indefinitely) show the old project's numbers under the
//      new project's name. expandedDetails/feedbackInFlight/playedMessages
//      are keyed by answerId, not projectId: once state.messages is emptied
//      nothing in the new project can collide with a leftover id, so they
//      are left alone (clearing them would just be dead work). state.drafts
//      is unsent input text with no relationship to which project is active;
//      switching projects should not discard something the user typed but
//      hasn't submitted yet.
async function switchProject(projectId) {
  if (!projectId || state.project?.id === projectId) return;
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  // Same synchronous check-then-add-before-any-await guard as every other
  // busyKeys-gated action in this file (see feedbackInFlight's comment for
  // the canonical explanation): the project switcher is disabled while this
  // key is set (see projectSwitcherControl()), but this is the real guard --
  // disabled is only a render()-cycle-late DOM attribute, not a lock.
  const busyKey = "project-switch";
  if (state.busyKeys.has(busyKey)) return;
  state.busyKeys.add(busyKey);
  render();
  try {
    state.project = project;
    state.messages = [];
    state.historyRestoredForProjectId = null;
    state.memory = null;
    state.metrics = null;
    state.harnessAudit = null;
    localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
    // refreshMemory() is already best-effort (internal try/catch, logs on
    // failure) -- safe to await directly. refreshMetrics() is not (see its
    // own definition), so it is wrapped here the same way: a flaky
    // evaluation endpoint should not surface as a scary error banner over
    // what is, from the user's point of view, an ancillary side-panel
    // refresh, not the switch itself. Both are worth refreshing regardless
    // of the current page, since metrics feed the landing preview and the
    // chat quality snapshot in addition to the dashboard.
    const tasks = [refreshMemory(false)];
    tasks.push(refreshMetrics(false).catch((error) => {
      console.error("refreshMetrics failed during project switch:", error);
    }));
    // Only the chat page needs conversation history re-fetched immediately;
    // other pages will trigger it themselves via setPage("chat") the next
    // time the user opens a chat tab, same as a fresh project already does.
    if (state.page === "chat") tasks.push(restoreConversationHistory());
    await Promise.all(tasks);
  } finally {
    state.busyKeys.delete(busyKey);
    render();
  }
}

// ── Hash-based routing ──
// The SPA never touched the History API: the URL never changed regardless
// of which page/tab was active, so the browser back button always left the
// site entirely (there was never anything to go "back" to inside it) and a
// refresh always dropped back to the marketing landing page. Hash routing
// needs zero server-side config -- a hash fragment never leaves the browser
// as part of the request path, so serveStatic() in server.js needs no
// changes at all -- while still giving the browser a real history entry per
// page/tab to step through.
//
// Format: "#/<page>" for every page except chat, which nests its active tab
// as "#/chat/<tab>" (HASH_PAGES/HASH_TABS below list exactly the values
// state.page/state.activeTab already take on elsewhere in this file).
const HASH_PAGES = ["landing", "import", "overview", "chat", "dashboard"];
const HASH_TABS = ["qa", "impact", "agent", "onboarding"];

function hashForState() {
  if (state.page === "chat") return `#/chat/${state.activeTab}`;
  return `#/${state.page}`;
}

// Parses location.hash into { page, tab } (tab only meaningful for
// page === "chat", defaulting to "qa" if the hash names an unrecognized or
// missing tab) or returns null for an empty/unrecognized page. Callers
// decide what to fall back to (see applyRouteFromHash() just below and the
// bootstrap sequence at the bottom of this file) rather than this function
// silently guessing one.
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return null;
  const [page, tab] = raw.split("/");
  if (!HASH_PAGES.includes(page)) return null;
  if (page !== "chat") return { page, tab: null };
  return { page, tab: HASH_TABS.includes(tab) ? tab : "qa" };
}

// Set right before this file assigns location.hash itself, so the
// hashchange listener below can tell "the URL changed because setPage()/
// switchTab() just wrote it" apart from "the URL changed because the user
// clicked back/forward or hand-edited the address bar" and only react to the
// latter. Without this, every setPage()/switchTab() call would loop straight
// back into applyRouteFromHash() and re-run render() (and, for chat/
// dashboard, their side-effect fetches) a second redundant time for a
// navigation that had already fully completed.
let isSelfDrivenHashChange = false;

// Called at the end of setPage()/switchTab() so the URL always mirrors
// state.page/state.activeTab, and symmetrically so the browser's back/
// forward history gets an entry for every page/tab actually visited. Skips
// the write when the hash already matches -- the standard guard for this
// pattern: besides being a no-op, assigning location.hash to its own current
// value still fires `hashchange` in some browsers, which would trip the loop
// guard above for nothing.
function syncLocationHash() {
  const next = hashForState();
  if (location.hash === next) return;
  isSelfDrivenHashChange = true;
  location.hash = next;
}

// Applies whatever route the URL currently names. Used by the hashchange
// listener (back/forward navigation, or a hand-edited address bar) and once
// at startup to restore a refreshed or deep-linked page/tab. An empty or
// unrecognized hash falls back to "landing" -- the same page state.page
// already starts on -- instead of leaving state untouched, so a mistyped or
// stale hash always recovers to a real page rather than silently doing
// nothing.
function applyRouteFromHash() {
  const route = parseHash();
  if (route?.page === "chat") state.activeTab = route.tab;
  setPage(route?.page || "landing");
}

window.addEventListener("hashchange", () => {
  if (isSelfDrivenHashChange) {
    isSelfDrivenHashChange = false;
    return;
  }
  applyRouteFromHash();
});

function setPage(page) {
  state.page = page;
  if (page === "chat") Promise.all([checkHealth(), refreshMemory(false), restoreConversationHistory()]).then(render);
  if (page === "dashboard" && state.project) {
    refreshMetrics();
    refreshAuthAdmin(false);
  }
  syncLocationHash();
  render();
}

function setLanguage(lang) {
  state.lang = lang;
  localStorage.setItem("aido-lang", lang);
  render();
}

// Renders the topbar's project switcher: a single <select> over
// state.projects (already populated by loadProjects()/importRepository()),
// with the current state.project.id selected. Lives in nav() -- which
// render() prepends ahead of every page -- rather than tucked into a single
// page's sidebar, so switching is possible from wherever the user happens to
// be (landing, overview, a chat tab, the dashboard), not just from the one
// page that happens to render a "current workspace" card. Renders nothing
// when there is nothing to switch between: an empty <select> (zero imports)
// or a single option (only one project) would just be topbar clutter with
// no decision to make.
function projectSwitcherControl() {
  if (state.projects.length < 2) return "";
  const c = t();
  const switching = state.busyKeys.has("project-switch");
  const disabled = switching || state.loading;
  const options = state.projects.map((project) => {
    const label = `${project.name} (${sourceLabel(project.source)})`;
    const selected = state.project?.id === project.id ? "selected" : "";
    return `<option value="${escapeHtml(project.id)}" ${selected}>${escapeHtml(label)}</option>`;
  }).join("");
  return html`
    <div class="project-switcher">
      <label class="project-switcher-label" for="projectSwitcherSelect">${escapeHtml(c.projectSwitcher.label)}</label>
      <select id="projectSwitcherSelect" data-project-switch aria-label="${escapeHtml(c.projectSwitcher.aria)}" ${disabled ? "disabled" : ""}>
        ${options}
      </select>
      ${switching ? `<span class="project-switcher-status">${escapeHtml(c.projectSwitcher.switching)}</span>` : ""}
    </div>
  `;
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
        ${projectSwitcherControl()}
        <nav>
          ${items.map(([page, label]) => `<button class="nav-item ${state.page === page ? "active" : ""}" data-page="${page}">${label}</button>`).join("")}
        </nav>
        <div class="topbar-auth">
          <input id="topbarAuthTokenInput" data-auth-token-input type="password" autocomplete="off" value="${escapeHtml(state.draftAuthToken ?? state.authToken ?? "")}" placeholder="${escapeHtml(c.auth.apiToken)}">
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
              <span class="active">${c.home.previewNav.overview}</span>
              <span>${c.home.previewNav.qa}</span>
              <span>${c.home.previewNav.impact}</span>
              <span>${c.home.previewNav.evaluation}</span>
            </div>
            <div class="preview-main">
              <h2>${escapeHtml(projectName)}</h2>
              <p>${escapeHtml(summary)}</p>
              <div class="mini-metrics">
                <span><small>${c.home.filesParsed}</small><strong>${metricValue(state.project?.fileCount)}</strong></span>
                <span><small>${c.home.chunksIndexed}</small><strong>${metricValue(state.project?.chunkCount)}</strong></span>
                <span><small>${c.home.citationCoverage}</small><strong>${metricValue(state.metrics?.citation_coverage)}%</strong></span>
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
          ${cards.map(([num, title, copy, page, tab]) => `
            <article class="workflow-card" data-page="${page}"${tab ? ` data-tab="${tab}"` : ""} role="button" tabindex="0">
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

      ${existingProjectsStrip()}

      <section class="capability-strip">
        ${c.import.caps.map(([title, text]) => `<div><strong>${title}</strong><span>${text}</span></div>`).join("")}
      </section>
    </main>
  `;
}

// Lightweight "or switch to an existing project" shortcut on the import
// page: state.projects.push(payload.project) already makes a freshly
// imported project available the moment importRepository() finishes (see
// its own comment), so anyone re-visiting Import after importing a couple of
// repos otherwise has no way back to them short of the topbar switcher.
// Deliberately not a second full <select> -- one already exists in the
// topbar on every page including this one -- just a few small pills for
// "pick one of these instead of importing yet another copy". Hidden with no
// projects yet, same "nothing to switch between" rule as
// projectSwitcherControl().
function existingProjectsStrip() {
  if (state.projects.length === 0) return "";
  const c = t();
  const busy = state.busyKeys.has("project-switch") || state.loading;
  return html`
    <section class="existing-projects">
      <p class="eyebrow">${escapeHtml(c.import.switchExisting)}</p>
      <div class="existing-projects-list">
        ${state.projects.map((project) => `
          <button
            class="${state.project?.id === project.id ? "active" : ""}"
            data-switch-project="${escapeHtml(project.id)}"
            ${busy ? "disabled" : ""}
          >${escapeHtml(project.name)} <span>${escapeHtml(sourceLabel(project.source))}</span></button>
        `).join("")}
      </div>
    </section>
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
  // The "Analyze" workflow card on the landing page routes here with
  // activeTab pre-set to "impact" (see the workflow-card click handler
  // below) -- its empty state used to reuse the qa-flavored "before asking
  // the copilot" copy verbatim, which reads oddly for a change-impact
  // workflow that was never about "asking" anything. Give it its own copy;
  // every other tab keeps the original copilot-flavored message.
  if (!state.project) {
    const emptyMessage = state.activeTab === "impact" ? t().empty.importImpact : t().empty.importCopilot;
    return emptyProject(emptyMessage);
  }
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
              <button data-memory-forget-key="${escapeHtml(key)}" data-memory-forget-value="${escapeHtml(String(value))}" ${state.busyKeys.has(`memory-forget:${key}:${value}`) ? "disabled" : ""}>${remove}</button>
            </div>
          `).join("")}
        </div>
        <button class="secondary memory-clear" data-memory-forget-all="true" ${state.busyKeys.has("memory-forget-all") ? "disabled" : ""}>${clear}</button>
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

// per-tab 消息流拆分：state.messages 本身仍是单一数组（feedback/HITL 按
// answerId 查找的既有逻辑不受影响），只在渲染这一层按 message.tab 过滤出属于
// 当前 tab 的子集。message.tab 在四个写入点（ask/runAgentImpact/
// generateOnboarding/handleHitlDecision）里显式打上，值就是它所属的
// activeTab（"qa"/"impact"/"agent"/"onboarding"），不依赖 message.kind 推断——
// kind 对 "local" 占位消息（Thinking.../Running agent workflow...）是二义的
// （ask() 和 runAgentImpact() 都会临时用 kind: "local"），只有显式的 tab 标记
// 才能确保占位消息不会在错的 tab 里短暂闪现。
function messagesForTab(tab) {
  return state.messages.filter((message) => message.tab === tab);
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
  const tabMessages = messagesForTab(kind);
  return html`
    <div class="task-intro">
      <div>
        <p class="eyebrow">${eyebrow}</p>
        <h2>${title}</h2>
      </div>
      <p>${helper}</p>
    </div>
    <div class="messages">
      ${tabMessages.length ? tabMessages.map(renderMessage).join("") : emptyChatState(kind)}
    </div>
    <div class="composer prompt-composer">
      <textarea id="questionInput" data-tab="${kind}" rows="3" placeholder="${placeholder}">${escapeHtml(state.drafts[kind] || "")}</textarea>
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

const ONBOARDING_ROLES = ["Backend Engineer", "Frontend Engineer", "Product Manager", "QA"];
const ONBOARDING_DURATIONS = ["3 days", "5 days"];

function onboardingTab() {
  const c = t();
  const tabMessages = messagesForTab("onboarding");
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
          ${ONBOARDING_ROLES.map((role) => `<option ${state.onboardingRole === role ? "selected" : ""}>${role}</option>`).join("")}
        </select>
      </label>
      <label>
        <span>${c.chat.duration}</span>
        <select id="durationSelect">
          ${ONBOARDING_DURATIONS.map((duration) => `<option ${state.onboardingDuration === duration ? "selected" : ""}>${duration}</option>`).join("")}
        </select>
      </label>
      <button class="primary" data-action="onboarding" ${state.busyKeys.has("onboarding") ? "disabled" : ""}>${c.chat.generatePlan}</button>
    </div>
    <div class="messages">
      ${tabMessages.length ? tabMessages.map(renderMessage).join("") : `
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

  // Harness/memory/safety telemetry (run id, step count, duration, fallback
  // reason, ...) is PM/QA-facing noise on every single answer, not something
  // to read on first glance -- it now lives behind the same collapsed
  // <details class="tech-details"> fold used elsewhere (impact/agent_impact
  // briefings), instead of being unfolded inline under the answer meta line.
  // Nothing is removed, only re-leveled: everything renderRuntimeStatus()
  // produces is still reachable by expanding the fold.
  const runtimeStatusHtml = renderOptionalRuntimeStatus(payload);
  return html`
    <article class="message">
      <div class="question">${escapeHtml(message.question)}</div>
      <div class="answer">
        <div class="answer-meta">
          ${payload.llm_used
            ? `<span class="llm-source ai">AI ${escapeHtml(c.chat.modeAI)}</span>`
            : `<span class="llm-source fallback">OFF ${escapeHtml(c.chat.modeFallback)}</span>`}
        </div>
        <h3>${c.chat.answer}</h3>
        ${typewriterParagraph(message.answerId, payload.answer)}
        <h3>${c.chat.keyPoints}</h3>
        <ul>${renderList(payload.key_points, (point) => `<li>${escapeHtml(point)}</li>`)}</ul>
        <h3>${c.chat.related}</h3>
        <div class="citation-list">
          ${renderList(payload.related_files, (file) => `<div><code>${escapeHtml(file.file_path)}</code><span>${escapeHtml(file.reason)}</span></div>`)}
        </div>
        ${renderMemorySuggestions(payload.memory_suggestions)}
        <h3>${c.chat.uncertainty}</h3>
        <p>${escapeHtml(payload.uncertainty)}</p>
        <h3>${c.chat.next}</h3>
        <div class="chip-row">${renderList(payload.suggested_next_questions, (question) => `<button data-question="${escapeHtml(question)}">${escapeHtml(question)}</button>`)}</div>
        ${runtimeStatusHtml ? techDetailsWrapper(`techDetails-${message.answerId}`, c.chat.techDetails, runtimeStatusHtml) : ""}
        ${feedbackBar(message)}
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
  const modelCalls = harness.model_calls || [];
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
    modelCalls.length ? `${modelCalls.filter((call) => call.llm_used).length}/${modelCalls.length} ${c.chat.modelAgents}` : null,
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
                <button data-memory-action="confirm" data-suggestion="${escapeHtml(item.id)}" ${state.busyKeys.has(`memory-suggestion:${item.id}`) ? "disabled" : ""}>${c.chat.saveMemory}</button>
                <button data-memory-action="ignore" data-suggestion="${escapeHtml(item.id)}" ${state.busyKeys.has(`memory-suggestion:${item.id}`) ? "disabled" : ""}>${c.chat.ignoreMemory}</button>
              </div>`
            : `<span class="memory-state">${escapeHtml(item.status || c.chat.unknown)}</span>`}
        </div>
      `).join("")}
    </div>
  `;
}

// 折叠区展开态活在 DOM 里（<details open> 是浏览器原生行为，点击 <summary> 不
// 会经过任何 JS）。任何触发全局 render() 的操作都会用全新 HTML 重建这个节点，
// 默认收起——除非我们显式带上 open 属性。id 必须在一次 render 内稳定且唯一
// （消息用 answerId、单例卡片用固定字符串），配合 captureFormStateBeforeRender()
// 里对 data-details-id 的采集，做到"展开态跨重渲染保持"。
function techDetailsWrapper(id, summaryLabel, bodyHtml) {
  const openAttr = state.expandedDetails.has(id) ? " open" : "";
  return html`
    <details class="tech-details" data-details-id="${escapeHtml(id)}"${openAttr}>
      <summary>${escapeHtml(summaryLabel)}</summary>
      ${bodyHtml}
    </details>
  `;
}

// PM/QA 简报卡片：置顶展示 lib/answers.js 生成的 payload.briefing（业务视角的自然语言
// 叙事/受影响流程/验证重点/风险建议），不依赖 payload 是否来自 LLM 还是确定性回退。
// 调用方必须先判断 payload.briefing 是否存在（旧数据没有这个字段），本函数本身不做回退。
function renderImpactBriefing(briefing, c, answerId) {
  return html`
    <div class="impact-briefing">
      <h3>${c.chat.briefingTitle}</h3>
      ${typewriterParagraph(answerId, briefing.summary, "briefing-summary")}
      <h4>${c.chat.briefingFlows}</h4>
      <div class="flow-list">
        ${renderList(briefing.affected_flows, (flow) => `
          <div class="flow-card">
            <strong>${escapeHtml(flow.flow)}</strong>
            <p>${escapeHtml(flow.why)}</p>
          </div>
        `)}
      </div>
      <h4>${c.chat.briefingTesting}</h4>
      <ul class="briefing-testing">${renderList(briefing.testing_focus, (item) => `<li>${escapeHtml(item)}</li>`)}</ul>
      <div class="briefing-risk">
        <h4>${c.chat.briefingRisk}</h4>
        <p>${escapeHtml(briefing.risk_note)}</p>
      </div>
    </div>
  `;
}

function renderAgentImpactMessage(message) {
  const c = t();
  const payload = message.payload;
  const hasBriefing = !!payload.briefing;
  const memorySuggestionsHtml = renderMemorySuggestions(payload.memory_suggestions);
  // technicalDetails 保留原来的完整技术清单（harness/memory/safety 遥测/摘要/agent 元信息/
  // trace/impact 区域/guardrails/证据引用/测试建议/开放问题/不确定性）。有 briefing 时它被
  // 收进 <details> 折叠区，memory suggestions 挪到简报卡片旁边（更显眼，不跟技术清单一起
  // 被折叠）；没有 briefing（旧数据）时整段原样铺开在同样的相对位置，且 memory suggestions
  // 留在原来的位置 —— 这就是任务要求的"优雅回退到原渲染"。runtime-status（run id/steps/
  // duration/fallback 原因等 harness 遥测）原来固定挂在 agent-header 之后、不受 hasBriefing
  // 影响地一直平铺；现在并入 technicalDetails 顶部，跟着同一套折叠/平铺开关走，
  // 使得"每条回答都平铺一段 harness 遥测"这个问题在 briefing 视图下也被折起来。
  const technicalDetails = html`
    ${renderRuntimeStatus(payload)}
    <h3>${c.chat.impactSummary}</h3>
    ${typewriterParagraph(message.answerId, payload.summary)}

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

    ${payload.supervisor_plan ? html`
      <div class="agent-meta-grid">
        <section>
          <h3>${c.chat.supervisorPlan}</h3>
          <p>${escapeHtml(payload.supervisor_plan.rationale)}</p>
          <div class="tag-list">
            <span>${escapeHtml(payload.supervisor_plan.risk_hypothesis)}</span>
            ${renderList(payload.supervisor_plan.required_agents, (role) => `<span>${escapeHtml(role)}</span>`)}
          </div>
          <div class="compact-files">${renderList(payload.supervisor_plan.retrieval_queries, (query) => `<code>${escapeHtml(query)}</code>`)}</div>
        </section>
        <section>
          <h3>${c.chat.criticReview}</h3>
          <p>${escapeHtml(payload.critic_review?.summary || "")}</p>
          <div class="tag-list"><span>${escapeHtml(payload.critic_review?.verdict || c.chat.unknown)}</span></div>
          <ul>${renderList(payload.critic_review?.findings, (finding) => `<li><strong>${escapeHtml(finding.severity)}</strong> ${escapeHtml(finding.finding)}</li>`)}</ul>
        </section>
      </div>
    ` : ""}

    ${(payload.harness?.model_calls || []).length ? html`
      <h3>${c.chat.modelAgents}</h3>
      <div class="trace-list">
        ${renderList(payload.harness.model_calls, (call) => `
          <div class="trace-step">
            <strong>${escapeHtml(call.agent_role)}</strong>
            <span class="agent-role-badge">${escapeHtml(call.llm_used ? "LLM" : "fallback")}</span>
            <code>${escapeHtml(call.model)}</code>
            <small>${escapeHtml(`${call.duration_ms}ms | ${call.prompt_tokens_estimated} estimated tokens${call.error_code ? ` | ${call.error_code}` : ""}`)}</small>
          </div>
        `)}
      </div>
    ` : ""}

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

    ${hasBriefing ? "" : memorySuggestionsHtml}

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
  `;
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

        ${hasBriefing ? renderImpactBriefing(payload.briefing, c, message.answerId) : ""}
        ${hasBriefing ? memorySuggestionsHtml : ""}

        ${hasBriefing ? techDetailsWrapper(`techDetails-${message.answerId}`, c.chat.techDetails, technicalDetails) : technicalDetails}
        ${feedbackBar(message)}
      </div>
    </article>
  `;
}

function renderImpactMessage(message) {
  const c = t();
  const payload = message.payload;
  const hasBriefing = !!payload.briefing;
  // /api/chat (kind=impact) attaches the same harness/safety/memory_suggestions
  // fields as the qa path, but this renderer never surfaced either one --
  // runtime telemetry was simply dropped on the floor, and pending memory
  // suggestions never got a Save/Ignore card. Both are now included, mirroring
  // renderAgentImpactMessage's established fold-or-inline pattern: telemetry
  // rides inside technicalDetails (folded once there's a briefing, inline
  // otherwise), suggestions stay visible next to the briefing/summary.
  const memorySuggestionsHtml = renderMemorySuggestions(payload.memory_suggestions);
  const technicalDetails = html`
    ${renderOptionalRuntimeStatus(payload)}
    <h3>${c.chat.impactSummary}</h3>
    ${typewriterParagraph(message.answerId, payload.summary)}
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
    ${hasBriefing ? "" : memorySuggestionsHtml}
  `;
  return html`
    <article class="message">
      <div class="question">${escapeHtml(message.question)}</div>
      <div class="answer">
        ${hasBriefing ? renderImpactBriefing(payload.briefing, c, message.answerId) : ""}
        ${hasBriefing ? memorySuggestionsHtml : ""}
        ${hasBriefing ? techDetailsWrapper(`techDetails-${message.answerId}`, c.chat.techDetails, technicalDetails) : technicalDetails}
        ${feedbackBar(message)}
      </div>
    </article>
  `;
}

function renderOnboardingMessage(message) {
  const c = t();
  const payload = message.payload;
  // Same telemetry-into-a-fold treatment as the other message renderers: the
  // plan/guardrails/memory suggestions are what the user actually asked for,
  // harness/safety diagnostics go behind a collapsed "Technical details" fold.
  const runtimeStatusHtml = renderOptionalRuntimeStatus(payload);
  return html`
    <article class="message">
      <div class="question">${escapeHtml(payload.role)} · ${escapeHtml(payload.duration)}</div>
      <div class="answer">
        <h3>${c.chat.goal}</h3>
        ${typewriterParagraph(message.answerId, payload.goal)}
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
        ${runtimeStatusHtml ? techDetailsWrapper(`techDetails-${message.answerId}`, c.chat.techDetails, runtimeStatusHtml) : ""}
        ${feedbackBar(message)}
      </div>
    </article>
  `;
}

// message.feedbackGiven (written back by sendFeedback(), see below) is the
// single source of truth for "did the user already give feedback on this
// answer". Previously the "selected" class was applied by directly mutating
// the clicked <button>'s classList from inside sendFeedback() and never
// written back to state -- any subsequent render() (a different message
// getting feedback, a language switch, a background metrics poll, ...)
// rebuilt this exact button from scratch with no memory of the click, so the
// selected state visibly disappeared and, because nothing was disabled,
// the same feedback could be submitted again. Deriving the markup from
// message.feedbackGiven fixes both: it survives re-renders and the rest of
// the button group is disabled once one choice has been recorded.
function feedbackBar(message) {
  const types = t().feedback;
  const selected = message.feedbackGiven;
  const disabledAttr = selected ? " disabled" : "";
  return `<div class="feedback">${types.map(([type, label]) => `<button class="${type === selected ? "selected" : ""}" data-feedback="${type}" data-answer="${escapeHtml(message.answerId)}"${disabledAttr}>${label}</button>`).join("")}</div>`;
}

function failureReasons(metrics) {
  const c = t();
  // Zero real feedback used to fall back to a hardcoded demo distribution
  // (missing_citation: 12, too_generic: 8, inaccurate: 7) -- fabricated
  // numbers on a dashboard whose whole pitch is trustworthy metrics. The
  // empty state now matches every sibling bar chart in this same panel
  // (rankedBars() below), which renders a single honest "none / 0" bar
  // instead of inventing activity that never happened.
  const reasons = metrics.top_failure_reasons?.length
    ? metrics.top_failure_reasons
    : [{ type: "none", count: 0 }];
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
          <button class="text-button" data-harness-run="${escapeHtml(item.run_id || "")}" ${state.busyKeys.has(`harness-audit:${item.run_id || ""}`) ? "disabled" : ""}>Audit</button>
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
        <button class="secondary" data-auth-action="refresh" ${state.busyKeys.has("auth-refresh") ? "disabled" : ""}>${c.dashboard.refresh}</button>
      </div>

      <div class="auth-token-row">
        <label>
          <span>${c.auth.apiToken}</span>
          <input id="authTokenInput" data-auth-token-input type="password" autocomplete="off" value="${escapeHtml(state.draftAuthToken ?? state.authToken ?? "")}" placeholder="${escapeHtml(c.auth.tokenPlaceholder)}">
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
          <label><span>${c.auth.userId}</span><input id="authUserIdInput" autocomplete="off" placeholder="pm-user" value="${escapeHtml(state.authUserForm.userId)}"></label>
          <label><span>${c.chat.role}</span><input id="authRoleInput" autocomplete="off" value="${escapeHtml(state.authUserForm.role)}"></label>
          <label><span>${c.auth.scopes}</span><input id="authScopesInput" autocomplete="off" value="${escapeHtml(state.authUserForm.scopes)}"></label>
          <label><span>${c.auth.orgId}</span><input id="authOrgInput" autocomplete="off" placeholder="${escapeHtml(c.auth.optional)}" value="${escapeHtml(state.authUserForm.orgId)}"></label>
          <label class="auth-checkbox"><input id="authIssueTokenInput" type="checkbox" ${state.authUserForm.issueToken ? "checked" : ""}><span>${c.auth.issueToken}</span></label>
          <button data-auth-action="create-user" ${state.busyKeys.has("auth-create-user") ? "disabled" : ""}>${c.auth.createUserButton}</button>
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
                ? `<button class="text-button danger-text" data-auth-disable-user="${escapeHtml(user.id || user.userId || "")}" ${state.busyKeys.has(`auth-disable:${user.id || user.userId || ""}`) ? "disabled" : ""}>${c.auth.disable}</button>`
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
  const citationStatusLabel = c.dashboard.citationStatus || "引用状态";
  const importSafetyBody = html`
    <div class="evidence-stats">
      <div><strong>${escapeHtml(metrics.import_safety_status || "not_applicable")}</strong><span>${escapeHtml((metrics.import_safety_risk_counts || []).map((item) => item.type).join(", ") || c.overview.noRisks)}</span></div>
      <div><strong>${metrics.import_prompt_risk_file_count || 0}</strong><span>${c.overview.promptRisks}</span></div>
      <div><strong>${metrics.import_sensitive_file_count || 0}</strong><span>${c.overview.sensitiveFiles}</span></div>
    </div>
  `;
  const recentFeedbackBody = html`
    <div class="feedback-log">
      ${renderList(metrics.recent_feedback, (item) => {
        const run = item.harness_run_id ? `run ${String(item.harness_run_id).slice(0, 18)}` : item.answer_kind || "answer";
        const status = [item.answer_kind, item.safety_status].filter(Boolean).join(" / ");
        return `<div><code>${escapeHtml(item.type)}</code><span>${escapeHtml(run)}</span><span>${escapeHtml(status || new Date(item.createdAt).toLocaleString())}</span></div>`;
      })}
    </div>
  `;

  // 四个叙事分组：可信度/安全/可靠性/使用与反馈。每组同时容纳数字卡片（沿用
  // .metrics-grid/.metric）和排行/事件面板（沿用 .overview-grid/.panel），指标
  // 本身来自 lib/metrics.js 的 computeMetrics 输出，这里只做前端归类，不增删字段。
  const trustGroup = metricGroup("trust", c.dashboard.groups.trust, [
    [c.dashboard.citation, `${metrics.citation_coverage}%`],
    [c.dashboard.uncertain, `${metrics.uncertain_answer_rate}%`]
  ], [
    [c.dashboard.schemaStatus, rankedBars(metrics.schema_status_counts)],
    [citationStatusLabel, rankedBars(metrics.citation_status_counts)]
  ]);

  const safetyGroup = metricGroup("safety", c.dashboard.groups.safety, [
    [c.dashboard.highRisk, metrics.high_risk_questions],
    [c.dashboard.guardrailHits, metrics.guardrail_hits || 0],
    [c.dashboard.outputRedactions, metrics.output_redaction_runs || 0],
    [c.dashboard.redactedMatches, metrics.output_redaction_matches || 0]
  ], [
    [c.dashboard.safetyRisks, rankedBars(metrics.safety_risk_counts)],
    [c.dashboard.safetyStatus, rankedBars(metrics.safety_status_counts)],
    [c.dashboard.importSafetyTitle, importSafetyBody],
    [c.dashboard.toolPolicy, rankedBars(metrics.tool_policy_counts)],
    [c.dashboard.recentToolPolicyTitle, recentToolPolicyEvents(metrics.recent_tool_policy_events), "span-2"],
    [c.dashboard.recentSafety, recentSafetyEvents(metrics.recent_safety_events), "span-2"],
    [c.dashboard.recentRedactionsTitle, recentRedactionEvents(metrics.recent_redaction_events), "span-2"]
  ]);

  const reliabilityGroup = metricGroup("reliability", c.dashboard.groups.reliability, [
    [c.dashboard.fallbackRuns, metrics.fallback_runs || 0],
    [c.dashboard.harnessSnapshots, metrics.harness_run_snapshots || 0],
    [c.dashboard.avgResponse, `${metrics.average_response_time_ms || 0}ms`]
  ], [
    [c.dashboard.harnessRuntime, rankedBars(metrics.harness_runtime_counts)],
    [c.dashboard.modelMode, rankedBars(metrics.model_mode_counts)],
    [c.dashboard.budgetStatus, rankedBars(metrics.budget_status_counts)],
    [c.dashboard.llmUsage, rankedBars(metrics.llm_usage_counts)],
    [c.dashboard.fallbackReasons, rankedBars(metrics.fallback_reasons)],
    [c.dashboard.traceTools, rankedBars(metrics.trace_tool_counts), "span-2"],
    [c.dashboard.recentRuns, recentHarnessRuns(metrics.recent_harness_runs), "span-2"]
  ]);

  const usageGroup = metricGroup("usage", c.dashboard.groups.usage, [
    [c.dashboard.total, metrics.total_questions],
    [c.dashboard.agentRuns, metrics.agent_runs || 0],
    [c.dashboard.helpful, `${metrics.helpful_rate}%`],
    [c.dashboard.negative, `${metrics.negative_feedback_rate}%`],
    [c.dashboard.memorySaves, metrics.memory_confirmations || 0]
  ], [
    [c.dashboard.failures, failureReasons(metrics)],
    [c.dashboard.memoryStatus, rankedBars(metrics.memory_status_counts)],
    [c.dashboard.memoryEventsTitle, rankedBars(metrics.memory_event_counts)],
    [c.dashboard.recentMemory, recentMemoryEvents(metrics.recent_memory_events), "span-2"],
    [c.dashboard.recent, recentFeedbackBody, "span-2"]
  ]);

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

      <section class="quality-summary">
        <h2>${c.dashboard.qualitySummary.title}</h2>
        <ul>
          ${qualitySummaryLines(metrics, c).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}
        </ul>
      </section>

      ${trustGroup}
      ${safetyGroup}
      ${reliabilityGroup}
      ${usageGroup}

      <div class="overview-grid">
        ${harnessAuditPanel(state.harnessAudit)}
        ${renderAuthOperationsPanel()}
        <section class="panel span-3 improvement-panel">
          <h2>${c.dashboard.signals}</h2>
          <div class="iteration-grid">
            ${c.dashboard.signalItems.map(([title, text]) => `<div><strong>${title}</strong><span>${text}</span></div>`).join("")}
          </div>
        </section>
      </div>

      ${evaluationMethodologyCard(c)}
    </main>
  `;
}

// 从 computeMetrics 输出的既有字段拼出 3-4 句自然语言结论（英/中双语走 copy 模板，
// 用 {placeholder} 做数值替换，与 c.auth.disableConfirmTemplate 的既有约定一致）。
// 不发明新数据：所有数值都来自 metrics 对象已经暴露的字段。
function qualitySummaryLines(metrics, c) {
  const qs = c.dashboard.qualitySummary;
  if (!metrics.total_questions) {
    return [qs.empty];
  }
  return [
    qs.citation
      .replace("{total}", metrics.total_questions)
      .replace("{citationPct}", metrics.citation_coverage),
    qs.guardrail
      .replace("{guardrailHits}", metrics.guardrail_hits || 0)
      .replace("{redactionMatches}", metrics.output_redaction_matches || 0),
    qs.fallback
      .replace("{fallbackRuns}", metrics.fallback_runs || 0),
    qs.feedback
      .replace("{helpfulRate}", metrics.helpful_rate || 0)
      .replace("{negativeRate}", metrics.negative_feedback_rate || 0)
  ];
}

// 一个叙事分组 = 一句"为什么值得看"的说明文案 + 数字卡片（.metrics-grid）+
// 排行/事件面板（.overview-grid），纯前端重组既有指标，不改变 lib/metrics.js。
function metricGroup(key, groupCopy, cards, panels) {
  return html`
    <section class="metric-group" data-metric-group="${escapeHtml(key)}">
      <div class="metric-group-head">
        <h2>${groupCopy.title}</h2>
        <p>${groupCopy.desc}</p>
      </div>
      <div class="metrics-grid">
        ${cards.map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("")}
      </div>
      <div class="overview-grid">
        ${panels.map(([title, body, spanClass]) => `
          <section class="panel${spanClass ? ` ${escapeHtml(spanClass)}` : ""}">
            <h2>${title}</h2>
            ${body}
          </section>
        `).join("")}
      </div>
    </section>
  `;
}

// 折叠说明卡（复用 chat 里 briefing 引入的 <details class="tech-details"> 模式）：
// 解释指标怎么采集——每次回答自动记录 harness 快照/引用校验/安全扫描，不需要
// 外接 LLMOps 工具；链接到 docs/AGENT_RUNTIME_ARCHITECTURE.md 供想深入的读者查证。
function evaluationMethodologyCard(c) {
  const m = c.dashboard.methodology;
  const body = html`
    <p>${escapeHtml(m.intro)}</p>
    <ul>
      <li>${escapeHtml(m.bullet1)}</li>
      <li>${escapeHtml(m.bullet2)}</li>
      <li>${escapeHtml(m.bullet3)}</li>
    </ul>
    <p><a href="https://github.com/yuk1no4090/Repomentor/blob/main/docs/AGENT_RUNTIME_ARCHITECTURE.md" target="_blank" rel="noopener noreferrer">${escapeHtml(m.link)}</a></p>
  `;
  return html`
    <section class="panel methodology-card">
      ${techDetailsWrapper("methodology", m.title, body)}
    </section>
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

// ---- Typewriter reveal for freshly-arrived answer text ----
//
// render() 先输出完整 DOM（文本节点里就是全文），这里只是事后决定要不要把它
// 抹掉再逐块打回去。state.playedMessages 记录已经处理过的 answerId：一旦加入
// 这个集合就永远不再重播，哪怕动画还没播完就被下一次 render() 打断——被打断时
// 新渲染出来的节点就是完整全文（因为我们本来就没清空过它，只是没有机会启动
// 动画），天然满足“重渲染时未播完的直接显示全文”。

function typewriterParagraph(answerId, text, extraClass = "") {
  const trackable = !!answerId && answerId !== "pending";
  const classes = extraClass ? [extraClass] : [];
  if (trackable) classes.push("tw-text");
  const classAttr = classes.length ? ` class="${classes.join(" ")}"` : "";
  const dataAttr = trackable ? ` data-tw-id="${escapeHtml(answerId)}"` : "";
  return `<p${classAttr}${dataAttr}>${escapeHtml(text)}</p>`;
}

function clearActiveTypewriterTimers() {
  activeTypewriterTimers.forEach((timerId) => clearInterval(timerId));
  activeTypewriterTimers.clear();
}

function prefersReducedMotion() {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function animateTypewriterEl(el, answerId) {
  const fullText = el.textContent;
  const total = fullText.length;
  if (!total) return;
  const steps = Math.max(1, Math.ceil(total / TYPEWRITER_STEP_CHARS));
  const interval = Math.max(TYPEWRITER_MIN_INTERVAL_MS, Math.round(TYPEWRITER_MAX_DURATION_MS / steps));
  el.textContent = "";
  el.classList.add("tw-animating");
  let shown = 0;
  const timerId = setInterval(() => {
    shown = Math.min(total, shown + TYPEWRITER_STEP_CHARS);
    el.textContent = fullText.slice(0, shown);
    if (shown >= total) {
      clearInterval(timerId);
      activeTypewriterTimers.delete(answerId);
      el.classList.remove("tw-animating");
    }
  }, interval);
  activeTypewriterTimers.set(answerId, timerId);
}

// 每次 render() 重建 DOM 之后调用一次：找出本次新增且未播放过的消息主文本节点。
// 同一个 answerId 可能同时出现在多处（例如 briefing 摘要和折叠详情里重复的
// summary 段落）——先到先得，第一个命中的节点播放动画，其余相同 id 的节点在
// 处理时已经被标记为 played，直接保留全文，不会重复播放。
function mountTypewriters() {
  const nodes = app.querySelectorAll("[data-tw-id]");
  if (!nodes.length) return;
  const skipAnimation = prefersReducedMotion();
  nodes.forEach((el) => {
    const id = el.getAttribute("data-tw-id");
    if (!id || state.playedMessages.has(id)) return;
    state.playedMessages.add(id);
    if (skipAnimation) return;
    animateTypewriterEl(el, id);
  });
}

// ---- Auto-scroll / scroll-position preservation for the messages panel ----
//
// .messages 声明了 flex:1 + overflow:auto，.workspace 现在也有了硬性的
// max-height 上限（见 styles.css），正常情况下 .messages 就是一个真正会
// 内部溢出、可以滚动的面板；.workspace 自己在极端矮视口下也可能整体溢出而
// 需要滚动（同样见 styles.css 里 .workspace 的 overflow:auto 说明）。这里
// 用 window 级别的滚动状态作为兜底分支，不绑定某一种具体布局才能生效。
//
// app.innerHTML 整体重建意味着旧 .messages 节点会被整个扔掉、换成一个全新
// 节点（scrollTop 默认是 0）。只处理"贴底就自动滚底"是不够的——不贴底的
// 分支如果什么都不做，新节点就停在 scrollTop=0，用户往上翻看历史时，任何
// 触发 render() 的操作（哪怕只是点一下当前 tab）都会把视图弹回最顶部。所以
// 这里量的不是一个"是否贴底"的布尔值，而是具体的"距底部多少像素"，不贴底时
// 重建后显式把新节点滚回等价的相对位置。

const NEAR_BOTTOM_THRESHOLD_PX = 150;

// 量出容器当前"距底部还有多少像素"：优先用 .messages 自己的内部滚动状态，
// 只有它没有真正溢出时才退回 window 级别的滚动状态。
function distanceFromBottom(el) {
  const innerOverflow = el.scrollHeight - el.clientHeight > 1;
  if (innerOverflow) {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }
  const doc = document.documentElement;
  return doc.scrollHeight - window.scrollY - window.innerHeight;
}

// render() 重建 DOM 之后调用：el 是新建出来的 .messages 节点，prevDistance 是
// 重建前用旧节点量出来的距底像素数。
// - snapToBottom 为 true（重建前已经贴底，或者 .messages 本来就不存在，比如
//   刚从别的 tab/页面切换过来）：滚到新内容的最底部。
// - 否则：把新节点滚动到"距新内容底部同样远"的位置——
//   newScrollTop = newScrollHeight - prevDistance - newClientHeight，
//   再 clamp 到 [0, maxScrollTop]，防止内容变化导致算出负数或超出可滚动范围。
function restoreScrollPosition(el, prevDistance, snapToBottom) {
  const innerOverflow = el.scrollHeight - el.clientHeight > 1;
  if (innerOverflow) {
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const target = snapToBottom ? el.scrollHeight : el.scrollHeight - prevDistance - el.clientHeight;
    el.scrollTop = Math.max(0, Math.min(maxScrollTop, target));
    return;
  }
  const doc = document.documentElement;
  const maxScrollY = Math.max(0, doc.scrollHeight - window.innerHeight);
  const target = snapToBottom ? doc.scrollHeight : doc.scrollHeight - prevDistance - window.innerHeight;
  window.scrollTo(0, Math.max(0, Math.min(maxScrollY, target)));
}

// ---- DOM -> state mirroring, run at the very top of render() before the old
// DOM is destroyed ----
//
// render() replaces #app's entire innerHTML on every call, including calls
// triggered by things that have nothing to do with whatever the user is
// currently doing (background refreshMetrics()/refreshMemory() polls,
// switching languages, giving feedback on an unrelated message, etc). Any
// value that can only live in the DOM at the moment render() runs would
// otherwise be silently destroyed. state.drafts (see below) was the first fix
// of this shape; this generalizes the same "read the live DOM value into
// state right before the wipe" pattern to every other input/toggle that has
// the same problem.
function captureFormStateBeforeRender() {
  // #questionInput 只在 qa/impact/agent 三个 tab 各自的 qaTab(kind) 渲染里挂载
  // 一份（onboarding tab 没有这个输入框）。不能假设它此刻属于 state.activeTab：
  // switchTab() 是"先切 state.activeTab 再调 render()"，而这个函数运行在
  // render() 重建 DOM *之前*，此时挂在文档里的仍是切换前那个旧 tab 的
  // textarea —— 如果按当时已经变成新值的 state.activeTab 回写，会把旧 tab
  // 的文本误存进新 tab 的草稿槽位，新 tab 原有的草稿反而被这份错位的值覆盖
  // 掉（浏览器实测复现过一次：qa 输入内容会在切到 impact/agent 后串过去）。
  // 渲染 textarea 时就把它所属的 kind 写进 data-tab（见 qaTab()），这里直接
  // 读那个属性作为归属依据，而不是读可能已经被切换掉的 state.activeTab。
  const questionInput = document.querySelector("#questionInput");
  if (questionInput) state.drafts[questionInput.dataset.tab || state.activeTab] = questionInput.value;

  const roleSelect = document.querySelector("#roleSelect");
  if (roleSelect) state.onboardingRole = roleSelect.value;
  const durationSelect = document.querySelector("#durationSelect");
  if (durationSelect) state.onboardingDuration = durationSelect.value;

  const userIdInput = document.querySelector("#authUserIdInput");
  if (userIdInput) state.authUserForm.userId = userIdInput.value;
  const roleInput = document.querySelector("#authRoleInput");
  if (roleInput) state.authUserForm.role = roleInput.value;
  const scopesInput = document.querySelector("#authScopesInput");
  if (scopesInput) state.authUserForm.scopes = scopesInput.value;
  const orgInput = document.querySelector("#authOrgInput");
  if (orgInput) state.authUserForm.orgId = orgInput.value;
  const issueTokenInput = document.querySelector("#authIssueTokenInput");
  if (issueTokenInput) state.authUserForm.issueToken = issueTokenInput.checked;

  // Two API-token inputs can be mounted at once (topbar + Auth Operations
  // panel on the dashboard page) -- both mirror the same draft value. Prefer
  // whichever currently has focus (the one being actively edited), otherwise
  // fall back to the first one found so an unfocused-but-edited value isn't
  // lost either.
  const tokenInputs = document.querySelectorAll("[data-auth-token-input]");
  if (tokenInputs.length) {
    const focused = document.activeElement;
    const activeInput = Array.from(tokenInputs).find((el) => el === focused) || tokenInputs[0];
    state.draftAuthToken = activeInput.value;
  }

  document.querySelectorAll("details.tech-details[data-details-id]").forEach((el) => {
    const id = el.dataset.detailsId;
    if (el.open) state.expandedDetails.add(id);
    else state.expandedDetails.delete(id);
  });
}

// ---- Focus preservation across full innerHTML rebuilds ----
//
// app.innerHTML replacement destroys every node, including whichever one is
// currently focused -- focus silently falls back to <body>. This records a
// stable identifier (element id) plus text-selection range before the wipe,
// then restores both after the new DOM is mounted. Only elements with a
// stable `id` are restorable (that covers every input this app renders
// except the two auth-token inputs, which is why those two get explicit ids
// below); anything else (e.g. a plain button) degrades gracefully to no-op.
function captureFocusInfo() {
  const el = document.activeElement;
  if (!el || el === document.body || !el.id || !app.contains(el)) return null;
  let selectionStart = null;
  let selectionEnd = null;
  try {
    selectionStart = typeof el.selectionStart === "number" ? el.selectionStart : null;
    selectionEnd = typeof el.selectionEnd === "number" ? el.selectionEnd : null;
  } catch {
    // Some input types (e.g. checkbox, number, email) throw just from
    // *reading* selectionStart/selectionEnd, not only from setSelectionRange
    // -- symmetric with the existing try/catch in restoreFocusInfo() below.
    // captureFocusInfo() runs unconditionally at the top of every render(),
    // so an uncaught throw here would abort the whole render(), not just
    // focus restoration.
  }
  return { id: el.id, selectionStart, selectionEnd };
}

function restoreFocusInfo(info) {
  if (!info) return;
  const el = document.getElementById(info.id);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (info.selectionStart !== null && typeof el.setSelectionRange === "function") {
    try {
      el.setSelectionRange(info.selectionStart, info.selectionEnd ?? info.selectionStart);
    } catch {
      // Some input types (e.g. checkbox, number) throw on setSelectionRange; ignore.
    }
  }
}

function render() {
  const focusInfo = captureFocusInfo();
  captureFormStateBeforeRender();

  // .messages 容器每次都会随 app.innerHTML 整体重建（新容器 scrollTop 永远是
  // 0），所以必须在替换之前，趁旧容器还在文档里量一次它当时的滚动状态：既要
  // 知道是否贴底（决定要不要自动滚底），也要记下具体的距底像素数（决定不
  // 贴底时新节点要恢复到哪个等价位置，见 restoreScrollPosition）。容器本来
  // 就不存在（比如刚从别的页面切换过来）视为贴底，走自动滚底分支。
  const prevMessagesEl = document.querySelector(".messages");
  const prevDistance = prevMessagesEl ? distanceFromBottom(prevMessagesEl) : 0;
  const shouldSnapToBottom = !prevMessagesEl || prevDistance <= NEAR_BOTTOM_THRESHOLD_PX;

  // 旧 DOM 马上要被扔掉，先停掉所有还在跑的打字机 interval，避免它们之后继续
  // 对已经脱离文档树的节点写 textContent。
  clearActiveTypewriterTimers();

  const pages = {
    landing: landingPage,
    import: importPage,
    overview: overviewPage,
    chat: chatPage,
    dashboard: dashboardPage
  };
  const c = t();
  app.innerHTML = nav() + (state.errorBanner ? html`
    <div class="error-banner">
      <span>${escapeHtml(state.errorBanner.message)}</span>
      <button data-retry>${escapeHtml(c.common?.retry || "Retry")}</button>
      <button data-dismiss-error>${escapeHtml(c.common?.dismiss || "Dismiss")}</button>
    </div>
  ` : "") + pages[state.page]();

  mountTypewriters();

  const messagesEl = document.querySelector(".messages");
  if (messagesEl) restoreScrollPosition(messagesEl, prevDistance, shouldSnapToBottom);

  restoreFocusInfo(focusInfo);
}

async function importRepository({ sample = false, repoUrl: repoUrlArg, file: fileArg } = {}) {
  if (state.loading) return;
  // Read every DOM-dependent import parameter *before* state.loading flips or
  // render() runs even once. render() replaces #app's entire innerHTML (see
  // render() above), which tears down and recreates every input node it
  // contains -- including #repoUrl and #zipFile. The P0 bug this used to have:
  // these values were read only *after* a multi-step fake progress animation
  // had already called render() several times, so by the time the DOM was
  // finally queried, the user's typed URL / selected file were long gone and
  // every manual import silently sent an empty body (IMPORT_SOURCE_REQUIRED)
  // even though the user had filled the form correctly. Only "Use Sample
  // Repo" worked, because it never needed to read either field.
  //
  // A caller may also pass repoUrl/file explicitly (used by the retry banner
  // below) to resubmit the exact values from a previous failed attempt
  // instead of re-querying a DOM that has since been re-rendered blank.
  const repoUrl = sample ? undefined : (repoUrlArg !== undefined ? repoUrlArg : document.querySelector("#repoUrl")?.value?.trim());
  const file = sample ? undefined : (fileArg !== undefined ? fileArg : document.querySelector("#zipFile")?.files?.[0]);

  try {
    state.loading = true;
    state.progress = [];
    render();

    const zipBase64 = file ? await fileToBase64(file) : undefined;
    const body = buildImportRequestBody({ sample, repoUrl, file, zipBase64 });

    // Progress steps must track the *real* request lifecycle, not a canned
    // animation: nothing below is allowed to advance before api() has
    // actually called fetch(). tick() only starts firing once the request
    // promise exists, advances at most one step per interval as a lightweight
    // "still working" heartbeat while we wait, and the interval is cleared the
    // instant the response settles -- so the bar can never finish (or even
    // partially play) before the network call has actually started, which was
    // the other half of the original bug (the whole animation used to run to
    // completion *before* /api/import was even requested).
    const inFlightSteps = progressSteps.slice(0, -1);
    let stepIndex = 0;
    const tick = () => {
      if (stepIndex >= inFlightSteps.length) return;
      state.progress.push(inFlightSteps[stepIndex]);
      stepIndex += 1;
      render();
    };

    const requestPromise = api("/api/import", {
      method: "POST",
      body: JSON.stringify(body)
    });
    tick();
    const timer = setInterval(tick, 220);
    let payload;
    try {
      payload = await requestPromise;
    } finally {
      clearInterval(timer);
    }

    state.project = payload.project;
    state.projects.push(payload.project);
    state.messages = [];
    state.memory = null;
    state.progress = progressSteps.slice();
    state.page = "overview";
    // Not routed through setPage() (this already runs its own
    // refreshMetrics()/refreshMemory() above, and setPage()'s would be
    // redundant), so it has to call syncLocationHash() itself -- otherwise
    // a successful import would land on the Overview page while the URL
    // hash stayed wherever it was before (e.g. "#/landing" or "#/import"),
    // silently breaking the "hash always mirrors state.page" invariant every
    // other page transition in this file relies on.
    syncLocationHash();
    await refreshMetrics(false);
    await refreshMemory(false);
    render();
  } catch (error) {
    state.progress = [];
    showError(error, () => importRepository({ sample, repoUrl, file }));
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
  // tab: kind -- ask() is only ever invoked as ask("qa") or ask("impact")
  // (see the data-action click handler below), and those two kind values
  // already coincide with the qa/impact tab ids, so kind doubles as the tab
  // marker used to filter this message into the right tab's message list.
  state.messages.push({
    kind: "local",
    tab: kind,
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
    state.messages.push({
      kind: payload.kind,
      tab: kind,
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
  state.messages.push({
    kind: "local",
    tab: "agent",
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
    state.messages.push({
      kind: payload.kind,
      tab: "agent",
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

async function generateOnboarding(roleOverride, durationOverride) {
  // Same reentrancy shape as feedbackInFlight (see sendFeedback below): guard
  // synchronously, before any await, so a double-click on "Generate Plan"
  // can't fire two concurrent /api/onboarding requests whose responses may
  // then arrive out of order.
  if (state.busyKeys.has("onboarding")) return;
  // Read the role/duration <select> values up front (roleOverride/
  // durationOverride let the retry banner below resubmit the exact values
  // from the failed attempt instead of re-querying a DOM that render() may
  // have since rebuilt) -- same pattern as importRepository()/ask().
  const role = roleOverride !== undefined ? roleOverride : (document.querySelector("#roleSelect")?.value || "Backend Engineer");
  const duration = durationOverride !== undefined ? durationOverride : (document.querySelector("#durationSelect")?.value || "3 days");
  state.busyKeys.add("onboarding");
  render();
  try {
    const payload = await api("/api/onboarding", {
      method: "POST",
      body: JSON.stringify({ projectId: state.project.id, role, duration })
    });
    state.messages.push({
      kind: "onboarding",
      tab: "onboarding",
      answerId: payload.answerId,
      question: `Generate onboarding plan for ${role}, ${duration}`,
      payload: payload.payload
    });
    await refreshMetrics(false);
  } catch (error) {
    showError(error, () => generateOnboarding(role, duration));
  } finally {
    state.busyKeys.delete("onboarding");
    render();
  }
}

async function sendFeedback(answerId, type) {
  // message.feedbackGiven only exists once a *response* has come back, and
  // feedbackBar()'s `disabled` attribute only takes effect after the *next*
  // render() -- neither one guards the window between the click and the
  // response actually arriving. A real double-click on the same button, or
  // two different buttons for the same answer clicked in quick succession,
  // both fire this function again well inside that window; without a
  // synchronous guard both calls sail past every check that only exists
  // "after the fact" and each POST their own (possibly contradictory)
  // /api/feedback record, silently corrupting the store (reviewer-verified:
  // duplicate "helpful" rows from a same-button double-click, and
  // simultaneous "helpful" + "not_helpful" rows from a two-button
  // double-click, in both cases with the UI settling on a single selected
  // state that hides the corruption).
  //
  // state.feedbackInFlight closes that window: the check-then-add below runs
  // synchronously, before the first `await`, so the second call (whichever
  // triggered it) always observes the flag the first call already set --
  // JS never interleaves two click handlers' synchronous prefixes.
  const message = state.messages.find((item) => item.answerId === answerId);
  if (message?.feedbackGiven || state.feedbackInFlight.has(answerId)) return;
  state.feedbackInFlight.add(answerId);
  // Also disable the whole button group for this answer in the DOM right
  // now, synchronously -- belt-and-suspenders on top of the Set check above,
  // and it means the buttons visibly go inert immediately instead of only
  // after the response comes back and render() runs.
  document.querySelectorAll(`[data-feedback][data-answer="${CSS.escape(answerId)}"]`).forEach((button) => {
    button.disabled = true;
  });
  try {
    const payload = await api("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ answerId, type })
    });
    state.metrics = payload.metrics;
    // Write the result back onto the message itself instead of mutating the
    // clicked DOM node directly: any DOM-only change is destroyed by the
    // very next render() (a different answer's feedback, a language switch,
    // a background metrics poll, ...), which both dropped the visible
    // "selected" state and left the button group enabled for resubmission.
    if (message) message.feedbackGiven = type;
  } catch (error) {
    // Resubmitting the same (answerId, type) is exactly what a user would do
    // by clicking the same feedback button again -- retryFn does that
    // directly instead of degrading to a blocking native alert() (which,
    // notably, would have shown while the button group is still
    // synchronously disabled from above, with no obvious way to try again
    // until the finally block below re-renders).
    showError(error, () => sendFeedback(answerId, type));
  } finally {
    // Always clear the in-flight flag and re-render, on success *and*
    // failure: on failure message.feedbackGiven stays unset, so this
    // render() rebuilds the button group enabled again (feedbackBar()
    // derives `disabled` from feedbackGiven) instead of leaving it stuck
    // disabled from the synchronous DOM write above with no future render
    // to undo it -- showError() alone (the error path) does not render.
    state.feedbackInFlight.delete(answerId);
    render();
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
      state.messages.push({
        question: c.chat.hitlApprovedMessage,
        kind: "agent_impact",
        tab: "agent",
        payload: resumed.payload,
        answerId: resumed.answerId
      });
    } else {
      state.messages.push({
        question: c.chat.hitlRejectedMessage,
        kind: "agent_impact",
        tab: "agent",
        payload: resumed.payload,
        answerId: resumed.answerId
      });
    }
    render();
  } catch (error) {
    // The synchronous card.innerHTML write above (so "Submitting decision..."
    // appears immediately, before any render()) bypasses state entirely: on
    // failure nothing above ever touched state.messages, so the hitl payload
    // still has paused: true. Previously this caught error went straight to
    // showError(error) with no retryFn, which just alert()ed and never
    // called render() on this path -- the card's replaced innerHTML had
    // nothing left to rebuild it, leaving "Submitting decision..." stuck
    // forever with no way to approve/reject again. Passing a retryFn instead
    // both avoids the alert and (via showError()'s own render() call)
    // rebuilds the card straight from the untouched state, which naturally
    // restores the Approve/Reject buttons. Retrying resubmits the same
    // decision, which is the natural "try again" action here.
    showError(error, () => handleHitlDecision(decision, answerId, runId));
  }
}

async function handleMemorySuggestion(suggestionId, action) {
  // Same synchronous-guard shape as feedbackInFlight/onboarding's busyKeys:
  // both Save and Ignore for a given suggestion share one key, so a
  // double-click on either button (or one click on each in quick succession)
  // can't fire two concurrent /api/memory/confirm|forget requests for the
  // same suggestionId whose responses could then race and leave the
  // suggestion's status ambiguous.
  const busyKey = `memory-suggestion:${suggestionId}`;
  if (state.busyKeys.has(busyKey)) return;
  state.busyKeys.add(busyKey);
  render();
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
  } catch (error) {
    showError(error, () => handleMemorySuggestion(suggestionId, action));
  } finally {
    state.busyKeys.delete(busyKey);
    render();
  }
}

async function forgetMemoryPreference(key, value) {
  const c = t();
  // Same destructive-action confirmation pattern as disableAuthUser's
  // c.auth.disableConfirmTemplate: "Clear all" wipes every saved preference,
  // and a single "Remove" deletes one -- neither had any confirmation before,
  // unlike disabling an auth user which already prompts.
  const confirmMessage = key
    ? (c.chat.removeMemoryConfirm || "").replace("{key}", key).replace("{value}", String(value))
    : (c.chat.clearAllConfirm || "");
  if (!confirm(confirmMessage)) return;
  const busyKey = key ? `memory-forget:${key}:${value}` : "memory-forget-all";
  if (state.busyKeys.has(busyKey)) return;
  state.busyKeys.add(busyKey);
  render();
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
  } catch (error) {
    showError(error, () => forgetMemoryPreference(key, value));
  } finally {
    state.busyKeys.delete(busyKey);
    render();
  }
}

async function refreshMetrics(shouldRender = true) {
  if (!state.project) return;
  // Same stale-response guard as refreshMemory() above: capture the id this
  // call is fetching for, and only commit if state.project hasn't moved on
  // to a different project (via switchProject()) by the time the response
  // lands. Otherwise a slow response for a project the user has since
  // switched away from could overwrite the new project's metrics with the
  // old project's numbers.
  const projectId = state.project.id;
  const payload = await api(`/api/evaluation?projectId=${encodeURIComponent(projectId)}`);
  if (state.project?.id === projectId) state.metrics = payload.metrics;
  if (shouldRender) render();
}

async function refreshAuthAdmin(shouldRender = true) {
  // Not a strict mutex (this is idempotent and already called from several
  // places -- setPage("dashboard"), the explicit Refresh button,
  // saveBrowserAuthToken(), after create/disable-user success): the busyKey
  // just gives the Refresh button a visible pending state while any of those
  // calls is in flight, per the same state.busyKeys convention used
  // elsewhere for actions that *do* need real reentrancy guards.
  state.busyKeys.add("auth-refresh");
  if (shouldRender) render();
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
  } finally {
    state.busyKeys.delete("auth-refresh");
    if (shouldRender) render();
  }
}

// Both token inputs (topbar + Auth Operations panel) must be pushed to the
// same value at once whenever we programmatically commit one: render()'s own
// captureFormStateBeforeRender() re-reads whichever token input it finds
// (focused one, else the first) *before* rebuilding the DOM, so if only one
// of the two live DOM nodes were updated here, that capture step could pick
// up the *other*, still-stale one and clobber the value we just committed.
// Writing directly into every matching node sidesteps that race entirely.
function syncAuthTokenInputsDom(value) {
  document.querySelectorAll("[data-auth-token-input]").forEach((el) => {
    el.value = value;
  });
}

function saveBrowserAuthToken(sourceElement = null) {
  const token = sourceElement?.closest(".auth-token-row, .topbar-auth")?.querySelector("[data-auth-token-input]")?.value?.trim()
    || document.querySelector("[data-auth-token-input]")?.value?.trim()
    || "";
  state.authToken = token;
  // Once saved, the draft is committed -- clear it so future renders read
  // from state.authToken (the two token inputs stay in sync via that).
  state.draftAuthToken = null;
  syncAuthTokenInputsDom(token);
  if (token) localStorage.setItem("aido-api-token", token);
  else localStorage.removeItem("aido-api-token");
  state.auth = { ...(state.auth || {}), createdToken: null };
  refreshAuthAdmin();
}

async function createAuthUserFromForm() {
  // Guards the same window as feedbackInFlight/onboarding's busyKeys: without
  // it, double-clicking "Create user" (or clicking again before the first
  // response lands) fires two concurrent /api/auth/users POSTs for
  // whatever's currently in the form.
  if (state.busyKeys.has("auth-create-user")) return;
  state.busyKeys.add("auth-create-user");
  render();
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
    // User created successfully -- reset the form. Resetting only
    // state.authUserForm is not enough: render()'s own
    // captureFormStateBeforeRender() re-reads these same five inputs'
    // *current* (still-filled-in) DOM values before rebuilding, which would
    // immediately clobber the reset back to what was just submitted. Clear
    // the live DOM nodes directly first so that capture step reads (and
    // therefore re-confirms) the reset values instead of stale ones.
    // Left untouched on error so the user doesn't lose what they typed.
    const resetForm = { userId: "", role: "viewer", scopes: "project:read", orgId: "", issueToken: true };
    const userIdEl = document.querySelector("#authUserIdInput");
    const roleEl = document.querySelector("#authRoleInput");
    const scopesEl = document.querySelector("#authScopesInput");
    const orgEl = document.querySelector("#authOrgInput");
    const issueTokenEl = document.querySelector("#authIssueTokenInput");
    if (userIdEl) userIdEl.value = resetForm.userId;
    if (roleEl) roleEl.value = resetForm.role;
    if (scopesEl) scopesEl.value = resetForm.scopes;
    if (orgEl) orgEl.value = resetForm.orgId;
    if (issueTokenEl) issueTokenEl.checked = resetForm.issueToken;
    state.authUserForm = resetForm;
  } catch (error) {
    // The form fields are left untouched on error (see the comment above), so
    // a retry re-reads the same values the user already typed instead of
    // silently discarding them behind an alert().
    showError(error, () => createAuthUserFromForm());
  } finally {
    state.busyKeys.delete("auth-create-user");
    render();
  }
}

async function disableAuthUser(userId) {
  if (!userId) return;
  const c = t();
  const confirmMessage = (c.auth.disableConfirmTemplate || "").replace("{user}", userId);
  if (!confirm(confirmMessage)) return;
  // Confirmed above; guard the window between that confirmation and the
  // response landing so a second click can't fire a second
  // /api/auth/users/disable request for the same userId (and, on the retry
  // path below, so the retry itself can't stack with a fresh click).
  const busyKey = `auth-disable:${userId}`;
  if (state.busyKeys.has(busyKey)) return;
  state.busyKeys.add(busyKey);
  render();
  try {
    await api("/api/auth/users/disable", {
      method: "POST",
      body: JSON.stringify({ userId })
    });
    state.auth = { ...(state.auth || {}), createdToken: null };
    await refreshAuthAdmin(false);
  } catch (error) {
    showError(error, () => disableAuthUser(userId));
  } finally {
    state.busyKeys.delete(busyKey);
    render();
  }
}

async function loadHarnessAudit(runId) {
  if (!state.project || !runId) return;
  const busyKey = `harness-audit:${runId}`;
  if (state.busyKeys.has(busyKey)) return;
  state.busyKeys.add(busyKey);
  render();
  try {
    state.harnessAudit = await api(`/api/harness-run?projectId=${encodeURIComponent(state.project.id)}&runId=${encodeURIComponent(runId)}`);
  } catch (error) {
    showError(error, () => loadHarnessAudit(runId));
  } finally {
    state.busyKeys.delete(busyKey);
    render();
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  syncLocationHash();
  render();
}

document.addEventListener("click", (event) => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    // Workflow cards on the landing page (see the "cards" copy data) may
    // carry an optional data-tab alongside data-page="chat" -- e.g. the
    // "Analyze" card wants to land on the impact tab specifically, not
    // whatever tab happened to be active last, so its dedicated empty-state
    // copy (chatPage()'s importImpact branch) actually shows up.
    if (pageButton.dataset.tab) state.activeTab = pageButton.dataset.tab;
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

  // existingProjectsStrip()'s pills on the import page -- unlike the topbar
  // switcher (a <select>, wired through the "change" listener below this
  // one), these are plain buttons, so a click reaches this handler directly.
  // Also lands on Overview afterward, same as a fresh import would: picking
  // an existing project here is standing in for "import it", and Overview is
  // where importRepository() already sends a successful import.
  const switchProjectButton = event.target.closest("[data-switch-project]");
  if (switchProjectButton) {
    switchProject(switchProjectButton.dataset.switchProject).then(() => setPage("overview"));
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
    // Root cause of the "click fills nothing" bug: render() always re-reads
    // whatever #questionInput *currently* contains into state.drafts[activeTab]
    // at its very top, before rebuilding the DOM (see
    // captureFormStateBeforeRender()) -- that is exactly what used to race
    // with (and usually lose to) a requestAnimationFrame callback that wrote
    // the chosen question straight into the DOM after the fact: setPage()
    // below runs a render() synchronously, and requestAnimationFrame also
    // does not fire at all while the document is hidden/backgrounded, which
    // silently dropped the value in exactly the kind of headless/automated
    // check that first caught this. Fixing it the same way per-tab drafts
    // fixed manual typing: route the value through state (or the live DOM
    // node render() is about to read from) instead of a side-channel DOM
    // write that competes with render()'s own capture step.
    const questionText = question.dataset.question;
    const existingInput = document.querySelector("#questionInput");
    if (existingInput) {
      // Already on a tab with a live textarea (qa/impact/agent): write into
      // it now so the render() inside setPage() picks it up via its own
      // DOM-capture step (which writes back into state.drafts[...] keyed by
      // the textarea's own data-tab, i.e. whichever of the three tabs is
      // currently mounted -- setPage() here doesn't touch state.activeTab,
      // so it's still the mounted tab throughout) and carries it
      // through the rebuild.
      existingInput.value = questionText;
    } else {
      // No textarea mounted yet -- either we're not on the chat page at all
      // (Overview/Landing quick actions), or the onboarding tab is active
      // (it has no free-text box). Either way there is nothing to write
      // into, so set the state directly and land on the qa tab, which is
      // guaranteed to render the textarea.
      state.drafts.qa = questionText;
      state.activeTab = "qa";
    }
    setPage("chat");
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
      state.draftAuthToken = null;
      syncAuthTokenInputsDom("");
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

// Separate "change" listener rather than shoehorning this into the "click"
// one above: a <select> fires "change" (after the browser's own native
// dropdown UI closes), not "click" on the option that ends up chosen, so it
// would never reach the click handler's data-action dispatch at all.
document.addEventListener("change", (event) => {
  const projectSelect = event.target.closest("[data-project-switch]");
  if (projectSelect) {
    switchProject(projectSelect.value);
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
      if (workflowCard.dataset.tab) state.activeTab = workflowCard.dataset.tab;
      setPage(workflowCard.dataset.page);
    }
  }
});

await loadProjects();
// Restore whatever page/tab the URL names (survives a refresh or a pasted
// deep link like "#/dashboard") before the very first render.
// loadProjects() must finish first: chatPage()/dashboardPage() key off
// state.project, which it populates from the store's persisted projects, so
// by the time a hash names e.g. "#/chat/agent" there is already a project to
// show real content for (or not, in which case those pages fall back to
// their own "import a repo first" empty state exactly as they would from a
// manual nav click).
const initialRoute = parseHash();
if (initialRoute?.page === "chat") state.activeTab = initialRoute.tab;
await checkHealth();
setPage(initialRoute?.page || "landing");
