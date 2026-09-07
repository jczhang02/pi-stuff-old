# Pi Stuff

Pi Stuff names the concepts used to assemble a personal set of Pi capabilities without replacing Pi itself.

## Language

**Host**:
The native Pi coding agent process that discovers, loads, and runs Runtime Resources.
_Avoid_: Suite runtime, custom agent

**Suite**:
The cohesive collection of personal Pi capabilities selected for use together.
_Avoid_: agent, framework, platform

**Capability**:
One coherent, independently understandable behavior contributed to the Suite.
_Avoid_: feature bundle, miscellaneous extension

**Pi Stuff Package**:
The single local Pi Package that presents the ordered Suite to the Host.
_Avoid_: aggregate, launcher, wrapper CLI

**Capability Module**:
An internal, independently understandable implementation boundary for one Capability. It has no package manifest,
version, installation, or publication lifecycle of its own.
_Avoid_: Capability Package, npm package, plugin fragment

**Repository-owned Source**:
Code maintained inside Pi Stuff and subject to the same architecture, quality, compatibility, and certification
obligations regardless of whether it originated locally, in a fork, or from vendored upstream material.
_Avoid_: upstream exception, vendored exception, fork exemption

**Capability Contract Catalog**:
The maintained inventory of every user- or Host-observable behavior promised by the Suite within the certified Host
profile. Each contract identifies its owning Capability, public seam, scenario, required evidence, and acceptance
status. One contract is one stable observable promise and may carry multiple normal, failure, recovery, persistence,
or boundary scenarios; private implementation functions and scenario variants are not separate contracts.
_Avoid_: Feature checklist, test list, function coverage

**Conditional Capability Contract**:
A Capability contract whose configured success scenario requires an optional executable, credential, or external
Service. Its unconfigured behavior remains an unconditional contract; a missing required dependency blocks configured
acceptance and never counts as passed, skipped, or not applicable.
_Avoid_: Optional test, skipped feature, best-effort contract

**Capability Benchmark**:
An evaluation of one Capability or a limited group of Capabilities for performance, resource use, or behavioral
effectiveness, regardless of whether execution uses the complete Host or public tasks. It supplies comparative evidence,
not Capability Contract Acceptance or PR-blocking authority.
_Avoid_: Internal-only benchmark, correctness test, Suite Outcome Evaluation

**Suite Outcome Evaluation**:
An evaluation of the complete Suite on an external public task set, measuring task outcomes and comparing declared
configurations such as native Pi and Pi Stuff. It does not establish coverage or acceptance of every Capability and has
no PR-blocking authority.
_Avoid_: Pi Stuff score, harness certification, correctness test, Capability Benchmark

**Capability Contract Acceptance**:
The verification of every applicable Capability Contract Catalog entry in an isolated scenario using its declared
Acceptance Evidence Profile. Deterministic or authenticated acceptance may certify a contract; Suite Outcome
Evaluation cannot.
_Avoid_: Feature smoke test, function coverage, benchmark pass

**Acceptance Evidence Profile**:
The declared execution boundary for one Capability contract: the exact real Host is required, while live Provider and
live external Service use are stated separately when the behavior depends on them. A fixture Provider is deterministic
evidence, not live evidence.
_Avoid_: Realness level, truth test, production-like test

**Diagnostic Record**:
A bounded, current-process account of a Suite problem for human inspection. It never enters Session history or model
context. The owning Capability presents ordinary state locally; only a user-relevant problem may raise the shared
one-row notice, with details available through `/diagnostics`.
_Avoid_: console warning, transcript message, notification log

**Runtime Resource**:
An Extension, Skill, Prompt Template, or Theme that the Host discovers through Pi's Package contract.
_Avoid_: asset, plugin file

**Skill Discovery**:
The Host-owned model-context catalog of enabled, model-invocable Skills, exposing each name, description, and location
so an Agent can choose and read a matching Skill. It advertises Skill metadata rather than eagerly reading Skill bodies.
_Avoid_: Skill search, eager Skill loading

**RTK Runtime**:
The separately installed, certified RTK executable whose CLI owns RTK command rewriting and output optimization. The
Suite adapts the Host to it without duplicating its rewrite registry or installation lifecycle.
_Avoid_: Embedded RTK, Pi Stuff command parser

**Session Name**:
Pi-owned Session metadata that gives one coding conversation a concise semantic identity. Session Naming may propose
and persist this value after settled direct-user work, but it does not replace the Session, task, Goal, or Agent name.
_Avoid_: chat title, task name, autoname state

**Settings Layer**:
User-owned declarations that select and configure Packages and Runtime Resources for a Host installation.
_Avoid_: Suite configuration, installer state

**Settings Namespace**:
One Capability-owned top-level object in `<agentDir>/pi-stuff.json`. Its owner may read and replace that object while
preserving sibling namespaces; the merged file, lock, and atomic write remain shared infrastructure.
_Avoid_: Capability settings file, global config

