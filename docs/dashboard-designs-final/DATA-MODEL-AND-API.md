# Project Rollups — Data Model and API Spec

This is the implementation spec for the Project Rollups dashboard (`index.html` in this
folder). It documents what pi and pi-web expose today, what is missing, the new
pi-web-owned entities, the REST + realtime surface, and how progress and Definition-of-Done
are derived. Everything the mockup renders traces back to a real signal listed here; where a
signal does not exist yet, this spec says so and names the smallest thing that has to be built.

The guiding constraint: pi has no concept of a project, a workstream, progress, or a
definition of done. All of that is invented and owned by pi-web, persisted in a sidecar file,
and computed on read. The model to copy is `server/sessionUiState.ts`, which already stores
session-keyed metadata outside the pi session files.

---

## 1. What pi exposes today

### 1.1 Persistent sessions — `SessionManager`

A pi session is an append-only JSONL **tree** (entry id + parentId + leaf pointer), one file
per session, under `~/.pi/agent/sessions/<encoded-cwd>/`. The methods pi-web relies on:

- `SessionManager.list(cwd, sessionDir?, onProgress?) => Promise<SessionInfo[]>` — sessions for one cwd.
- `SessionManager.listAll(sessionDir?, onProgress?) => Promise<SessionInfo[]>` — across all project dirs.
- `static open(path)`, `static create(cwd)`, `static continueRecent(cwd)`, `static forkFrom(...)`.

`SessionInfo` real fields:
`path, id, cwd, name?, parentSessionPath?, created: Date, modified: Date, messageCount, firstMessage, allMessagesText`.

**`cwd` is the only structural grouping signal.** `parentSessionPath` (forks) is the only
cross-session link. There is no project, workstream, tag, or status field.

Instance reads (`ReadonlySessionManager`): `getCwd, getSessionDir, getSessionId, getSessionFile,
getLeafId, getLeafEntry, getEntry, getLabel, getBranch, getHeader, getEntries, getTree,
getSessionName`.

`SessionEntry` union (`type` discriminant):
`"message" | "thinking_level_change" | "model_change" | "compaction" | "branch_summary" |
"custom" | "custom_message" | "label" | "session_info"`.

The two entries that matter for us:

- `CustomEntry { type:"custom", customType, data? }` — extension state, **not** sent to the LLM.
  This is the only sanctioned place to persist arbitrary structured data inside a session file.
