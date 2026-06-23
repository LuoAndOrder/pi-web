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
  emptyProgress,
  pendingGate,
  rootScoped,
} from "./progress.js";
import { deriveUiStatus, toWorkItemStatus } from "./status.js";
import {
  evalBase,
  evalGitCriterion,
  gitConflicted,
  sessionGitInfo,
  type GitStatusLite,
} from "./gitDod.js";
import type {
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
  live?: string;
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

function critFamily(kind: DoDSourceKind | undefined): "git" | "cmd" | "user" | "other" {
  if (!kind) return "other";
  if (kind.startsWith("git")) return "git";
  if (kind === "command") return "cmd";
  if (kind === "manual" || kind === "session_idle") return "user";
  return "other";
}

/** Mixed-source = the non-gate criteria span >1 evaluator family (DATA-MODEL §5.5),
 *  keyed off the STRUCTURED source kind (not the mockup's substring matcher). */
export function isMixed(evals: CriterionEval[]): boolean {
  const fams = new Set(evals.filter((e) => !e.gate).map((e) => critFamily(e.sourceKind)));
  return fams.size > 1;
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

  const wsByExplicit = new Map<string, Workstream>();
  for (const ws of registry.workstreams) {
    for (const id of ws.sessionIds) if (!wsByExplicit.has(id)) wsByExplicit.set(id, ws);
  }
  const wsWithMatch = registry.workstreams.filter((ws) => ws.matchCwd);

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

  const uiStatus = deriveUiStatus({
    runtime,
    git,
    progress,
    pendingGate: Boolean(gate),
    elicitation: false,
    fail: false,
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
  return rollup;
}

export function buildWorkstreamRollup(
  workstream: Workstream,
  sessions: SessionRollup[],
  effectiveDoDEvals: CriterionEval[],
): WorkstreamRollup {
  const counts = countStatuses(sessions);
  const mixed = isMixed(effectiveDoDEvals);

  let progress: ProgressSnapshot | null;
  let sessionGauge: WorkstreamRollup["sessionGauge"];
  if (mixed) {
    progress = null;
    const total = sessions.length;
    const done = sessions.filter(sessionDone).length;
    sessionGauge = { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
  } else {
    progress = effectiveDoDEvals.length ? computeProgress(effectiveDoDEvals) : null;
  }

  const out: WorkstreamRollup = { workstream, sessions, progress, counts };
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
 *  resolved path. The route pre-warms these IN PARALLEL so distinct repo roots are
 *  evaluated concurrently rather than once-per-project sequentially (Gate B
 *  latency budget). The per-root TTL cache de-dups, so each distinct root still
 *  loads exactly once; the per-project loop then reads from the warm cache. */
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

  // Pre-warm every distinct repo root in parallel BEFORE the per-project loop, so
  // N distinct repos cost ~max(one git fan-out) instead of the sum. gitStatusFor
  // is guarded by the caller (never rejects); the extra catch keeps a single bad
  // root from failing the whole warm-up (S3: never throw on a messy session).
  await Promise.all(
    collectRepoRoots(registry, byProject).map((root) =>
      ctx.gitStatusFor(root).catch(() => undefined),
    ),
  );

  const rollups: ProjectRollup[] = [];

  for (const project of registry.projects) {
    if (project.archived) continue;

    const wsBuckets = byProject.get(project.id) ?? new Map<string, RollupSessionInput[]>();
    const projectRoot = project.roots[0];
    const orderedWorkstreams = registry.workstreams
      .filter((ws) => ws.projectId === project.id)
      .sort((a, b) => {
        const ai = project.workstreamIds.indexOf(a.id);
        const bi = project.workstreamIds.indexOf(b.id);
        if (ai !== bi) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
        return a.order - b.order;
      });

    const workstreamRollups: WorkstreamRollup[] = [];
    const ownDoDEvalGroups: CriterionEval[][] = [];

    for (const ws of orderedWorkstreams) {
      const inherited = ws.dod ?? project.dod;
      const wsRoot = ws.matchCwd || projectRoot;
      // Workstream-scoped DoD eval (drives the ring) — evaluated once at the
      // workstream's repo-root context.
      const wsEvals = await evalDoD(inherited, wsRoot, ctx, undefined);
      if (ws.dod && ws.dod.criteria.length) ownDoDEvalGroups.push(wsEvals);

      const sessionInputs = wsBuckets.get(ws.id) ?? [];
      const sessionRollups = await Promise.all(
        sessionInputs.map((s) => buildSessionRollup(s, inherited, ctx)),
      );
      workstreamRollups.push(buildWorkstreamRollup(ws, sessionRollups, wsEvals));
    }

    // Sessions matched to the project root but no workstream → an Unfiled bucket.
    const unfiledInputs = wsBuckets.get("__unfiled__") ?? [];
    if (unfiledInputs.length) {
      const ws = unfiledWorkstream(project);
      const inherited = project.dod;
      const sessionRollups = await Promise.all(
        unfiledInputs.map((s) => buildSessionRollup(s, inherited, ctx)),
      );
      const wsEvals = await evalDoD(inherited, projectRoot, ctx, undefined);
      workstreamRollups.push(buildWorkstreamRollup(ws, sessionRollups, wsEvals));
    }

    const allSessions = workstreamRollups.flatMap((w) => w.sessions);

    // Project-level progress: project DoD + each workstream's OWN DoD (inheritance
    // is not double-counted). Evaluated at the project root context.
    const projectDoDEvals = await evalDoD(project.dod, projectRoot, ctx, undefined);
    const aggregateEvals = [...projectDoDEvals, ...ownDoDEvalGroups.flat()];
    const progress = computeProgress(aggregateEvals) ?? emptyProgress();

    const counts = sumCounts(workstreamRollups.map((w) => w.counts));
    const activeSessionCount = allSessions.filter((s) => s.runtime.isRunning).length;
    const lineage = computeLineage(project, registry.projects);

    const rollup: ProjectRollup = {
      project,
      workstreams: workstreamRollups,
      progress,
      counts,
      activeSessionCount,
    };
    if (lineage) rollup.lineage = lineage;
    rollups.push(rollup);
  }

  return rollups;
}

/** Alias for symmetry with the plan's naming (registry × sessions → rollups). */
export const joinRollups = assembleRollups;

// Re-export so the route layer can build SessionGitInfo / detect conflicts without
// reaching past this module.
export { gitConflicted, sessionGitInfo };