**Vibe Line Spinner**:
The Host-owned animated glyph that indicates active Agent work. It is a liveness signal, distinct from the working
message, Thinking transcript content, and other Conversation UI content.
_Avoid_: Vibe Line, Working Row, Thinking display

**Logical Thinking Run**:
A continuously updated visible reasoning segment treated as one narrative unit. A later separately visible reasoning
segment is a new run; streaming deltas, terminal wrapping, and redraw are not.
_Avoid_: Thinking row, terminal line, provider content index

**Narrative Boundary**:
A visible event that separates one Tool execution phase from the next: Assistant prose, user input, a visible
model-context Custom Message, or a new Logical Thinking Run after Tool activity. Updates within the current Logical
Thinking Run, hidden state, and branch or compaction metadata do not create another boundary.
_Avoid_: Assistant message boundary, API turn, physical terminal row

**Agent Work Duration**:
The wall-clock duration of one user-started Agent work cycle minus intervals when Pi is waiting for a UI prompt
response. Notification compares this value with its configured minimum-duration threshold; Goal active elapsed time
and Host lifecycle timing remain unchanged.
_Avoid_: Prompt-inclusive run duration, Goal elapsed time, model latency

**Work Continuity Contract**:
The Suite guarantee that work owned by the current Session does not become blocked or terminal solely because internal
accounting, retained evidence, completed-work totals, or productive elapsed time crosses an arbitrary threshold. User
or Host lifecycle authority and recoverable cost, runaway, external-availability, and integrity controls remain outside
this guarantee.
_Avoid_: Unlimited execution, cross-Session daemon, no limits

**Tool Activity**:
A display-only unit representing either one independent Tool invocation or one Retrieval Group. Its projection does
not merge or alter the underlying protocol events, ordering, or Session history.
_Avoid_: Tool call, Tool row, Tool Activity Group

**Retrieval Group**:
A derived display-only summary of one bounded continuous segment of native Read, Grep/Find, or List invocations,
excluding a Read whose resolved basename is exactly `SKILL.md`. A longer continuous run appears as ordered
continuation segments; a Narrative Boundary, independent Tool Activity, automatic continuation, or turn completion
closes the run.
_Avoid_: Exploration group, Tool batch, merged Tool call

**Skill Tool Activity**:
An independent Tool Activity for a native Read whose resolved basename is exactly `SKILL.md`. It derives
`Skill <name>` from the resolved parent directory while retaining the underlying Read protocol and forming a Narrative
Boundary.
_Avoid_: Native Skill row, Skill Retrieval Group, Skill registry result

**Operation Block**:
A display-only Transcript projection of one independent, evidence-rich Tool Activity, with a bounded
`Tool(operation identity)` parent and indented child outcome evidence at the invocation's native position. It is a
closed family comprising Bash, Write, Edit, Patch, Background output, and an unmatched outer Code Mode issue, not a
universal Tool card or a grouping rule.
_Avoid_: Tool card, Universal Tool Block, Command Block
**Bash Operation Block**:
A Bash specialization of Operation Block, with one bounded command identity and child output preview. Shell
composition inside the call remains one operation, and the underlying Tool result and Session records remain unchanged.
_Avoid_: Command group, parsed subcommand, Retrieval Group

**Envelope Fallback Row**:
The single ordinary Tool Activity that represents an envelope only when no nested operation or media projection owns
its user-visible outcome, including an unmatched outer error, rejection, or cancellation. Valid nested activities
remain the sole visible authority; missing historical definitions and presentation failures instead use generic
activities at their original source positions.
_Avoid_: Envelope chrome, raw Tool result, duplicate error row

**Control-only Execution**:
A Code Mode execution that carries only Host scheduling or continuation signals and no user-relevant work outcome. It
remains diagnostic evidence rather than a Conversation Transcript event.
_Avoid_: Internal wait, empty Code Mode call, no-op Tool

**Execution Ledger**:
Code Mode's authoritative append-only replay and recovery state stored in Pi Session custom entries. It keeps exact
canonical completion payloads, never imposes a cumulative work quota, and treats post-effect persistence failure as
incomplete; it is not a second database or a model-facing transcript.
_Avoid_: Code Mode database, recovery log

**Tool Discovery**:
The model-facing search over the currently active Package-owned Tool catalog. It returns bounded, ranked matches that
help invoke a relevant Tool and never substitutes an unrelated Tool when no catalog entry matches.
_Avoid_: Tool recommendation, Tool activation

**Agent Context Usage**:
The current Provider payload token estimate for one child Agent, measured against the selected child Host model's
reported Context window. Authoritative Assistant usage replaces the estimate; later Tool results and other trailing
messages add bounded Host-equivalent estimates. Parent-Host model metadata is only a launch-time fallback until the
child Host reports its actual selection. It is not cumulative run usage. Context Management/Magic owns child pressure
handling; Agents does not terminate a child or replace its Provider request from a local estimate.
_Avoid_: Agent tokens, total Agent usage, Context budget