- `CustomMessageEntry { customType, content, display, details? }` — like custom but injected into
  LLM context. We do **not** use this for DoD (it would pollute the model's context).
- `SessionInfoEntry { type:"session_info", name? }` — user-facing display name (`getSessionName()`).
- `LabelEntry { targetId, label }` — per-entry bookmarks.

There is **no** `plan`, `task`, `todo`, `milestone`, `done`, or `status` entry type.

### 1.2 Live runtime — `AgentSession`

The in-memory running agent. Getters/methods pi-web uses: `state, model, thinkingLevel,
isStreaming, isCompacting, messages, sessionFile, sessionId, sessionName, pendingMessageCount,
getActiveToolNames(), getAllTools(), getContextUsage(), getSessionStats(),
getAvailableThinkingLevels(), prompt(), abort(), compact(), navigateTree(), setModel(),
setSessionName(), subscribe(listener)`.

`SessionStats` (from `getSessionStats()`): `sessionFile, sessionId, userMessages,
assistantMessages, toolCalls, toolResults, totalMessages, tokens:{input,output,cacheRead,
cacheWrite,total}, cost, contextUsage?`. `ContextUsage = {tokens, contextWindow, percent}`.
This is cost/token accounting, **not** goal progress.

`AgentSessionEvent` from `subscribe`: the core `AgentEvent` (`agent_start`, `agent_end`,
`message_update`, `message_end`, `turn_start`, `turn_end`,
`tool_execution_start/update/end`) plus `queue_update`, `compaction_start`, `compaction_end`,
`session_info_changed`, `thinking_level_changed`, `auto_retry_start/end`.

There is no "task complete", "blocked", or "progress" event. Completion is only inferable from
`agent_end` (with `willRetry`) and from `tool_execution_end` errors.

### 1.3 Tools and skills

Built-in tools: **read, bash, edit, write** (default active) + find, grep, ls. There is **no
TodoWrite/plan tool** analogous to Claude Code — any "plan items" concept must be synthesized
(an extension custom tool writing `CustomEntry`). Skills (`Skill { name, description, filePath,
baseDir, sourceInfo }`) surface as `/skill:name` slash commands and are not a progress/DoD
primitive.

### 1.4 pi-web server

**Multi-session runtime (`server.ts` ~1242-1900).**
`liveSessions: Map<sessionFile, LiveSessionEntry>` where
`LiveSessionEntry = { session, unsubscribe?, viewerClientIds:Set, workLeases:number,
disposeTimer?, disposing? }`. Sessions load lazily (`getOrCreateLiveSession` /
`getOrCreateLiveSessionById`) and dispose when idle (`PI_WEB_SESSION_IDLE_GRACE_MS`, default
60s) via `disposeLiveSession`. **This 60s dispose is why loop elapsed time cannot come from
runtime state — see §5.**

Per-path runtime: `runtimeStartedAts`, `runtimeLastActivityAts` Maps + `runtimeForPath(path)`
returns `{ loaded, isRunning, isStreaming, isCompacting, startedAt, lastActivityAt,
pendingMessageCount, model }`. This is the canonical per-session live status object (typed as
`SessionInfo.runtime` in `src/app/types.ts`).

`knownCwds: Set<string>` (seeded with `piCwd`) drives `listSessionInfos()`, which fans out
`SessionManager.list(cwd)` per known cwd and merges. `simplifySessionInfo` maps the SDK
`SessionInfo` to the web shape and attaches `runtime`.

**Git (`server.ts` ~193-453) — local only, no PR/CI.**

- `gitStatus(cwd) → { isRepo, root, branch, upstream, defaultRemoteBranch, ahead, behind,
  files:[{path,oldPath?,indexStatus,worktreeStatus,label,staged}] }`,
  label ∈ untracked/conflicted/renamed/added/deleted/staged/modified.
- `gitRepoSummary → { path, root, branch, upstream, ahead, behind, dirtyCount, isCurrent }`;
  `listGitRepos(cwd)` scans cwd + 1 level deep.
- `gitLog` (last 200, `--all`), `gitCommitDetails(hash)` (name-status + **numstat
  additions/deletions** + patch), `/api/git/sync` does `fetch --prune` + `pull --rebase
  --autostash`.

There is **no push, no PR creation, no CI/test status**. The only "shipped" signals are
`ahead`/`behind`/`dirtyCount` and the commit graph.

**Realtime (`/ws`, `server.ts` ~2671-2721 + `src/realtime/realtime.ts`).**
A single global WebSocket (token-auth on upgrade). Seq-numbered envelopes with a 1000-event
replay log (`realtimeEventLog`, `recordRealtimeMessage`); reconnect with `?lastSeq=` replays or
sends `sync_required`. `broadcast(value)` fans out to all `clients`. Message types: `hello`,
`state_changed`, `session_runtime_changed`, `session_stats_changed`, `models_updated`,
`settings_updated`, `session_ui_state_changed`, `session_deleted`, `pi_event` (wraps an
`AgentSessionEvent` with `sessionId`/`sessionFile`), `web_footer_changed`,
`web_header_actions_changed`, `extension_ui_request`, `server_error`, `sync_required`.
**Events are not scoped per session on the wire** — every client gets every session's events
and filters by `sessionId` client-side.

**UI/annotation store (`server/sessionUiState.ts`).**
`SessionUiState { version:1, pinnedSessions:[{id,label,cwd?}],
sessionMarkers:[{sessionId,color,updatedAt}] (5 colors), sessionUnreadStates:[{sessionId,
unreadAt,updatedAt}], selectedMarkerColor }`, persisted atomically to
`~/.pi/agent/pi-web-session-ui-state.json` via `createSessionUiStateStore`. **This is the exact
precedent to copy for the project registry.** In the drawer, sessions are grouped into
collapsible folders by cwd basename (`folderName()` in `src/sessions/sessionDrawer.ts`); there
is no first-class project entity.

---

## 2. Gaps (what has to be built)

| Gap | Consequence for Rollups |
| --- | --- |
| No Project entity | No registry of named projects. Grouping is implicit (cwd basename folders) + manual pins/markers. Must invent + persist. |
| No Workstream concept | Sessions cannot be grouped into a sub-unit of a project. `parentSessionPath` (forks) is the only relation and is not a workstream. |
| No Definition of Done | No DoD entry type, field, or store. Must be invented and persisted by pi-web. |
| No progress value | Nothing computes or stores percent-complete. `SessionStats` is cost/tokens; `ContextUsage` is context-window fill. |
| No status taxonomy | `runtimeForPath` gives isRunning/isStreaming/isCompacting + unread. No planned/in_progress/blocked/done/abandoned lifecycle. |
| No "blocked" signal | Nothing represents waiting-on-human / failing-test / merge-conflict-as-blocker. (`conflicted` exists per-file, not surfaced as a session blocker.) |
| No plan/task items | No TodoWrite equivalent, no plan entry. Nothing to count for plan-based progress. |
| No PR / CI / test integration | Git is local-only. No push, PR, or test-run status to key "done" off. |
| No aggregation endpoint | `/api/sessions` is a flat list. Nothing rolls up by project/workstream or computes counts/progress. |
| No per-project realtime scoping | `/ws` is global and emits every session's events. Fine at current scale; client filters by membership. |

---

## 3. Proposed types

New pi-web-owned entities, stored in a sidecar and computed on read. These mirror the shapes in
`src/app/types.ts` and reuse the existing `SessionInfo.runtime`.

```ts
// ---- Stored entities (sidecar; pi-web-owned, NOT in pi) ----

export type WorkItemStatus =
  | "planned" | "in_progress" | "blocked" | "done" | "abandoned";

// A project groups one or more repos/cwds + workstreams.
export interface Project {
  id: string;                 // pi-web generated (uuid)
  name: string;
  description?: string;
  roots: string[];            // absolute cwd paths; sessions matched by cwd prefix
  workstreamIds: string[];    // ordered
  dod?: DoD;                  // project-level acceptance criteria
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}

// A workstream groups sessions within a project (e.g. "auth", "billing").
export interface Workstream {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  status: WorkItemStatus;      // user-set or derived (see §5)
  sessionIds: string[];        // pi SessionInfo.id values (explicit membership)
  matchCwd?: string;           // optional cwd prefix to auto-include sessions
  dod?: DoD;
  order: number;
  createdAt: string;
  updatedAt: string;

  // ---- loop telemetry: net-new, STORED, never inferred (see §5.4) ----
  isLoop?: boolean;
  loopStartedAt?: string;      // ISO; elapsed is computed from THIS, not runtimeForPath
  budget?: { maxMinutes?: number; maxCostUsd?: number };
  paused?: boolean;            // registry flag the orchestrator honours
}

// ---- DoD: a list of evaluable criteria, source-typed so progress is computable ----

export type DoDSource =
  | { kind: "manual" }                                    // user toggles
  | { kind: "git_clean"; repo?: string }                  // dirtyCount === 0
  | { kind: "git_merged"; repo?: string; into: string }   // branch merged into <into>
  | { kind: "git_ahead_zero"; repo?: string }             // ahead === 0 vs upstream
  | { kind: "command"; cwd: string; cmd: string; expectExit?: number } // test/build
  | { kind: "session_idle"; sessionId: string };          // agent reached agent_end, no pending

export type Provenance = "user" | "agent" | "orchestrator" | "rule";

export interface DoDCriterion {
  id: string;
  text: string;               // human-readable acceptance criterion
  source: DoDSource;          // HOW it is evaluated (evaluator)
  authoredBy?: Provenance;    // WHO defined it (the at-rest pill); separate from evaluator
  gate?: boolean;             // a manual sign-off gate: EXCLUDED from percent (see §5.2)
  weight?: number;            // default 1
}

export interface DoD { criteria: DoDCriterion[]; }

// ---- Evaluated snapshot (computed, never stored as truth) ----

export interface CriterionEval {
  id: string;
  met: boolean;
  evidence?: string;          // "branch merged at <sha>", "exit 0", "you checked"
  evaluatedAt: string;        // ISO; drives stale/unrun handling
  unrun?: boolean;            // command criterion that has never run -> excluded from %
  stale?: boolean;            // ran, but the cached result is old -> can't back a 100%
}

export interface ProgressSnapshot {
  met: number; total: number; // k of n RUN, fresh, non-gate criteria
  metWeight: number; totalWeight: number;
  percent: number;            // metWeight/totalWeight*100 over RUN non-gate criteria
  allMet: boolean;            // every evaluable criterion RUN, FRESH, met -> may promote to sign
  unrun: number; stale: number;
  derivedStatus: WorkItemStatus;
  criteria: CriterionEval[];
}

// ---- Rollup view models returned by /api/rollups (the dashboard feed) ----

export interface SessionRollup {
  id: string; name?: string; cwd?: string;
  modified: string; messageCount: number;
  runtime: SessionInfo["runtime"];   // reuse existing runtime shape
  unread?: boolean;

  status: WorkItemStatus;            // derived from runtime + DoD + git
  progress?: ProgressSnapshot;       // present if a DoD targets this session
  git?: { branch: string; ahead: number; behind: number; dirtyCount: number; blocked: boolean };

  // fields the UI renders that must ride on the view model (see "rendered fields" below)
  live?: string;                     // representative one-liner (last assistant summary)
  elicitation?: { question: string; options: string[] }; // structured ask -> chips
  blast?: "hi" | "md" | "lo";        // triage ordering only; gates nothing
  failAction?: string;               // "Re-authenticate", "Re-run tests"
  loop?: { iter: number; sparks: number[]; startedAt: string;
           budget?: { maxMinutes?: number; maxCostUsd?: number } };
  plannedQueue?: { items: string[]; total: number; source: "notes" | "plan_tool" };
  dod?: { text: string; sourceLabel: string; authoredBy: Provenance; criteria: CriterionEval[] };
  artifact?: ArtifactReceipt;
}

export interface ArtifactReceipt {
  kind: "diff" | "doc";
  branch?: string; sha?: string; merged?: boolean;
  add?: number; del?: number;        // git numstat
  note?: string; files?: number;     // doc: derived from write/edit tool_result entries
  check?: { cmd: string; exit: number; at: string };
}

export interface WorkstreamRollup {
  workstream: Workstream;
  sessions: SessionRollup[];
  progress: ProgressSnapshot | null; // null when mixed-source (see below)
  mixed?: boolean;                   // sessions span >1 evaluator family
  sessionGauge?: { done: number; total: number; percent: number }; // used when mixed
  counts: Record<WorkItemStatus, number>;
  loop?: SessionRollup["loop"];
}

export interface ProjectRollup {
  project: Project;
  workstreams: WorkstreamRollup[];
  progress: ProgressSnapshot;
  counts: Record<WorkItemStatus, number>;
  activeSessionCount: number;        // runtime.isRunning across the project
  lineage?: { parentProjectName: string; fullPath: string }; // nested-root badge
}

// ---- Persisted sidecar shape (parallels SessionUiState) ----
export interface ProjectRegistry {
  version: 1;
  projects: Project[];
  workstreams: Workstream[];
  // manual criterion truth lives here too: the only mutable boolean for kind:"manual"
}
```

**Rendered fields that must ride on the view models.** The mockup draws ~15 fields per
session; the bare grounding-spec view models omitted roughly two-thirds of them. The
`SessionRollup` above is the corrected set: `live`, `elicitation`, `blast`, `failAction`,
`loop{iter,sparks,startedAt,budget}`, `plannedQueue{items,total,source}`,
`dod{text,sourceLabel,authoredBy,criteria}`, and `artifact`. `WorkstreamRollup` adds
`mixed`/`sessionGauge`/`loop`; `ProjectRollup` adds `lineage`. If a field is not on the view
model it cannot be rendered — that gap is what caused the early "asserts data it can't populate"
critiques.

---

## 4. API surface

### 4.1 Existing endpoints the dashboard reuses

| Method | Path | Use |
| --- | --- | --- |
| GET | `/api/sessions?cwd=...` | Flat session list merged across knownCwds, each with runtime + unread. The raw feed a rollup aggregates. |
| GET | `/api/state?sessionId=` | Full live state for one session (cwd, runtime, model, stats, sessionUiState). |
| GET | `/api/session/stats?sessionId=` | `SessionStats` — drives loop cost/budget. |
| GET | `/api/session/tree?sessionId=` | Conversation tree. |
| GET | `/api/messages?sessionId=` | Simplified message list (transcript + the `live` one-liner). |
| GET | `/api/git/repos?sessionId=` | Repos in the cwd. |
| GET | `/api/git/status?sessionId=&repo=&fetch=` | Working-tree status — primary git progress signal (dirtyCount, ahead, conflicted). |
| GET | `/api/git/log?sessionId=&repo=` | Commit graph (for `git_merged`). |
| GET | `/api/git/commit?hash=&repo=` | numstat +/− per file (artifact diff). |
| POST | `/api/git/sync?repo=` | fetch + pull --rebase. |
| GET/PATCH | `/api/session-ui-state` (+ `/read`) | The sidecar precedent; also stores `lastDashboardVisitAt`. |
| GET | `/api/settings` | App-level config precedent. |
| POST | `/api/prompt` | Send/steer a prompt to a background session. Drives Continue, quick-reply chips, and the "ask pi to merge" affordance. |
| GET | `/ws` | Single global realtime channel. |

### 4.2 New endpoints

| Method | Path | Purpose | Realtime |
| --- | --- | --- | --- |
| GET | `/api/projects` | List projects + workstreams from the registry (no rollup compute). | no |
| POST | `/api/projects` | Create a project (name, roots). | yes |
| PATCH | `/api/projects/:id` | Update project (name, roots, dod, archived); reorder/assign workstreams. | yes |
| DELETE | `/api/projects/:id` | Delete/archive a project. | yes |
| POST | `/api/projects/:id/workstreams` | Create a workstream under a project. | yes |
| PATCH | `/api/workstreams/:id` | Update name, status, sessionIds, matchCwd, dod, order, isLoop, budget, paused. | yes |
| PUT | `/api/workstreams/:id/sessions` | Attach/detach pi sessions (SessionInfo.id). | yes |
| PUT | `/api/workstreams/:id/dod` | Set the workstream DoD (`DoDCriterion[]`). | yes |
| GET | `/api/rollups` | **The dashboard feed.** Joins registry with `listSessionInfos()` + `runtimeForPath()`, evaluates DoD, computes `ProgressSnapshot` + counts → `ProjectRollup[]`. | yes |
| GET | `/api/rollups/:projectId` | Single `ProjectRollup` (cheap refresh for an open card). | yes |
| POST | `/api/dod/evaluate` | Evaluate a DoD (or one criterion) on demand: git checks inline, `command` criteria via `executeBash`. Returns `CriterionEval[]` with `evaluatedAt`. | no |
| PATCH | `/api/dod/criterion/:id` | Toggle a `manual` criterion's met state (the only mutable truth for `kind:"manual"`). Backs one-click sign-off. | yes |

### 4.3 New realtime envelopes (reuse the global socket)

- `project_registry_changed` — registry mutated; refetch `/api/projects`.
- `rollup_changed { projectId }` — a project's rollup recomputed; refetch `/api/rollups/:id`.
  Emitted **debounced** and **dirty-project-scoped**.

The dashboard already receives `session_runtime_changed`, `session_stats_changed`, and
`pi_event(agent_end)` to know when to recompute a project's rollup. The page consumes the
debounced `rollup_changed` and **ignores** `message_update` / `tool_execution_update` from the
`/ws` firehose so a chatty session does not repaint the grid.

### 4.4 New plumbing the mockup assumes

- **Structured elicitation.** Block + quick-reply chips require a structured ask — an
  `extension_ui_request` or a proposed `ask_user` tool whose payload is
  `{ sessionId, question, options[] }`. A non-elicited free-text stop cannot be proven a
  blocker (see §5.3).
- **Merge route.** No push/PR/merge exists. "Ask pi to merge feat/x → main" sends a prompt via
  `/api/prompt`; a true local merge needs a net-new git-merge endpoint. The UI never labels one
  button "Sign off & merge".
- **Loop iteration log.** A per-iteration `CustomEntry('pi-web:loop-iter', {n, startedAt,
  toolEnds, cost})` makes the iteration count + sparkbar durable across the 60s dispose.

---

## 5. Progress derivation

Every percent must trace to a checkbox, a git fact, or an exit code. No percent is authored.

### 5.1 Sources, ranked by feasibility

- **A — Manual DoD checklist** (`kind:"manual"`). `percent = metWeight / totalWeight` over
  checked criteria. Easy and honest; truth stored in the registry like `sessionMarkers`. Needs
  human upkeep.
- **B — Git-derived** (`git_clean` / `git_ahead_zero` / `git_merged`). Computable now:
  `gitStatus()` gives dirtyCount/ahead/behind; `gitLog()` + `git merge-base --is-ancestor` gives
  merged-into-main. Good "shipped" proxy. Local-only; `ahead 0` only means shipped if upstream
  tracks main; multi-repo projects evaluate per root; git `conflicted` → blocked.
- **C — Command/test** (`kind:"command"`). Run a user cmd via `executeBash`, met iff
  `exit === expectExit` (default 0). Slow, side-effecting, security-sensitive. **On-demand only**
  (`/api/dod/evaluate`), cached with `evaluatedAt`, never on rollup render.
- **D — Session-activity heuristic** (`session_idle` + `runtimeForPath`). Cheap but weak — it
  measures liveness, not completion. Use to derive **status**, never percent.

**Recommendation:** a weighted, source-typed DoD. Default a session/workstream DoD to
`[user manual criteria] + [one git_clean + one git_merged(into:'main') per root]`. Compute on
read in `/api/rollups` (git inline, command excluded — see below). Workstream progress =
weighted aggregate of its sessions' criteria; project progress = aggregate of workstreams +
project-level DoD.

### 5.2 The exact computation (matches `computeProgress` in `index.html`)

```
evaluable = criteria where !gate                 // sign-off gates are excluded from %
run       = evaluable where !unrun               // never-run command criteria excluded from denominator
percent   = sum(weight of met run) / sum(weight of run) * 100
allMet    = run.length > 0 && all run met && unrun === 0 && stale === 0
```

Consequences the ring honors:

- A **never-run** command criterion is drawn as a faint "not yet checked" segment and the number
  shows `k/n*` (asterisked), never a confident percent.
- A **stale** command result (ran, but old) likewise asterisks the number and cannot back a 100%.
- `allMet` is what promotes a card to "awaiting sign-off". Because it requires every evaluable
  criterion to be run and fresh, **a card never promotes to sign-off on hours-stale evidence**;
  it shows "done — pending recheck" with a Re-check on the card face instead.
- A neutral pulsing "evaluating" ring (no number, no hue) covers the two-phase load gap and
  on-demand rechecks.

### 5.3 Status derivation (`WorkItemStatus`)

```
runtime.isRunning                                          -> in_progress (run / loop)
git 'conflicted' OR tool_execution_end(error)/abnormal agent_end -> blocked / failed
evaluable 100% + pending manual gate                       -> done, awaiting sign-off
evaluable 100% (auto sources, no gate)                     -> done, merged
else                                                       -> planned / queued / unset
```

**Block detection is honest.** "Blocked · needs input" + quick-reply chips require a structured
elicitation (`extension_ui_request` or the proposed `ask_user` payload) or a real permission
prompt. A non-elicited free-text stop degrades to a quiet "Idle · may be waiting (N min since
agent_end, unread)" — never a fabricated amber alarm.

