// Project Rollups — shared stored entities + computed view models.
//
// These types are pi-web-owned (pi has no concept of a project, workstream,
// progress, or definition of done). The stored entities live in a sidecar file
// (`pi-web-projects.json`, the `createSessionUiStateStore` precedent); the view
// models are computed on read by `/api/rollups` and never persisted as truth.
//
// This module is pure types only — it imports nothing from `server.ts`, so the
// rollup compute that consumes it stays unit-testable in-process.

// ---- Stored entities (sidecar; pi-web-owned, NOT in pi) ----

export type WorkItemStatus =
  | "planned"
  | "in_progress"
  | "blocked"
  | "done"
  | "abandoned";

// HOW a criterion is evaluated (the evaluator), source-typed so progress is computable.
export type DoDSource =
  | { kind: "manual" } // user toggles a stored boolean
  | { kind: "git_clean"; repo?: string } // dirtyCount === 0
  | { kind: "git_merged"; repo?: string; into: string } // branch merged into <into>
  | { kind: "git_ahead_zero"; repo?: string } // ahead === 0 vs upstream
  | { kind: "command"; cwd: string; cmd: string; expectExit?: number } // test/build
  | { kind: "session_idle"; sessionId: string }; // agent reached agent_end, no pending

export type DoDSourceKind = DoDSource["kind"];

// WHO defined a criterion (the at-rest pill); independent of the evaluator.
export type Provenance = "user" | "agent" | "orchestrator" | "rule";

export interface DoDCriterion {
  id: string;
  text: string; // human-readable acceptance criterion
  source: DoDSource; // HOW it is evaluated (evaluator)
  authoredBy?: Provenance; // WHO defined it; separate from evaluator
  gate?: boolean; // a manual sign-off gate: EXCLUDED from percent (see progress)
  weight?: number; // default 1
  // The ONLY mutable boolean truth, kept solely when source.kind === "manual".
  met?: boolean;
}

export interface DoD {
  criteria: DoDCriterion[];
}

// A project groups one or more repos/cwds + workstreams.
export interface Project {
  id: string; // pi-web generated (uuid)
  name: string;
  description?: string;
  roots: string[]; // absolute cwd paths; sessions matched by cwd prefix
  workstreamIds: string[]; // ordered
  dod?: DoD; // project-level acceptance criteria
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
  status: WorkItemStatus; // user-set or derived
  sessionIds: string[]; // pi SessionInfo.id values (explicit membership)
  matchCwd?: string; // optional cwd prefix to auto-include sessions
  dod?: DoD;
  order: number;
  createdAt: string;
  updatedAt: string;

  // ---- loop telemetry: net-new, STORED, never inferred ----
  isLoop?: boolean;
  loopStartedAt?: string; // ISO; elapsed is computed from THIS, not runtimeForPath
  budget?: { maxMinutes?: number; maxCostUsd?: number };
  paused?: boolean; // registry flag the orchestrator honours
}

// ---- Persisted sidecar shape (parallels SessionUiState) ----
export interface ProjectRegistry {
  version: 1;
  projects: Project[];
  workstreams: Workstream[];
  // manual criterion truth lives here too: the only mutable boolean for kind:"manual"
}

// ---- Computed snapshot (never stored as truth) ----

export interface CriterionEval {
  id: string;
  met: boolean;
  evidence?: string; // "branch merged at <sha>", "exit 0", "you checked"
  evaluatedAt: string; // ISO; drives stale/unrun handling
  unrun?: boolean; // command criterion that has never run -> excluded from %
  stale?: boolean; // ran, but the cached result is old -> can't back a 100%
  // carry the source kind so the renderer keys families/asterisks off structure, not substrings
  sourceKind?: DoDSourceKind;
  gate?: boolean;
  weight?: number;
  text?: string;
}

export interface ProgressSnapshot {
  met: number;
  total: number; // k of n RUN, fresh, non-gate criteria
  metWeight: number;
  totalWeight: number;
  percent: number; // metWeight/totalWeight*100 over RUN non-gate criteria
  allMet: boolean; // every evaluable criterion RUN, FRESH, met -> may promote to sign
  unrun: number;
  stale: number;
  derivedStatus: WorkItemStatus;
  criteria: CriterionEval[];
}

// ---- Runtime + git facts that ride on a SessionRollup ----

// Mirrors the simplifyModel() shape attached by runtimeForPath().
export interface ModelSummary {
  provider?: string;
  id?: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

// The canonical per-session live status object (runtimeForPath in server.ts).
export interface SessionRuntime {
  loaded: boolean;
  isRunning: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  startedAt?: string;
  lastActivityAt?: string;
  pendingMessageCount: number;
  model?: ModelSummary;
}

export interface SessionGitInfo {
  branch: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  blocked: boolean; // git "conflicted" present
}

// ---- The 9 render-states the ported badge/STATUS_RANK logic consumes ----
// (carried ALONGSIDE the 5-value WorkItemStatus so the port has its input
// without a lossy collapse.)
export type UiStatus =
  | "run"
  | "loop"
  | "sign"
  | "merge"
  | "block"
  | "fail"
  | "queued"
  | "planned"
  | "unset";

// ---- Rollup view models returned by /api/rollups (the dashboard feed) ----

export interface ArtifactReceipt {
  kind: "diff" | "doc";
  branch?: string;
  sha?: string;
  merged?: boolean;
  add?: number; // git numstat
  del?: number;
  note?: string;
  files?: number; // doc: derived from write/edit tool_result entries
  check?: { cmd: string; exit: number; at: string };
}

export interface SessionRollup {
  id: string;
  name?: string;
  cwd?: string;
  modified: string;
  messageCount: number;
  runtime: SessionRuntime; // reuse the existing runtime shape
  unread?: boolean;

  status: WorkItemStatus; // 5-value canonical, derived from runtime + DoD + git
  uiStatus: UiStatus; // 9 render-states for the ported STATUS_RANK/badge logic
  progress?: ProgressSnapshot; // present if a DoD targets this session
  git?: SessionGitInfo;

  // fields the UI renders that must ride on the view model
  live?: string; // representative one-liner (last assistant summary)
  elicitation?: { question: string; options: string[] }; // structured ask -> chips
  blast?: "hi" | "md" | "lo"; // triage ordering only; gates nothing
  failAction?: string; // "Re-authenticate", "Re-run tests"
  loop?: {
    iter: number;
    sparks: number[];
    startedAt: string;
    budget?: { maxMinutes?: number; maxCostUsd?: number };
  };
  plannedQueue?: { items: string[]; total: number; source: "notes" | "plan_tool" };
  dod?: {
    text: string;
    sourceLabel: string;
    authoredBy: Provenance;
    criteria: CriterionEval[];
  };
  artifact?: ArtifactReceipt;
}

export type StatusCounts = Record<WorkItemStatus, number>;

export interface WorkstreamRollup {
  workstream: Workstream;
  sessions: SessionRollup[];
  progress: ProgressSnapshot | null; // null when mixed-source
  mixed?: boolean; // sessions span >1 evaluator family
  sessionGauge?: { done: number; total: number; percent: number }; // used when mixed
  counts: StatusCounts;
  loop?: SessionRollup["loop"];
}

export interface ProjectRollup {
  project: Project;
  workstreams: WorkstreamRollup[];
  progress: ProgressSnapshot;
  counts: StatusCounts;
  activeSessionCount: number; // runtime.isRunning across the project
  lineage?: { parentProjectName: string; fullPath: string }; // nested-root badge
}
