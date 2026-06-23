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
  VCrit,
  VProg,
  VProject,
  VSession,
  VWorkstream,
} from "./render.js";

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
    metW: ps.metWeight,
    totW: ps.totalWeight,
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

function toCrit(ce: CriterionEval): VCrit {
  return {
    text: ce.text ?? "",
    met: !!ce.met,
    src: ce.sourceKind ?? "manual", // structured source.kind → c.src (no substring matching)
    ev: ce.evidence ?? "",
    at: critAt(ce),
    gate: ce.gate,
    weight: ce.weight,
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

const STATUS_RANK: Record<string, number> = { block: 0, fail: 0, unset: 1, run: 2, loop: 2, sign: 3, queued: 4, planned: 4, merge: 5 };

/** Derive the workstream's render-status (the mockup's hand-set `ws.status`) from its
 *  sessions: an autonomous loop renders ∞; otherwise the highest-attention session's
 *  render status (so a blocked session surfaces the workstream as blocked, a sign as
 *  awaiting-sign-off, etc.). An empty workstream falls back to its WorkItemStatus. */
function workstreamStatus(wr: WorkstreamRollup, sessions: VSession[]): string {
  if (wr.workstream.isLoop) return "loop";
  if (sessions.length) {
    let best = sessions[0].status, rank = STATUS_RANK[best] ?? 9;
    for (const s of sessions) {
      const r = STATUS_RANK[s.status] ?? 9;
      if (r < rank) { rank = r; best = s.status; }
    }
    return best;
  }
  switch (wr.workstream.status) {
    case "in_progress": return "run";
    case "blocked": return "block";
    case "done": return "merge";
    default: return "planned";
  }
}

function toSession(sr: SessionRollup): VSession {
  const status = sessionStatus(sr);
  const crit = (sr.dod?.criteria ?? []).map(toCrit);
  const gate = crit.find((c) => c.gate && !c.met) ?? null;
  const elicited = !!sr.elicitation;
  const loopMin = sr.loop?.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(sr.loop.startedAt)) / 60000)) : undefined;
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
    chips: sr.elicitation?.options ?? [],
    blast: sr.blast,
    failAction: sr.failAction,
    loop: !!sr.loop,
    iter: sr.loop?.iter,
    iterspark: sr.loop?.sparks,
    elapsedMin: loopMin,
    budget: sr.loop?.budget,
    queue: sr.plannedQueue?.items,
    queueTotal: sr.plannedQueue?.total,
    artifact: sr.artifact ?? null,
    unread: sr.unread,
    messageCount: sr.messageCount,
    modified: sr.modified,
  };
}

function toWorkstream(wr: WorkstreamRollup): VWorkstream {
  const sessions = wr.sessions.map(toSession);
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
  };
}

/** Shorten a `/Users/<name>` (or `/home/<name>`) prefix to `~` for a calmer display path. */
function prettyPath(root?: string): string {
  if (!root) return "";
  return root.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function toProject(pr: ProjectRollup): VProject {
  return {
    id: pr.project.id,
    name: pr.project.name,
    path: prettyPath(pr.project.roots[0]),
    desc: pr.project.description ?? "",
    nest: pr.lineage ? `in ${pr.lineage.parentProjectName}` : undefined,
    workstreams: pr.workstreams.map(toWorkstream),
  };
}

/** Map the server `/api/rollups` payload onto the mockup-shaped view model + the SESS index. */
export function toViewModel(rollups: ProjectRollup[]): ViewModel {
  const data = (rollups || []).map(toProject);
  const SESS: ViewModel["SESS"] = {};
  data.forEach((p) => p.workstreams.forEach((w) => w.sessions.forEach((s) => { SESS[s.id] = { s, w, p }; })));
  return { data, SESS };
}