**Fail and blast.** `fail` derives from `tool_execution_end(error)` / abnormal `agent_end` /
git `conflicted` — never from a dashboard-initiated command-DoD eval (which is on-demand and may
be stale; a red command criterion shows its `evaluatedAt` separately). `blast` has no dependency
graph to draw on, so it is a manual override OR a destructive-keyword regex over the last
assistant message OR a dirtyCount bucket. It only orders Needs-you triage and gates nothing.

### 5.4 Loops (durable, not inferred)

`isLoop`, `budget`, and `loopStartedAt` are **stored** registry fields. Elapsed is computed from
`loopStartedAt`, **not** `runtimeForPath` (which resets on the 60s idle dispose). Cost comes from
`SessionStats`. The iteration count + sparkbar are rebuilt from durable
`CustomEntry('pi-web:loop-iter', …)` + `tool_result` entries in the JSONL — so a 38-minute loop
reconstructs its count after a dispose and can actually trip over-budget. A loop iteration is one
`agent_start → agent_end` cycle with no intervening user message; the sparkbar is
`tool_execution_end` events per iteration span, returned on the rollup (not the `/ws` firehose),
so a flat/declining tail signals a stall. The loop badge flips amber **only** when stalled or
over budget — a growing planned queue is expected and never alarming. Pause = `AgentSession.abort()`
+ the registry `paused` flag the orchestrator honors.

