// Project Rollups — the adapter seam.
//
// This is the single highest-leverage decision in the frontend port (impl-plan
// pillar 2). The validated mockup renders a FIXTURE shape and derived `_prog`/
// `_gate`/`_mixed`/`_sessGauge` in `enrich(data)` at the `loadScenario` seam. The
// real `/api/rollups` returns `ProjectRollup[]` with `progress` ALREADY computed
// server-side and a STRUCTURED `source.kind` on each criterion. `toViewModel` maps
// each rollup back onto the fixture field names `render.ts` reads — keeping every
// render function byte-for-byte — and builds `state.SESS`.
//
// HARD RULES honored here:
//   - The client NEVER re-derives progress: `progress` (ProgressSnapshot) flows
//     straight onto `_prog`; `_gate` is the first unmet gate criterion (a lookup,
//     not a recompute).
//   - The mockup's `srcFamily()`/`sessFamily()` substring matchers are gone — the
//     evaluator family + mixed-source decision are the SERVER's (`mixed`/
//     `sessionGauge`), and each criterion carries the structured `sourceKind`.
//   - Messy real sessions never throw: every optional field is defaulted (mirrors
//     `simplifySessionInfo`), so a session with no name / no DoD renders honestly.

import type {
  CriterionEval,
  DoD,
  DoDSourceKind,
  ProgressSnapshot,
  ProjectRollup,
  SessionRollup,
  UiStatus,
  WorkstreamRollup,
} from "./types.js";
import type {
  RenderState,
  VArtifact,
  VCrit,
  VProg,
  VProject,
  VSession,
  VWorkstream,
} from "./render.js";
import { statusRank } from "./render.js";

export interface ViewModel {
  data: VProject[];
  SESS: RenderState["SESS"];
}

/** Map a server ProgressSnapshot onto the `_prog` shape the rings read. NEVER recomputed. */
function toProg(ps: ProgressSnapshot | null | undefined): VProg | null {
  if (!ps) return null;
  return {
    met: ps.met,
    total: ps.total,
    percent: ps.percent,
    allMet: ps.allMet,
    unrun: ps.unrun,
    stale: ps.stale,
  };
}

const GIT_KINDS = new Set<DoDSourceKind>(["git_clean", "git_ahead_zero", "git_merged"]);

/** A relative "Nm ago" / "Nh ago" / "Nd ago" label from an ISO timestamp (honest, from
 *  the real `modified` / `evaluatedAt`); feeds the triage age + the "evaluated …" line. */
function relTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const min = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** A criterion's "at" label — only clock-bound for command/git evals (matches the mockup
 *  semantics critUnrun/critStale key off); manual/session truths have no clock-stale state. */
function critAt(ce: CriterionEval): string | undefined {
  const kind = ce.sourceKind;
  if (!kind || kind === "manual" || kind === "session_idle") return undefined;
  if (ce.unrun) return "never run";
  return relTime(ce.evaluatedAt);
}

/** A relative "merged X ago" label from a REAL server signal: the time the `git_merged`
 *  criterion was evaluated met (the closest merge-time proxy the server exposes today).
 *  Without it the renderer's Done today/earlier split, mergeRecency sort, and the hero
 *  "since you last looked: +N merged" delta were all permanently dead (review finding). */
function mergedAgoFromCriteria(criteria: CriterionEval[] | undefined): string | undefined {
  const merged = (criteria ?? []).find((c) => c.sourceKind === "git_merged" && c.met);
  return relTime(merged?.evaluatedAt);
}

/** Pass the server artifact through, attaching a `mergedAgo` the receipt structurally lacks:
 *  the git_merged eval time, falling back to the session's last-modified time as a proxy. */
function toArtifact(sr: SessionRollup): VArtifact | null {
  if (!sr.artifact) return null;
  const mergedAgo = mergedAgoFromCriteria(sr.progress?.criteria ?? sr.dod?.criteria) ?? relTime(sr.modified);
  return { ...sr.artifact, mergedAgo };
}

function toCrit(ce: CriterionEval): VCrit {
  return {
    id: ce.id, // carry the criterion identity to the seam so S7 can PATCH /api/dod/criterion/:id
    text: ce.text ?? "",
    met: !!ce.met,
    src: ce.sourceKind ?? "manual", // structured source.kind → c.src (no substring matching)
    ev: ce.evidence ?? "",
    at: critAt(ce),
    gate: ce.gate,
    weight: ce.weight,
    into: ce.into, // git_merged target branch → seed the drawer's editable target on re-open
  };
}

/** Human-readable label for a stored DoD's dominant evaluator family (workstream-level
 *  header text); the per-session label uses the server-computed `dod.sourceLabel`. */
const SOURCE_LABELS: Record<DoDSourceKind, string> = {
  manual: "manual",
  git_clean: "working tree clean",
  git_merged: "branch merged",
  git_ahead_zero: "branch pushed",
  command: "command",
  session_idle: "session idle",
};

