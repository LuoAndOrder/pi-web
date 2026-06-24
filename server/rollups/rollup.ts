// Project Rollups — the join: registry × live sessions → ProjectRollup[].
//
// This is the heart of `GET /api/rollups`. It is pure and dependency-injected
// (git loading + merge-base are passed in via AssembleContext), so it unit-tests
// in-process with stub git. Hard rules honored here:
//   - `command` DoD is NEVER spawned on this path (excluded as `unrun` unless a
//     cached eval was supplied — S10's /api/dod/evaluate fills that cache).
//   - each distinct repo root is loaded once (the caller's cachedGitStatus TTL
//     cache collapses duplicate gitStatus calls — co-located sessions share one).
//   - never throw on a messy session — every optional field is defaulted.
//
// Session→project mapping (tech-lead decision): explicit `workstream.sessionIds`
// wins, then longest `workstream.matchCwd` cwd-prefix, then longest project
// `roots` cwd-prefix; unmatched sessions go to an `unassigned` bucket that is NOT
// emitted as a project (cold-start / first-run handles emptiness in S9).

import { resolve } from "node:path";

import {
  computeProgress,
  GIT_KINDS,
  pendingGate,
} from "./progress.js";
import { deriveUiStatus, toWorkItemStatus } from "./status.js";
import {
  evalBase,
  evalGitCriterion,
  sessionGitInfo,
  type GitStatusLite,
} from "./gitDod.js";
import type {
  ArchivedProjectSummary,
  CriterionEval,
  DoD,
  DoDCriterion,
  DoDSourceKind,
  ProgressSnapshot,
  Project,
  ProjectRegistry,
  ProjectRollup,
  Provenance,
  SessionRollup,
  SessionRuntime,
  StatusCounts,
  Workstream,
  WorkstreamRollup,
  WorkItemStatus,
} from "./types.js";

// ---- Inputs ------------------------------------------------------------------

/** The simplified live-session shape `/api/rollups` feeds in (from
 *  `applySessionUnreadState(listSessionInfos(), …)`). Every field optional so a
 *  messy real session never throws. */
export interface RollupSessionInput {
  id?: string;
  name?: string;
  cwd?: string;
  modified?: string;
  messageCount?: number;
  runtime?: Partial<SessionRuntime> | null;
  unread?: boolean;
  /** Representative one-liner — the last assistant summary from the live session. */
  live?: string;
  /** An abnormal terminal (assistant error / tool error after the agent stopped),
   *  surfaced by the server's liveSessionSignals. The ONLY non-git source of a hard
   *  `fail` need; never synthesized from a clean idle stop. */
  fail?: boolean;
}

export interface AssembleContext {
  /** Load (cached) gitStatus for a repo root. Undefined when off-repo / errored. */
  gitStatusFor: (cwd: string) => Promise<GitStatusLite | undefined>;
  /** merge-base --is-ancestor bound to a repo root (for git_merged). */
  isAncestor: (ancestor: string, into: string, cwd: string) => Promise<boolean>;
  /** On-demand command-DoD evals keyed by criterion id (S10). Absent → unrun. */
  commandEvals?: Map<string, CriterionEval>;
  /** Injectable clock for deterministic evidence timestamps. */
  now?: () => Date;
}

// ---- Defaults / small helpers ------------------------------------------------

const STATUS_KEYS: WorkItemStatus[] = [
  "planned",
  "in_progress",
  "blocked",
  "done",
  "abandoned",
];

function zeroCounts(): StatusCounts {
  return { planned: 0, in_progress: 0, blocked: 0, done: 0, abandoned: 0 };
}

function defaultRuntime(runtime?: Partial<SessionRuntime> | null): SessionRuntime {
  return {
    loaded: Boolean(runtime?.loaded),
    isRunning: Boolean(runtime?.isRunning),
    isStreaming: Boolean(runtime?.isStreaming),
    isCompacting: Boolean(runtime?.isCompacting),
    startedAt: runtime?.startedAt,
    lastActivityAt: runtime?.lastActivityAt,
    pendingMessageCount: Number(runtime?.pendingMessageCount || 0),
    model: runtime?.model,
  };
}