### 5.5 Mixed sources

When a workstream's sessions span more than one evaluator family (git / command / manual /
sign-off / agent / orchestrator), do **not** blend heterogeneous criteria into one percent. The
workstream ring becomes a "k of n SESSIONS done" gauge (one segment per session) with a "mixed
sources" note. Criteria-blended percent is reserved for the homogeneous-source case. Production
keys mixed-source detection off the structured `DoDSource.kind` on each criterion — the mockup's
`srcFamily()` / `sessFamily()` substring match is fixture-only.

### 5.6 Delta ("since last visit")

Diff `modified` / `mergedAt` + criterion `evaluatedAt` against a stored `lastDashboardVisitAt`
(in the UI sidecar). Net +/- = numstat over commits since the visit. Recent merges count
fleet-wide (including dormant projects) so calm-collapse never zeroes throughput. If
`lastDashboardVisitAt` is unavailable, the line reads "Recent activity" — never a fabricated
interval.

---

## 6. Where the DoD lives and how it is evaluated

### 6.1 Two tiers, both pi-web-owned

1. **Project- and workstream-level DoD** — stored in a new sidecar JSON,
   `~/.pi/agent/pi-web-projects.json`, written through a store built exactly like
   `createSessionUiStateStore` (atomic tmp+rename, in-memory cache, normalize/patch). Shape =
   `ProjectRegistry`. This is the mutable truth for `kind:"manual"` criteria (toggled met/unmet)
   and for the criteria definitions. Rationale: DoD is product/management metadata, not
   conversation content, and must survive even when a session is disposed or deleted — the
   `SessionUiState` precedent proves the pattern is accepted.