function deriveWorkstreamDod(dod: DoD | undefined): { text: string; src: string } | null {
  if (!dod || !dod.criteria.length) return null;
  const kinds = new Set(dod.criteria.map((c) => c.source.kind));
  const text = dod.criteria.length === 1 ? dod.criteria[0].text : `${dod.criteria.length} criteria (k-of-n)`;
  const src = kinds.size === 1 ? SOURCE_LABELS[[...kinds][0]] : "mixed";
  return { text, src };
}

/** The 9-state render status of a session straight off the server `uiStatus`. */
function sessionStatus(sr: SessionRollup): string {
  return (sr.uiStatus as UiStatus) ?? "unset";
}

/** Derive the workstream's render-status (the mockup's hand-set `ws.status`) from its
 *  sessions: an autonomous loop renders ∞; otherwise the highest-attention session's
 *  render status (so a blocked session surfaces the workstream as blocked, a sign as
 *  awaiting-sign-off, etc.). An empty workstream falls back to its WorkItemStatus.
 *  Reuses render.ts's shared `statusRank` — no second ordering copy to drift. */
function workstreamStatus(wr: WorkstreamRollup, sessions: VSession[]): string {
  if (wr.workstream.isLoop) return "loop";
  if (sessions.length) {
    return sessions.reduce((best, s) => (statusRank(s.status) < statusRank(best.status) ? s : best)).status;
  }
  switch (wr.workstream.status) {
    case "in_progress": return "run";
    case "blocked": return "block";
    case "done": return "merge";
    default: return "planned";
  }
}

/** Elapsed minutes of a running loop, derived STRICTLY from the stored `loopStartedAt`
 *  ISO timestamp (registry field, spec §5.4) — NEVER from `runtime.startedAt`, which
 *  resets on the 60s idle dispose. A missing/garbage timestamp yields `undefined` so the
 *  badge renders no fabricated duration. This is the single place real data crosses from
 *  `loopStartedAt` to the `elapsedMin` the renderer's `loopMinutes`/`fmtMin` consume. */
export function elapsedMinFromLoopStart(startedAt?: string, now: number = Date.now()): number | undefined {
  if (!startedAt) return undefined;
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((now - t) / 60000));
}

/** A session's loop telemetry. A loop is a WORKSTREAM-level concept in the registry
 *  (`Workstream.isLoop`/`loopStartedAt`/`budget`), so a session's loop info is INHERITED
 *  from its workstream (`wsLoop`); the per-session `sr.loop` (reserved for a future
 *  per-iteration log) wins if the server ever populates it. Returns `null` for a
 *  non-loop session so the renderer draws no loop badge / proposed band. */
function toSession(sr: SessionRollup, wsLoop?: WorkstreamRollup["loop"]): VSession {
  const crit = (sr.dod?.criteria ?? []).map(toCrit);
  const gate = crit.find((c) => c.gate && !c.met) ?? null;
  const elicited = !!sr.elicitation;
  // A git-conflicted working tree is a HARD blocker (DATA-MODEL §5.3) even without a
  // structured ask — surface it so the client isNeed/isSoftWait treat it as an
  // obligation, matching the server's status.ts isHardNeed (the high-severity finding).
  const gitBlocked = !!sr.git?.blocked;
  // Loop info is the workstream's (the registry's source of truth), with the
  // per-session `sr.loop` taking precedence if present. `elapsedMin` flows from
  // `loopStartedAt` only — never from `sr.runtime.startedAt`.
  const loop = sr.loop ?? wsLoop;
  const isLoop = !!loop;
  // A session inside an autonomous-loop workstream renders as "loop" (it IS part of a
  // running loop), UNLESS it surfaces a higher-attention state of its own — a real
  // block/fail must still float up, and a terminal sign/merge must not be masked. This
  // is honest: the open-ended loop has no terminal DoD, so without this a loop session
  // with no DoD would read "unset / needs-setup" instead of the cyan "looping" it is.
  const baseStatus = sessionStatus(sr);
  const status = isLoop && (baseStatus === "unset" || baseStatus === "run" || baseStatus === "queued" || baseStatus === "planned")
    ? "loop"
    : baseStatus;
  const loopMin = isLoop ? elapsedMinFromLoopStart(loop?.startedAt) : undefined;
  // iter/sparks are the durable per-iteration log pi does NOT expose today (spec §5.4):
  // the server emits placeholder `iter:0`/`sparks:[]`. Surface a count ONLY when it is a
  // real positive iteration / a populated rhythm — otherwise leave it undefined so the
  // muted "proposed" band reads "…not live yet" and never asserts a fabricated "iter 0".
  const iter = loop && typeof loop.iter === "number" && loop.iter > 0 ? loop.iter : undefined;
  const iterspark = loop && loop.sparks && loop.sparks.length ? loop.sparks : undefined;
  return {
    id: sr.id,
    name: sr.name || "Untitled session",
    cwd: sr.cwd,
    status,
    _prog: toProg(sr.progress),
    _gate: gate,
    crit,
    live: sr.live || sr.elicitation?.question || "",
    dod: sr.dod?.text ?? "",
    dodSrc: sr.dod?.sourceLabel || "unset",
    meta: !sr.runtime?.isRunning ? relTime(sr.modified) : "running",
    kind: elicited ? "question" : status === "fail" ? "failed" : undefined,
    elicited,
    gitBlocked,
    chips: sr.elicitation?.options ?? [],
    blast: sr.blast,
    failAction: sr.failAction,
    loop: isLoop,
    // iter/sparks are the durable per-iteration log that pi does NOT expose today
    // (spec §5.4) — surfaced ONLY in the muted "proposed" band, never as a live badge.
    // Inherited from the workstream loop only if a future server populates them.
    iter,
    iterspark,
    elapsedMin: loopMin,
    budget: loop?.budget,
    queue: sr.plannedQueue?.items,
    queueTotal: sr.plannedQueue?.total,
    artifact: toArtifact(sr),
    unread: sr.unread,
    messageCount: sr.messageCount,
    modified: sr.modified,
  };
}