**Agent Target**:
The public pair of a stable Agent run ID and child index used by Agent control actions. Model-visible status exposes
these fields separately; an internal roster row key is display identity rather than an Agent Target.
_Avoid_: Agent key, child address

**Agent Lifecycle Row**:
A display-only Transcript projection of one Agent Tool lifecycle event. Background launch and completion remain
separate chronological events. Agents owns lifecycle and protocol evidence; Context Management/Magic owns child pressure
projection, while delivery returns bounded outcomes to the originating main Agent.
_Avoid_: Agent Operation Block, Subagent Row, Agent roster row

**Context Activity**:
A model-invisible, persisted Session record for one user-started Context maintenance operation. One visible Pi Stuff row
projects its anchor and later updates after resume. It is not a Tool call, Diagnostic Record, or Statusline item.
_Avoid_: Context Tool Activity, Context notification, Context status

**Bounded Context Projection**:
A derived context projection shaped by Context Management for its requesting audience. Local capacity estimates guide
display and proactive compaction; they do not establish Provider acceptance or authorize foreground cancellation.
With Magic enabled, foreground requests use Magic's projection, while BTW and Agents retain their bounded reference
contracts. Unrecoverable projection failure preserves input and stops without substituting raw history.
_Avoid_: Safe Context, validated capacity guarantee

**Prompt Contribution**:
A marker-delimited, Capability-owned system-prompt fragment that Context Management orders and reconciles on every
Provider activation without changing Session history. It is not an independent lifecycle or a replacement system prompt.
_Avoid_: Prompt injection, appended system prompt, context patch

**Ponytail Mode**:
The Session-selected `off`, `lite`, `full`, or `ultra` implementation-discipline level. It persists in a model-invisible
Session entry and is snapshotted into delegated Agents; `review` is a Skill, not a Ponytail Mode. `off` is a hard model
boundary: Ponytail contributes neither standing instructions nor a model-visible Skill catalog, while explicit Skill
commands remain available.
_Avoid_: Review mode, Agent mode, global mode

**Context Engine Worker**:
The internal Bun Worker in Context Management that runs the exact Magic Context derived-state engine away from Pi's UI
thread. It receives immutable Host snapshots and returns Context results through a narrow adapter; Pi still owns the
CLI, TUI, Session, model request, and Agent lifecycle.
_Avoid_: Context Host, Context runtime, transcript worker

**Fenced Visualization Projection**:
A display-only conversion of a complete, valid `chart` or `tree` fenced code block into width-bounded terminal text at
the Conversation Markdown seam. Canonical message text, Session records, copy/export source, and Provider context remain
unchanged; failed validation preserves the original fence.
_Avoid_: Fenced Block plugin, visualization runtime, transformed Session content

**Todo Task**:
A planned unit of work maintained by the Suite's Task tools and checklist. It describes intent; it is not an executing process, wait, or Agent.
_Avoid_: Background task, job

**Background Work**:
Current-session activity that continues without occupying the main Agent, comprising a Background Shell or a Monitor.
It is live management state, not a Todo Task, Agent projection, Tool invocation, or durable history.
_Avoid_: Todo, daemon, scheduler

**Background Shell**:
A Host-session-owned operating-system command that continues independently after an explicit background launch or foreground detach. It ends with the current Host session and never becomes a cross-session daemon.
_Avoid_: Job, service

**Foreground Handoff**:
The transition of a still-running foreground Bash invocation into a Background Shell, whether requested with `Ctrl+B`
or applied by the runtime threshold. It changes execution placement but preserves the current user work's obligation to
receive and reconcile the terminal outcome.
_Avoid_: Implicit background launch, fire-and-forget

**Monitor**:
A one-shot wait for one explicit observable condition in Background Work, such as a command result, log match, file state, or HTTP response. It is not a polling conversation, recurring loop, or schedule.
_Avoid_: Watcher, cron, polling task

**Completion Report**:
A user-facing Assistant response that states whether the requested work completed, cites the decisive terminal
evidence, and names any remaining work. A raw Background Work outcome notification or compact Goal terminal Tool result
is delivery or status input, not a Completion Report.
_Avoid_: Completion notification, Background command row, Goal Tool summary

**Goal Final Response**:
The Goal-specific Completion Report requested after an accepted completed or blocked terminal state when no budget or
other forced-stop boundary prevents the follow-up. It owns the detailed
user-facing Goal result in the Conversation Transcript and finishes within the same foreground Agent run; it is not the
compact terminal Tool result, Goal status, a notification, or a synthetic Session message.
_Avoid_: Goal completion message, Goal Tool summary, completion notification