2. **Per-session DoD (optional)** — when a checklist should travel with a session, persist it as
   a pi `CustomEntry` via `sessionManager.appendCustomEntry("pi-web:dod", { criteria })` and read
   it back by scanning `getEntries()` for `type === "custom" && customType === "pi-web:dod"`. Use
   `CustomEntry` (not `CustomMessageEntry`) so it never pollutes LLM context. Trade-off: only
   readable when the session can be listed/opened, and editing needs a live `AgentSession`. Treat
   the sidecar as source of truth and the `CustomEntry` as an optional embedded copy.

### 6.2 Evaluation per source

| `DoDSource.kind` | Evaluator | When |
| --- | --- | --- |
| `manual` | stored boolean in `ProjectRegistry`, toggled via `PATCH /api/dod/criterion/:id` | on read (it is truth) |
| `git_clean` / `git_ahead_zero` | `gitStatus()` (dirtyCount / ahead) | inline in `/api/rollups` (cheap) |
| `git_merged` | `gitLog()` + `git merge-base --is-ancestor` | inline in `/api/rollups` (cheap) |
| `command` | `executeBash`, met iff `exit === expectExit` | **on-demand only** (`/api/dod/evaluate`) + `evaluatedAt` + stale flag |
| `session_idle` | `runtimeForPath()` + `agent_end(pending 0)` | on read |