/** Longest-prefix cwd containment: is `child` at or under `parent`? */
export function isCwdUnder(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

type CritFamily = "git" | "cmd" | "user" | "other";

function critFamily(kind: DoDSourceKind | undefined): CritFamily {
  if (!kind) return "other";
  if (GIT_KINDS.has(kind)) return "git";
  if (kind === "command") return "cmd";
  if (kind === "manual" || kind === "session_idle") return "user";
  return "other";
}

/** Whether ONE session's (non-gate) criteria span >1 evaluator family, keyed off
 *  the STRUCTURED source kind (not the mockup's substring matcher). This is the
 *  per-session heterogeneity test that backs `sessFamily`. */
export function isMixed(evals: CriterionEval[]): boolean {
  const fams = new Set(evals.filter((e) => !e.gate).map((e) => critFamily(e.sourceKind)));
  return fams.size > 1;
}

/** Collapse ONE session's (non-gate) criteria to a SINGLE family label
 *  (DATA-MODEL §5.5 / mockup `sessFamily`): the session's family, "mixed" if it is
 *  internally heterogeneous, or undefined when it has no scorable criteria so it
 *  doesn't widen the workstream's family set. The workstream-level mixed decision
 *  (buildWorkstreamRollup) is the size of the SET of these per-session labels —
 *  NOT the family span of the flattened criteria aggregate, so a workstream of
 *  same-DoD sessions (even the §5.2 default `manual + git` DoD) blends into a
 *  k-of-n ring instead of degrading to a 0/1 session gauge. */
function sessFamily(evals: CriterionEval[]): CritFamily | "mixed" | undefined {
  const scorable = evals.filter((e) => !e.gate);
  if (!scorable.length) return undefined;
  if (isMixed(scorable)) return "mixed";
  return critFamily(scorable[0].sourceKind);
}

function countStatuses(sessions: SessionRollup[]): StatusCounts {
  const counts = zeroCounts();
  for (const s of sessions) counts[s.status] += 1;
  return counts;
}

function sumCounts(parts: StatusCounts[]): StatusCounts {
  const total = zeroCounts();
  for (const part of parts) {
    for (const key of STATUS_KEYS) total[key] += part[key];
  }
  return total;
}

/** A session has reached its DoD (used by the mixed-source k-of-n gauge, §5.5). */
function sessionDone(s: SessionRollup): boolean {
  return (
    s.uiStatus === "merge" ||
    s.uiStatus === "sign" ||
    Boolean(s.progress && s.progress.allMet)
  );
}

const SOURCE_LABELS: Record<DoDSourceKind, string> = {
  manual: "manual sign-off",
  git_clean: "git: working tree clean",
  git_ahead_zero: "git: in sync with upstream",
  git_merged: "git: merged into branch",
  command: "command / test exit code",
  session_idle: "session idle (agent_end)",
};

// ---- Criterion evaluation ----------------------------------------------------

/** Resolve the repo root a criterion is evaluated against: an explicit
 *  `source.repo` wins, else the evaluation cwd (session cwd or workstream root). */
function repoRootFor(criterion: DoDCriterion, fallbackCwd: string | undefined): string | undefined {
  const source = criterion.source as { repo?: string };
  if (typeof source.repo === "string" && source.repo.trim()) return resolve(source.repo.trim());
  return fallbackCwd ? resolve(fallbackCwd) : undefined;
}

/** Evaluate one DoD criterion → CriterionEval, NEVER spawning a command (§6.2). */
async function evalCriterion(
  criterion: DoDCriterion,
  cwd: string | undefined,
  ctx: AssembleContext,
  session: RollupSessionInput | undefined,
): Promise<CriterionEval> {
  const at = (ctx.now?.() ?? new Date()).toISOString();
  const source = criterion.source;

  switch (source.kind) {
    case "manual":
      return evalBase(
        criterion,
        criterion.met === true,
        criterion.met === true ? "you checked it" : "not checked",
        at,
      );

    case "git_clean":
    case "git_ahead_zero":
    case "git_merged": {
      const root = repoRootFor(criterion, cwd);
      const status = root ? await ctx.gitStatusFor(root) : undefined;
      return evalGitCriterion(
        criterion,
        status,
        (ancestor, into) => ctx.isAncestor(ancestor, into, root || ""),
        new Date(at),
      );
    }

    case "command": {
      // NEVER spawned on the render path — a cached on-demand eval (S10) or unrun.
      const cached = ctx.commandEvals?.get(criterion.id);
      if (cached) return { ...cached, gate: criterion.gate === true ? true : cached.gate };
      return evalBase(criterion, false, "command DoD not yet run", at, { unrun: true });
    }

    case "session_idle": {
      const target = session && session.id === source.sessionId ? session : undefined;
      const idle =
        Boolean(target) &&
        !target!.runtime?.isRunning &&
        Number(target!.runtime?.pendingMessageCount || 0) === 0;
      return evalBase(
        criterion,
        idle,
        idle ? "agent idle (no pending work)" : "agent still active / pending",
        at,
      );
    }

    default:
      return evalBase(criterion, false, "unknown criterion source", at);
  }
}

async function evalDoD(
  dod: DoD | undefined,
  cwd: string | undefined,
  ctx: AssembleContext,
  session: RollupSessionInput | undefined,
): Promise<CriterionEval[]> {
  if (!dod || !dod.criteria.length) return [];
  return Promise.all(dod.criteria.map((c) => evalCriterion(c, cwd, ctx, session)));
}

function dodSummary(dod: DoD, evals: CriterionEval[]): SessionRollup["dod"] {
  const first = dod.criteria[0];
  const authoredBy: Provenance = first?.authoredBy || "user";
  const sourceKind = first?.source.kind;
  return {
    text: first?.text || "",
    sourceLabel: sourceKind ? SOURCE_LABELS[sourceKind] : "",
    authoredBy,
    criteria: evals,
  };
}

// ---- Session → project/workstream mapping ------------------------------------

export interface SessionAssignment {
  projectId: string;
  workstreamId?: string;
}

export interface SessionMapping {
  /** sessionId → where it lands. */
  assignments: Map<string, SessionAssignment>;
  /** Sessions that matched no project (omitted from the rollup feed). */
  unassigned: RollupSessionInput[];
}

export function mapSessionsToProjects(
  registry: ProjectRegistry,
  sessions: RollupSessionInput[],
): SessionMapping {
  const assignments = new Map<string, SessionAssignment>();
  const unassigned: RollupSessionInput[] = [];

  // Steps 1/2 must mirror step 3's archived guard (L311-322): a workstream whose
  // PROJECT is archived is skipped by the assembly loop (L559-560), so claiming a
  // session for it here would silently drop that session instead of letting it fall
  // through to the next-best active match (or to unassigned).
  const archivedProjectIds = new Set(
    registry.projects.filter((p) => p.archived).map((p) => p.id),
  );

  const wsByExplicit = new Map<string, Workstream>();
  for (const ws of registry.workstreams) {
    if (archivedProjectIds.has(ws.projectId)) continue;
    for (const id of ws.sessionIds) if (!wsByExplicit.has(id)) wsByExplicit.set(id, ws);
  }
  const wsWithMatch = registry.workstreams.filter(
    (ws) => ws.matchCwd && !archivedProjectIds.has(ws.projectId),
  );

  for (const session of sessions) {
    const id = typeof session.id === "string" ? session.id : "";
    if (!id) {
      unassigned.push(session);
      continue;
    }

    // 1. Explicit membership wins.
    const explicit = wsByExplicit.get(id);
    if (explicit) {
      assignments.set(id, { projectId: explicit.projectId, workstreamId: explicit.id });
      continue;
    }

    const cwd = typeof session.cwd === "string" ? session.cwd : "";

    // 2. Longest matchCwd prefix → that workstream.
    if (cwd) {
      let best: Workstream | undefined;
      let bestLen = -1;
      for (const ws of wsWithMatch) {
        if (isCwdUnder(cwd, ws.matchCwd!) && ws.matchCwd!.length > bestLen) {
          best = ws;
          bestLen = ws.matchCwd!.length;
        }
      }
      if (best) {
        assignments.set(id, { projectId: best.projectId, workstreamId: best.id });
        continue;
      }
    }

    // 3. Longest project root prefix → that project (no workstream).
    if (cwd) {
      let bestProject: Project | undefined;
      let bestLen = -1;
      for (const project of registry.projects) {
        if (project.archived) continue;
        for (const root of project.roots) {
          if (isCwdUnder(cwd, root) && root.length > bestLen) {
            bestProject = project;
            bestLen = root.length;
          }
        }
      }
      if (bestProject) {
        assignments.set(id, { projectId: bestProject.id });
        continue;
      }
    }

    unassigned.push(session);
  }

  return { assignments, unassigned };
}

// ---- Builders ----------------------------------------------------------------

export async function buildSessionRollup(
  session: RollupSessionInput,
  inheritedDoD: DoD | undefined,
  ctx: AssembleContext,
): Promise<SessionRollup> {
  const cwd = typeof session.cwd === "string" && session.cwd ? session.cwd : undefined;
  const runtime = defaultRuntime(session.runtime);
  const status = cwd ? await ctx.gitStatusFor(resolve(cwd)) : undefined;
  const git = sessionGitInfo(status);

  const evals = await evalDoD(inheritedDoD, cwd, ctx, session);
  // git_clean is repo-root-scoped — it's surfaced once at repo scope, never folded
  // into the per-session %. computeProgress already excludes rootScoped crits, but
  // we keep the full eval list on `dod.criteria` for the render.
  const progress = computeProgress(evals);
  const gate = pendingGate(evals);

  // ── Honest-degradation seam (which signals are wired vs. intentionally unset) ──
  // WIRED from the live session (server/liveSessionSignals → RollupSessionInput):
  //   - `live`     : last assistant summary (the representative one-liner).
  //   - `fail`     : abnormal terminal (assistant/tool error after the agent stopped).
  //   - git block  : `git.blocked` (conflicted working tree) flows from sessionGitInfo.
  // INTENTIONALLY UNPOPULATED pending pi plumbing pi does NOT expose today
  // (DATA-MODEL §4.4 / §6) — a future reader must NOT assume these are derivable:
  //   - `elicitation` : pi emits no STRUCTURED ask (`ask_user`); a free-text stop is
  //                     NOT a structured elicitation, so this stays false and the stop
  //                     degrades to the quiet "may be waiting" soft wait, never amber.
  //   - `softWait`    : would need a durable "stopped, awaiting human" marker pi does
  //                     not write; left false so we never fabricate a "waiting" alarm.
  //   - `blast` / `plannedQueue` : need durable receipts/notes pi does not emit; the
  //                     renderer degrades gracefully when absent.
  //   - `artifact` : a DURABLE diff receipt (numstat/sha) is deferred (DATA-MODEL §6) —
  //                     gitArtifact below populates only the git facts already on the
  //                     render path (branch + a met git_merged), so the merge affordance
  //                     and merged receipt light up WITHOUT fabricating numstat/sha.
  const fail = session.fail === true;
  const uiStatus = deriveUiStatus({
    runtime,
    git,
    progress,
    pendingGate: Boolean(gate),
    elicitation: false,
    fail,
    hasDoD: evals.length > 0,
    softWait: false,
  });

  const rollup: SessionRollup = {
    id: typeof session.id === "string" ? session.id : "",
    modified: typeof session.modified === "string" ? session.modified : "",
    messageCount: Number(session.messageCount || 0),
    runtime,
    status: toWorkItemStatus(uiStatus),
    uiStatus,
  };
  if (typeof session.name === "string") rollup.name = session.name;
  if (cwd) rollup.cwd = cwd;
  if (session.unread === true) rollup.unread = true;
  if (typeof session.live === "string" && session.live) rollup.live = session.live;
  if (git) rollup.git = git;
  if (progress) rollup.progress = progress;
  if (inheritedDoD && inheritedDoD.criteria.length) rollup.dod = dodSummary(inheritedDoD, evals);
  const artifact = gitArtifact(git, evals);
  if (artifact) rollup.artifact = artifact;
  return rollup;
}

/** A minimal ArtifactReceipt derived ONLY from git facts already loaded on the render
 *  path (sessionGitInfo + the evaluated criteria) — no durable receipt source exists yet
 *  (DATA-MODEL §6 deferred). It lights up the merge affordance (`hasGitBranch`/`branchOf`)
 *  and the Done-section merged receipt with REAL signal:
 *    - `branch` : the session's checked-out branch (the merge button's target).
 *    - `merged` : true iff a `git_merged` criterion evaluated met for this session.
 *    - `ahead`  : commits ahead of upstream (an honest pushed/unpushed hint).
 *  numstat (`add`/`del`) and `sha` are intentionally LEFT UNSET — gitStatus exposes
 *  neither, and fabricating them would violate the no-fabricated-signal rule; the
 *  renderer's artChip omits the diff when they're absent. Returns null off-repo or on a
 *  detached/branchless HEAD so no empty chip renders. */
function gitArtifact(
  git: SessionRollup["git"] | undefined,
  evals: CriterionEval[],
): SessionRollup["artifact"] | undefined {
  if (!git || !git.branch) return undefined;
  const merged = evals.some((e) => e.sourceKind === "git_merged" && e.met);
  const artifact: NonNullable<SessionRollup["artifact"]> = { kind: "diff", branch: git.branch };
  if (merged) artifact.merged = true;
  // numstat (`add`/`del`) and `sha` stay UNSET — gitStatus exposes neither; the renderer's
  // artChip omits the diff segment when they're absent so nothing fabricated renders.
  return artifact;
}

/** Aggregate the criteria a workstream ring is scored against: the concatenation
 *  of its sessions' already-evaluated criteria (DATA-MODEL §5.1 "Workstream
 *  progress = weighted aggregate of its sessions' criteria"; mockup enrich L1525
 *  `w._crit = w.sessions.reduce((a,s)=>a.concat(s.crit))`). This — NOT a re-eval
 *  of the DoD at the workstream root — drives the ring, so: (a) a zero-session
 *  workstream aggregates to `[]` → `computeProgress([])` → null → an un-scorable
 *  "?" ring (mockup wsUnscorable) instead of a fabricated root percent, and
 *  (b) git_merged stays honest because each session evaluated it against its OWN
 *  cwd/branch (in buildSessionRollup), so a workstream root that merely sits on
 *  the integration branch can't trivially satisfy "merged into main". */
function aggregateSessionCriteria(sessions: SessionRollup[]): CriterionEval[] {
  return sessions.flatMap((s) => s.progress?.criteria ?? s.dod?.criteria ?? []);
}

/** Archived OR abandoned: excluded from the active gauge/counts/long-pole and
 *  surfaced in a separate collapsed bucket (M1). A "done" status is NOT inactive —
 *  it counts as a completed workstream toward the project ring. */
export function workstreamInactive(workstream: Workstream): boolean {
  return Boolean(workstream.archived) || workstream.status === "abandoned";
}

export function buildWorkstreamRollup(
  workstream: Workstream,
  sessions: SessionRollup[],
): WorkstreamRollup {
  const inactive = workstreamInactive(workstream);
  // An inactive (archived / abandoned) workstream's sessions are tallied as
  // `abandoned` so they NEVER inflate the active in_progress/blocked/done counts —
  // the per-session derived status is irrelevant once the human shelved the work.
  const counts = inactive
    ? { ...zeroCounts(), abandoned: sessions.length }
    : countStatuses(sessions);
  const aggregate = aggregateSessionCriteria(sessions);
  // Mixed-source = the workstream's SESSIONS span >1 evaluator family
  // (types.ts:221 / DATA-MODEL §5.5). Each session collapses to ONE family via
  // `sessFamily`, so a heterogeneous DoD shared by every session is NOT mixed and
  // its criteria blend into a k-of-n ring (sessionGauge is reserved for sessions
  // that genuinely differ in family).
  const sessionFamilies = sessions
    .map((s) => sessFamily(s.progress?.criteria ?? s.dod?.criteria ?? []))
    .filter((f): f is CritFamily | "mixed" => f !== undefined);
  const mixed = new Set(sessionFamilies).size > 1;

  let progress: ProgressSnapshot | null;
  let sessionGauge: WorkstreamRollup["sessionGauge"];
  if (mixed) {
    progress = null;
    const total = sessions.length;
    const done = sessions.filter(sessionDone).length;
    sessionGauge = { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
  } else {
    // `computeProgress` returns null on an empty aggregate → un-scorable ring.
    progress = computeProgress(aggregate);
  }

  const out: WorkstreamRollup = { workstream, sessions, progress, counts };
  if (inactive) out.inactive = true;
  if (mixed) {
    out.mixed = true;
    out.sessionGauge = sessionGauge;
  }
  if (workstream.isLoop) {
    out.loop = {
      iter: 0,
      sparks: [],
      startedAt: workstream.loopStartedAt || "",
      ...(workstream.budget ? { budget: workstream.budget } : {}),
    };
  }
  return out;
}

// ---- Top-level assembly ------------------------------------------------------

/** A synthetic workstream that holds sessions matched to a project root but to no
 *  workstream, so they stay visible + counted (DATA-MODEL: ProjectRollup nests
 *  sessions only under workstreams). */
function unfiledWorkstream(project: Project): Workstream {
  return {
    id: `${project.id}:unfiled`,
    projectId: project.id,
    name: "Unfiled",
    status: "planned",
    sessionIds: [],
    order: Number.MAX_SAFE_INTEGER,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

// ---- Project ring: k-of-n WORKSTREAMS done (mockup projGauge L1748) ----------
// The project ring is NOT a blend of every workstream's criteria evaluated at the
// project root (that double-counts inheritance and lets a trunk-checked-out root
// fabricate a "done"). It is the share of SCORABLE workstreams that have reached
// their DoD — exactly the mockup's collapsed project face (index.html L1735-1748).

/** An open-ended autonomous loop has no terminal DoD to be "k of n" against. */
function wsOpenEnded(w: WorkstreamRollup): boolean {
  return Boolean(w.workstream.isLoop) || Boolean(w.loop);
}

/** A workstream has reached its DoD (mockup wsDone L1725). */
function workstreamDone(w: WorkstreamRollup): boolean {
  if (w.workstream.status === "done") return true;
  if (w.progress && w.progress.allMet) return true;
  return Boolean(w.sessionGauge && w.sessionGauge.total > 0 && w.sessionGauge.done === w.sessionGauge.total);
}

/** Un-scorable = nothing to be "k of n" against: open-ended loops OR a
 *  non-terminal, non-mixed workstream whose aggregated DoD is empty (null ring).
 *  Excluded from BOTH the gauge numerator and denominator so neither a perpetual
 *  loop nor an empty-DoD/zero-session workstream poisons "X of N met DoD"
 *  (mockup wsUnscorable / wsEmptyDod L1735-1742). */
function wsUnscorable(w: WorkstreamRollup): boolean {
  // Archived / abandoned: shelved by the human, never "k of n" against the active
  // project ring — excluded from BOTH the gauge numerator and denominator (M1).
  if (w.inactive) return true;
  if (wsOpenEnded(w)) return true;
  if (w.workstream.status === "done") return false; // terminal status is its own "done"
  if (w.mixed) return false; // mixed ws use the session-gauge, not crit %
  return w.progress == null; // no evaluable DoD criteria → un-scorable
}

/** The project ring as a ProgressSnapshot, computed as k-of-n scorable
 *  workstreams done (projGauge, mockup L1748). `criteria` stays empty — the ring
 *  aggregates workstream completion, not heterogeneous root-evaluated criteria. */
function projectProgress(workstreams: WorkstreamRollup[]): ProgressSnapshot {
  const counted = workstreams.filter((w) => !wsUnscorable(w));
  const total = counted.length;
  const done = counted.filter(workstreamDone).length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const allMet = total > 0 && done === total;
  return {
    met: done,
    total,
    metWeight: done,
    totalWeight: total,
    percent,
    allMet,
    unrun: 0,
    stale: 0,
    derivedStatus: allMet ? "done" : done > 0 ? "in_progress" : "planned",
    criteria: [],
  };
}

function computeLineage(
  project: Project,
  projects: Project[],
): ProjectRollup["lineage"] | undefined {
  let parent: Project | undefined;
  let parentRoot = "";
  for (const root of project.roots) {
    for (const other of projects) {
      if (other.id === project.id || other.archived) continue;
      for (const otherRoot of other.roots) {
        if (resolve(root) === resolve(otherRoot)) continue;
        if (isCwdUnder(root, otherRoot) && otherRoot.length > parentRoot.length) {
          parent = other;
          parentRoot = otherRoot;
        }
      }
    }
  }
  if (!parent) return undefined;
  return { parentProjectName: parent.name, fullPath: project.roots[0] || "" };
}

/** Every distinct git cwd the assembly below will `gitStatusFor`, deduped by
 *  resolved path. The route pre-warms these through a bounded-concurrency pool
 *  (runPooled) so distinct repo roots are evaluated concurrently rather than
 *  once-per-project sequentially (Gate B latency budget) without spawning hundreds
 *  of git processes at once. The per-root TTL cache de-dups, so each distinct root
 *  still loads exactly once; the per-project loop then reads from the warm cache. */
function collectRepoRoots(
  registry: ProjectRegistry,
  byProject: Map<string, Map<string, RollupSessionInput[]>>,
): string[] {
  const roots = new Set<string>();
  const add = (p: string | undefined): void => {
    if (typeof p === "string" && p.trim()) roots.add(resolve(p));
  };
  const addCriteriaRepos = (dod: DoD | undefined): void => {
    for (const c of dod?.criteria ?? []) {
      const repo = (c.source as { repo?: string }).repo;
      if (typeof repo === "string") add(repo);
    }
  };
  const projectById = new Map(registry.projects.map((p) => [p.id, p]));
  for (const project of registry.projects) {
    if (project.archived) continue;
    add(project.roots[0]);
    addCriteriaRepos(project.dod);
  }
  for (const ws of registry.workstreams) {
    const project = projectById.get(ws.projectId);
    if (!project || project.archived) continue;
    add(ws.matchCwd || project.roots[0]);
    addCriteriaRepos(ws.dod);
  }
  for (const buckets of byProject.values()) {
    for (const list of buckets.values()) {
      for (const s of list) add(s.cwd);
    }
  }
  return [...roots];
}

/** Memoize the merge-base check for ONE assembleRollups pass. git_merged's
 *  isAncestor bypasses the gitStatus TTL cache, so without this the same
 *  (root, branch, into) re-spawns `git merge-base --is-ancestor` once per
 *  workstream eval, once per co-located session in that workstream, and once at
 *  project scope — the per-session git fan-out the cache exists to prevent. The
 *  result is deterministic for the pass (a met git_merged is permanent), so it is
 *  safe to share; caching the promise also collapses concurrent identical checks.
 *  Keyed by resolved cwd + ancestor + into so distinct roots/branches stay distinct. */
function memoizeIsAncestor(
  isAncestor: AssembleContext["isAncestor"],
): AssembleContext["isAncestor"] {
  const cache = new Map<string, Promise<boolean>>();
  return (ancestor, into, cwd) => {
    const key = `${resolve(cwd)}\0${ancestor}\0${into}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const promise = isAncestor(ancestor, into, cwd);
    cache.set(key, promise);
    return promise;
  };
}

/** Run `task` over `items` with at most `limit` promises in flight. Bounds the
 *  pre-warm git fan-out: each gitStatus() itself spawns ~5-6 git subprocesses, so
 *  an unbounded Promise.all over N distinct repo roots would briefly spawn ~6*N
 *  concurrent processes and can hit OS fd/process limits (EMFILE / spawn EAGAIN)
 *  once N reaches dozens. The per-root TTL cache still guarantees each root loads
 *  exactly once; this only caps how many load simultaneously. */
async function runPooled<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index]);
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
}

/** Cap on concurrent gitStatus pre-warm loads (see runPooled). */
const PREWARM_CONCURRENCY = 8;

export async function assembleRollups(
  registry: ProjectRegistry,
  sessions: RollupSessionInput[],
  rawCtx: AssembleContext,
): Promise<ProjectRollup[]> {
  // Per-pass merge-base memoization (see memoizeIsAncestor): every downstream eval
  // goes through this wrapped ctx so each (root, branch, into) is checked once.
  const ctx: AssembleContext = { ...rawCtx, isAncestor: memoizeIsAncestor(rawCtx.isAncestor) };
  const { assignments } = mapSessionsToProjects(registry, sessions);
  const sessionById = new Map<string, RollupSessionInput>();
  for (const s of sessions) if (typeof s.id === "string" && s.id) sessionById.set(s.id, s);

  // Group assigned sessions by project, then by workstream (or `__unfiled__`).
  const byProject = new Map<string, Map<string, RollupSessionInput[]>>();
  for (const [sessionId, assignment] of assignments) {
    const session = sessionById.get(sessionId);
    if (!session) continue;
    let wsBuckets = byProject.get(assignment.projectId);
    if (!wsBuckets) {
      wsBuckets = new Map();
      byProject.set(assignment.projectId, wsBuckets);
    }
    const key = assignment.workstreamId ?? "__unfiled__";
    const bucket = wsBuckets.get(key);
    if (bucket) bucket.push(session);
    else wsBuckets.set(key, [session]);
  }

  // Pre-warm every distinct repo root BEFORE the per-project loop, so N distinct
  // repos cost ~max(one git fan-out) instead of the sum — but through a bounded
  // worker pool (runPooled) so dozens of repos can't spawn hundreds of concurrent
  // git subprocesses and trip OS limits. The per-root TTL cache still loads each
  // root exactly once. gitStatusFor is guarded by the caller (never rejects); the
  // extra catch keeps a single bad root from failing the whole warm-up (S3: never
  // throw on a messy session).
  await runPooled(
    collectRepoRoots(registry, byProject),
    PREWARM_CONCURRENCY,
    (root) => ctx.gitStatusFor(root).catch(() => undefined),
  );

  const rollups: ProjectRollup[] = [];

  for (const project of registry.projects) {
    if (project.archived) continue;

    const wsBuckets = byProject.get(project.id) ?? new Map<string, RollupSessionInput[]>();
    const orderedWorkstreams = registry.workstreams
      .filter((ws) => ws.projectId === project.id)
      .sort((a, b) => {
        const ai = project.workstreamIds.indexOf(a.id);
        const bi = project.workstreamIds.indexOf(b.id);
        if (ai !== bi) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
        return a.order - b.order;
      });

    const workstreamRollups: WorkstreamRollup[] = [];

    for (const ws of orderedWorkstreams) {
      // The DoD is INHERITED by each session and evaluated against that session's
      // own cwd; the workstream ring is the aggregate of those per-session evals
      // (see buildWorkstreamRollup) — never a single re-eval at the ws root.
      const inherited = ws.dod ?? project.dod;
      const sessionInputs = wsBuckets.get(ws.id) ?? [];
      const sessionRollups = await Promise.all(
        sessionInputs.map((s) => buildSessionRollup(s, inherited, ctx)),
      );
      workstreamRollups.push(buildWorkstreamRollup(ws, sessionRollups));
    }

    // Sessions matched to the project root but no workstream → an Unfiled bucket
    // (they inherit the project DoD, evaluated per-session like any other).
    const unfiledInputs = wsBuckets.get("__unfiled__") ?? [];
    if (unfiledInputs.length) {
      const ws = unfiledWorkstream(project);
      const inherited = project.dod;
      const sessionRollups = await Promise.all(
        unfiledInputs.map((s) => buildSessionRollup(s, inherited, ctx)),
      );
      workstreamRollups.push(buildWorkstreamRollup(ws, sessionRollups));
    }

    // Archived / abandoned workstreams are surfaced in a separate collapsed surface
    // and excluded from the active gauge/counts/long-pole. The project ring already
    // skips them (wsUnscorable); here we keep the active vs. inactive split so the
    // active-session tally and the project counts never include shelved work.
    const activeWorkstreams = workstreamRollups.filter((w) => !w.inactive);
    const activeSessions = activeWorkstreams.flatMap((w) => w.sessions);

    // Project ring = k-of-n scorable WORKSTREAMS done (projGauge), not a blend of
    // every workstream's root-evaluated criteria.
    const progress = projectProgress(workstreamRollups);

    // Active counts exclude inactive workstreams; the abandoned tally surfaces the
    // shelved sessions separately so the UI can show "+N abandoned" without inflating
    // the in_progress/blocked/done counts the gauge and hero read from.
    const counts = sumCounts(activeWorkstreams.map((w) => w.counts));
    counts.abandoned = sumCounts(workstreamRollups.map((w) => w.counts)).abandoned;
    const activeSessionCount = activeSessions.filter((s) => s.runtime.isRunning).length;
    const archivedSessionCount = workstreamRollups
      .filter((w) => w.inactive)
      .reduce((sum, w) => sum + w.sessions.length, 0);
    const lineage = computeLineage(project, registry.projects);

    const rollup: ProjectRollup = {
      project,
      workstreams: workstreamRollups,
      progress,
      counts,
      activeSessionCount,
    };
    if (archivedSessionCount > 0) rollup.archivedSessionCount = archivedSessionCount;
    if (lineage) rollup.lineage = lineage;
    rollups.push(rollup);
  }

  return rollups;
}

// Read-only summaries of ARCHIVED projects, for the dashboard's collapsed
// "Archived projects" surface. assembleRollups deliberately drops archived projects from the
// active feed (so their gauge/counts never inflate the fleet); this lists them so the user can
// Restore (PATCH archived:false) or Delete from the UI — closing the project lifecycle loop.
// Pure registry read: no sessions, no git, no DoD eval. Stable order (most-recently-touched
// first) keeps the surface from reshuffling between refetches.
export function collectArchivedProjects(registry: ProjectRegistry): ArchivedProjectSummary[] {
  return registry.projects
    .filter((p) => p.archived)
    .map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      rootCount: Array.isArray(p.roots) ? p.roots.length : 0,
      workstreamCount: registry.workstreams.filter((ws) => ws.projectId === p.id).length,
      updatedAt: p.updatedAt,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
