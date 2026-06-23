// Project Rollups — frontend mirror of the view models that cross the wire.
//
// These are a standalone mirror of `server/rollups/types.ts` (the client trusts
// the server-computed ProgressSnapshot and never re-derives it on render). The
// mirror imports only `SessionInfo` from the app types so the per-session
// `runtime` shape stays a single source of truth; it deliberately does NOT
// value-import from `server/rollups/*` (sidestepping the Vite/tsconfig
// cross-boundary risk). Contract parity is locked by the rollup tests.

import type { SessionInfo } from "../app/types.js";

export type WorkItemStatus =
  | "planned"
  | "in_progress"
  | "blocked"
  | "done"
  | "abandoned";

export type DoDSource =
  | { kind: "manual" }
  | { kind: "git_clean"; repo?: string }
  | { kind: "git_merged"; repo?: string; into: string }
  | { kind: "git_ahead_zero"; repo?: string }
  | { kind: "command"; cwd: string; cmd: string; expectExit?: number }
  | { kind: "session_idle"; sessionId: string };

export type DoDSourceKind = DoDSource["kind"];

export type Provenance = "user" | "agent" | "orchestrator" | "rule";

export interface DoDCriterion {
  id: string;
  text: string;
  source: DoDSource;
  authoredBy?: Provenance;
  gate?: boolean;
  weight?: number;
  met?: boolean;
}

export interface DoD {
  criteria: DoDCriterion[];
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  roots: string[];
  workstreamIds: string[];
  dod?: DoD;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}

export interface Workstream {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  status: WorkItemStatus;
  sessionIds: string[];
  matchCwd?: string;
  dod?: DoD;
  order: number;
  createdAt: string;
  updatedAt: string;
  isLoop?: boolean;
  loopStartedAt?: string;
  budget?: { maxMinutes?: number; maxCostUsd?: number };
  paused?: boolean;
}

export interface ProjectRegistry {
  version: 1;
  projects: Project[];
  workstreams: Workstream[];
}

export interface CriterionEval {
  id: string;
  met: boolean;
  evidence?: string;
  evaluatedAt: string;
  unrun?: boolean;
  stale?: boolean;
  sourceKind?: DoDSourceKind;
  gate?: boolean;
  weight?: number;
  text?: string;
}

export interface ProgressSnapshot {
  met: number;
  total: number;
  metWeight: number;
  totalWeight: number;
  percent: number;
  allMet: boolean;
  unrun: number;
  stale: number;
  derivedStatus: WorkItemStatus;
  criteria: CriterionEval[];
}

export interface SessionGitInfo {
  branch: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  blocked: boolean;
}

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

export interface ArtifactReceipt {
  kind: "diff" | "doc";
  branch?: string;
  sha?: string;
  merged?: boolean;
  add?: number;
  del?: number;
  note?: string;
  files?: number;
  check?: { cmd: string; exit: number; at: string };
}

export interface SessionRollup {
  id: string;
  name?: string;
  cwd?: string;
  modified: string;
  messageCount: number;
  runtime: SessionInfo["runtime"]; // reuse the existing app runtime shape
  unread?: boolean;

  status: WorkItemStatus;
  uiStatus: UiStatus;
  progress?: ProgressSnapshot;
  git?: SessionGitInfo;

  live?: string;
  elicitation?: { question: string; options: string[] };
  blast?: "hi" | "md" | "lo";
  failAction?: string;
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
  progress: ProgressSnapshot | null;
  mixed?: boolean;
  sessionGauge?: { done: number; total: number; percent: number };
  counts: StatusCounts;
  loop?: SessionRollup["loop"];
}

export interface ProjectRollup {
  project: Project;
  workstreams: WorkstreamRollup[];
  progress: ProgressSnapshot;
  counts: StatusCounts;
  activeSessionCount: number;
  lineage?: { parentProjectName: string; fullPath: string };
}