Evaluation produces `CriterionEval { met, evidence, evaluatedAt, unrun?, stale? }` and never
overwrites the stored DoD. The stored DoD is the definition + the manual booleans; git / command
/ session evals are recomputed each read.

### 6.3 Provenance is separate from evaluator

`authoredBy ∈ user | agent | orchestrator | rule` is the at-rest pill ("who decides done"). It
is independent of the evaluator that computes met-ness. An agent-asserted boolean resolves to the
`manual` evaluator. No pill is a phantom source — every criterion resolves to one of the four
real evaluators above.

### 6.4 Sign-off and merge are separate

A manual user-approval criterion is a **gate** excluded from percent. When evaluable criteria
reach 100%, status flips to purple "awaiting sign-off". Row-level "Sign off" = `PATCH
/api/dod/criterion/:id` flipping that one gate (fully supported today): optimistic flip + undo
toast, no drawer. **Merge is a separate step.** There is no push/PR/merge route in the local-only
git layer, so it is either a net-new git-merge endpoint (net-new work) or an agent prompt ("merge
feat/x into main") — gated to render only when a real branch exists; a no-git/doc DoD shows
"Archive" instead.

---

## 7. Feasibility summary

**Easy (use what exists).** Listing/aggregating sessions (`/api/sessions` + `listSessionInfos()`
+ `runtimeForPath()`); the registry sidecar store (copy `sessionUiState.ts`); realtime (reuse
`/ws` + `broadcast()` + seq replay, add two envelopes); per-session liveness/unread; manual DoD
progress (pure arithmetic over stored booleans).

**Medium (real work, grounded).** Mapping sessions to projects/workstreams (longest cwd-prefix +
explicit `sessionIds`; forks via `parentSessionPath` need care); git-derived DoD (`merge-base
--is-ancestor` is net-new; multi-root multiplies git calls — cache per repo root, evaluate
lazily); evaluating DoD across many projects in `/api/rollups` (fan-out cost — mitigate with the
existing dispose/idle + a short TTL cache).

**Hard / called out honestly.**

- "Real" done = merged PR + green CI is **not available** (git is local-only). `git_merged` /
  `ahead` are proxies; a true signal needs a new GitHub/CI integration.
- `command`/test DoD is doable via `executeBash` but slow, side-effecting, security-sensitive —
  on-demand + sandboxed/time-bounded only; results go stale.
- "Blocked" detection is heuristic (git `conflicted`, failing command, idle+unread after
  `agent_end`) with false positives/negatives — mitigated by requiring structured elicitation for
  the loud amber state.
- Plan-items-done progress requires a plan-tool extension writing `CustomEntry` items; prose
  parsing is fragile and surfaced with a "~N more planned" hedge, never an exact count.
- Per-project realtime scoping: `/ws` is global; client-side filtering by membership is the cheap
  stopgap, server-side scoping is a larger change.