function toWorkstream(wr: WorkstreamRollup, project: ProjectRollup["project"]): VWorkstream {
  // A loop is a workstream-level concept (Workstream.isLoop/loopStartedAt) — push it
  // down to each session so the per-row "∞ looping {elapsed}" badge + proposed band
  // render with elapsed grounded in the workstream's stored loopStartedAt.
  const sessions = wr.sessions.map((sr) => toSession(sr, wr.loop));
  const status = workstreamStatus(wr, sessions);
  const dodInfo = deriveWorkstreamDod(wr.workstream.dod);
  return {
    id: wr.workstream.id,
    name: wr.workstream.name,
    status,
    dod: dodInfo?.text ?? "",
    dodSrc: dodInfo?.src ?? "unset",
    sessions,
    _prog: toProg(wr.progress),
    _mixed: !!wr.mixed,
    _sessGauge: wr.sessionGauge,
    loop: !!wr.workstream.isLoop,
    // Renderer fallback for a merge-status session whose receipt carries no mergedAgo.
    mergedAgo: mergedAgoFromCriteria(wr.progress?.criteria),
    // M3 lifecycle: carry the server `inactive` flag + the canonical WorkItemStatus +
    // the owning project context so the actions menu can show the right verbs and the
    // Archived section can render rows outside a `.pcard`.
    _inactive: !!wr.inactive,
    _itemStatus: wr.workstream.status,
    _projectId: project.id,
    _projectName: project.name,
    // The synthetic rollup-time "Unfiled" bucket has no STORED workstream (id ends
    // `:unfiled`), so it can't be PATCHed/DELETEd — the lifecycle menu is suppressed on it.
    _synthetic: wr.workstream.id.endsWith(":unfiled"),
  };
}

/** Shorten a `/Users/<name>` (or `/home/<name>`) prefix to `~` for a calmer display path. */
function prettyPath(root?: string): string {
  if (!root) return "";
  return root.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function toProject(pr: ProjectRollup): VProject {
  const all = pr.workstreams.map((wr) => toWorkstream(wr, pr.project));
  // Split active vs archived/abandoned so the active grid (gauge, long-pole, dotStrip,
  // fleet counts) only ever sees active workstreams; the inactive ones render in a
  // separate collapsed "Archived" surface, out of every active count (M3 HARD RULE).
  const workstreams = all.filter((w) => !w._inactive);
  const archivedWorkstreams = all.filter((w) => w._inactive);
  return {
    id: pr.project.id,
    name: pr.project.name,
    path: prettyPath(pr.project.roots[0]),
    desc: pr.project.description ?? "",
    nest: pr.lineage ? `in ${pr.lineage.parentProjectName}` : undefined,
    workstreams,
    ...(archivedWorkstreams.length ? { archivedWorkstreams } : {}),
    // The server's k-of-n project gauge (rollup.ts projectProgress) flows straight onto
    // `_prog` so the ring reads the server ProgressSnapshot — the client never re-derives
    // the project percent (review finding; matches the ws/session rings via toProg).
    _prog: toProg(pr.progress),
  };
}

/** Map the server `/api/rollups` payload onto the mockup-shaped view model + the SESS index. */
export function toViewModel(rollups: ProjectRollup[]): ViewModel {
  const data = (rollups || []).map(toProject);
  const SESS: ViewModel["SESS"] = {};
  // Index BOTH active and archived workstreams' sessions: a row's actions menu (and the
  // Archived section's per-session controls) resolves the session/workstream via SESS,
  // so an archived session must still be reachable for restore / delete / open.
  const indexWs = (p: VProject, w: VWorkstream) => w.sessions.forEach((s) => { SESS[s.id] = { s, w, p }; });
  data.forEach((p) => {
    p.workstreams.forEach((w) => indexWs(p, w));
    (p.archivedWorkstreams || []).forEach((w) => indexWs(p, w));
  });
  return { data, SESS };
}
