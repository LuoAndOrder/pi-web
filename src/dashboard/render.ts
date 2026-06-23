// Project Rollups — read-only render core.
//
// Ported nearly byte-for-byte from the validated mockup
// `docs/dashboard-designs-final/index.html` (render functions L896-2862). The ONE
// structural change is the data seam: the mockup derived `_prog`/`_gate`/`_mixed`/
// `_sessGauge` in `enrich(data)` and read a fixture; here `rollupAdapter.toViewModel`
// maps the server `ProjectRollup[]` onto these same fixture field names BEFORE render,
// so every function below reads exactly what it read in the mockup — and the client
// NEVER re-derives progress (it trusts the server `ProgressSnapshot`).
//
// All functions live inside `createRenderer` so they close over the live `state` and
// the `wrap` element (the dashboard overlay's `.wrap`), keeping the bodies verbatim.
// Interactions (Continue / sign-off / drill-in click delegation, the synthetic
// `#conv` composer, DoD authoring) are intentionally NOT ported here — they land in
// S6/S7/S9/S10 wired to the REAL conversation + REST surface.

// ─────────────────────────── view-model shapes the renderers read ───────────────────────────

export interface VProg {
  met: number;
  total: number;
  percent: number;
  allMet: boolean;
  unrun: number;
  stale: number;
}
export interface VGauge {
  done: number;
  total: number;
  percent: number;
}
export interface VArtifact {
  kind?: string;
  branch?: string;
  sha?: string;
  merged?: boolean;
  add?: number;
  del?: number;
  ahead?: number;
  note?: string;
  files?: number;
  mergedAgo?: string;
}
export interface VCrit {
  id?: string;
  text?: string;
  met?: boolean;
  src?: string;
  ev?: string;
  at?: string;
  gate?: boolean;
  weight?: number;
  kind?: string;
  // git_merged target branch (source.into) so the authoring drawer re-seeds the editable
  // target from the real stored ref instead of a hardcoded "main" (review finding).
  into?: string;
}
export interface VSession {
  id: string;
  name?: string;
  cwd?: string;
  status: string;
  _prog?: VProg | null;
  _gate?: VCrit | null;
  _evaluating?: boolean;
  crit?: VCrit[];
  live?: string;
  dod?: string;
  dodSrc?: string;
  meta?: string;
  kind?: string;
  elicited?: boolean;
  // A git-conflicted working tree — a HARD blocker (DATA-MODEL §5.3) even without a
  // structured ask, so isNeed/isSoftWait treat it as an obligation, not a quiet wait.
  gitBlocked?: boolean;
  chips?: string[];
  blast?: string;
  failAction?: string;
  loop?: boolean;
  iter?: number;
  iterspark?: number[];
  elapsedMin?: number;
  budget?: { maxMinutes?: number; maxCostUsd?: number };
  cost?: number;
  queue?: string[];
  queueTotal?: number;
  artifact?: VArtifact | null;
  mergedAgo?: string;
  unread?: boolean;
  messageCount?: number;
  modified?: string;
}
export interface VWorkstream {
  id: string;
  name: string;
  status: string;
  dod?: string;
  dodSrc?: string;
  sessions: VSession[];
  _prog?: VProg | null;
  _mixed?: boolean;
  _sessGauge?: VGauge;
  loop?: boolean;
  mergedAgo?: string;
  // Archived OR abandoned: this workstream is shelved. The adapter routes inactive
  // workstreams into `VProject.archivedWorkstreams` (a separate collapsed surface),
  // out of the active gauge/counts; the flag also drives the Archived-row chrome.
  _inactive?: boolean;
  // The workstream's canonical 5-value WorkItemStatus (planned/in_progress/blocked/
  // done/abandoned), carried so the per-workstream actions menu can hide/show the
  // right verbs (e.g. "Mark done" is hidden once status is already "done").
  _itemStatus?: string;
  // The project this workstream belongs to — the actions menu PATCHes/ DELETEs by
  // workstream id, but the Archived section renders rows outside a `.pcard`, so each
  // row carries its project crumb for context.
  _projectId?: string;
  _projectName?: string;
  // The synthetic rollup-time "Unfiled" bucket has no stored registry workstream, so the
  // lifecycle menu (PATCH/DELETE by id) is suppressed on it (it would 404).
  _synthetic?: boolean;
}
export interface VProject {
  id: string;
  name: string;
  path?: string;
  desc?: string;
  nest?: string;
  workstreams: VWorkstream[];
  // Archived / abandoned workstreams, split out by the adapter so the active grid
  // (gauge, long-pole, dotStrip, fleet counts) never sees them; rendered in a
  // separate collapsed "Archived" surface, out of the active counts (M3 HARD RULE).
  archivedWorkstreams?: VWorkstream[];
  // The server-computed project ProgressSnapshot (rollup.ts projectProgress: k-of-n
  // scorable workstreams done). The client trusts this and NEVER re-derives the project
  // gauge on render — `met`/`total`/`percent` are the single source of truth for the ring,
  // matching the workstream/session rings that already read toProg(...) (review finding).
  _prog?: VProg | null;
}
// A cold-start onboarding candidate: an unregistered cwd that pi has sessions in. Derived
// client-side from GET /api/sessions (impl-plan S9 — prefer client-derive to stay
// frontend-only), with the registered project roots filtered out. `path` is the absolute
// cwd POSTed to /api/projects; `display` is the ~-shortened label.
export interface OnboardCandidate {
  name: string;
  path: string;
  display: string;
  sessions: number;
}
export interface RenderState {
  data: VProject[];
  SESS: Record<string, { s: VSession; w: VWorkstream; p: VProject }>;
  signed: Record<string, boolean>;
  lastVisit: string | null;
  _pingId: string | null;
  // Cold-start onboarding candidates (S9). Populated by the controller before an empty render.
  candidates?: OnboardCandidate[];
  // M4 — Unfiled session multi-select. The set of session ids currently checked in the
  // synthetic Unfiled bucket, so the renderer can paint the checked state + the assignment
  // bar (driven by the controller's transient selection). Cleared on every refetch.
  mnSelection?: Set<string>;
}

// Onboarding intent callbacks the controller wires to the REAL REST surface (S9). The
// renderer stays render-only: it draws the onboarding card + binds buttons to these.
export interface OnboardHandlers {
  // Register a candidate (or the generic "Add a project") → POST /api/projects {name, roots}.
  onRegister: (name: string, path: string) => void;
  // Start the user's first pi session → sessions.startNewSession() then close the overlay.
  onStartSession: () => void;
}

type RingItem = {
  status?: string;
  _prog?: VProg | null;
  _sessGauge?: VGauge;
  loop?: boolean;
  _evaluating?: boolean;
};
type RowOpts = { navOnly?: boolean; setup?: boolean; live?: boolean; selectable?: boolean };
interface Counts {
  run: number;
  loop: number;
  block: number;
  softwait: number;
  sign: number;
  plan: number;
  merge: number;
  fail: number;
  unset: number;
  total: number;
  projects: number;
  active: number;
  needs: number;
  healthy: number;
  setup: number;
}
interface CardLive {
  tone: string;
  loop: boolean;
  txt: string;
  id: string | null;
  pointUp?: string;
  qDelta?: { total: number } | null;
  unset?: boolean;
}

export interface DashboardRenderer {
  renderAll: (sc?: { empty?: boolean; candidates?: number }) => void;
  // Build the drill-in oversight band (breadcrumb + k-of-n ring + DoD criteria) shown above the
  // REAL conversation when a session is opened from a rollup, so the drill keeps its project /
  // workstream / DoD frame instead of dropping into a context-free full-view (review finding).
  contextBandHtml: (sessionId: string) => string | null;
  // S7 partial re-renders — dashboard.ts calls these after an OPTIMISTIC local flip (sign-off /
  // recheck) so the section repaints immediately without a network round-trip. They re-read the
  // shared `state` (signed map, SESS, _evaluating), so the caller mutates state then re-renders.
  renderSignoff: () => void;
  renderGrid: () => void;
  // M3 — repaint the Archived section after a lifecycle action (archive / cancel / restore)
  // re-shapes which workstreams are shelved, without a full master re-render.
  renderArchived: () => void;
  // M4 — repaint just the Unfiled bucket(s)' sess-list after a selection change (checkbox
  // toggle / clear) so the assignment bar + checked state update without a full grid repaint.
  renderUnfiled: () => void;
  // Tells whether a `sign`-status session still rests on stale/unrun evidence — used to decide
  // batch sign-off eligibility (only clean items flip).
  signPending: (sessionId: string) => boolean;
}

// Shared status ordering (lower rank = more urgent, surfaces first). Exported as the SINGLE
// source of truth so the adapter's `workstreamStatus` reuses it instead of keeping a second
// 9-key copy that can drift (review finding). The renderer's `byAttention` reads it too.
export const STATUS_RANK: Record<string, number> = { block: 0, fail: 0, unset: 1, run: 2, loop: 2, sign: 3, queued: 4, planned: 4, merge: 5 };
export function statusRank(st: string) { return STATUS_RANK[st] != null ? STATUS_RANK[st] : 9; }

// A HARD need (enters Needs-you / the hero obligation count): a FAILURE, a
// STRUCTURALLY-ELICITED block, OR a git-CONFLICT block (DATA-MODEL §5.3 lists a
// conflicted working tree as a hard blocker). Mirrors the server's status.ts
// `isHardNeed` so a real git-conflicted session surfaces as an obligation instead of
// degrading to a quiet "may be waiting" (the high-severity review finding). A
// non-elicited, non-conflict idle stop stays a SOFT wait, never amber.
export function isHardNeedV(s: { status?: string; elicited?: boolean; gitBlocked?: boolean }): boolean {
  return s.status === "fail" || (s.status === "block" && (!!s.elicited || !!s.gitBlocked));
}
export function isSoftWaitV(s: { status?: string; elicited?: boolean; gitBlocked?: boolean }): boolean {
  return s.status === "block" && !s.elicited && !s.gitBlocked;
}

// ── loop elapsed (S11), the SINGLE grounded source ────────────────────────────
// A live loop's "∞ looping {elapsed}" badge derives its elapsed STRICTLY from the
// stored `loopStartedAt` (registry field, spec §5.4), surfaced on the view model as
// `elapsedMin = now − loopStartedAt` (computed once in rollupAdapter.toSession). It
// is NEVER taken from `runtimeForPath` — the 60s idle dispose resets runtime
// timestamps, so a 38-minute loop would read as a fresh "running just now" the
// moment its live session is disposed. An un-grounded loop (no `loopStartedAt`)
// yields 0, never an inferred/parsed elapsed — so the badge can never fabricate a
// duration. Exported (module-level, pure) so it is directly unit-testable and so the
// renderer + any future caller share ONE formula that cannot drift.
export function loopMinutes(s: { elapsedMin?: number }): number {
  return s.elapsedMin != null ? s.elapsedMin : 0;
}
export function fmtMin(min: number): string {
  if (min >= 1440) { const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60); return h ? `${d}d ${h}h` : `${d}d`; }
  if (min >= 60) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h ${m}m` : `${h}h`; }
  return `${min}m`;
}

// ── M4 auto-group clustering (the SINGLE grounded heuristic) ──────────────────
// Cluster Unfiled sessions by a shared, normalized name prefix so the dashboard can
// offer a one-click "Group these N related sessions?" chip that pre-creates a real
// workstream. Purely client-side + deterministic: it only suggests a grouping when ≥2
// sessions share a meaningful leading token sequence (a normalized prefix of ≥3 chars),
// never inventing a relationship from thin signal. Exported (module-level, pure) so it is
// directly unit-testable and the renderer + controller share ONE formula.
//
// `label` is the human-readable shared phrase (Title Cased), `key` the normalized prefix.
export interface AutoGroup {
  key: string;
  label: string;
  sessionIds: string[];
}
// Lowercase, strip a trailing "(2)"/"#3"/": foo" tail + non-alphanumerics → comparable tokens.
function groupTokens(name: string): string[] {
  return String(name || "")
    .toLowerCase()
    .replace(/[#(]\s*\d+\s*\)?$/g, "") // a trailing "#3" / "(2)" disambiguator is not part of the topic
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
// Title-case the shared token sequence for the chip label ("auth refactor" → "Auth Refactor").
function titleCase(tokens: string[]): string {
  return tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ");
}
export function clusterUnfiledSessions(
  sessions: Array<{ id: string; name?: string }>,
): AutoGroup[] {
  // Bucket by the FIRST shared token (the dominant topic word), then keep extending the
  // shared prefix while every member in the bucket still agrees, so the suggested name is
  // as specific as the evidence supports.
  const byFirst = new Map<string, Array<{ id: string; tokens: string[] }>>();
  for (const s of sessions) {
    const tokens = groupTokens(s.name ?? "");
    if (!tokens.length) continue;
    const head = tokens[0];
    if (head.length < 3) continue; // a 1-2 char head (e.g. "wip") is too weak to group on
    if (!byFirst.has(head)) byFirst.set(head, []);
    byFirst.get(head)!.push({ id: s.id, tokens });
  }
  const groups: AutoGroup[] = [];
  for (const [head, members] of byFirst) {
    if (members.length < 2) continue; // need ≥2 to suggest a grouping
    // Longest common leading token run across all members → the most specific shared phrase.
    let shared = members[0].tokens.slice();
    for (const m of members.slice(1)) {
      let i = 0;
      while (i < shared.length && i < m.tokens.length && shared[i] === m.tokens[i]) i++;
      shared = shared.slice(0, i);
    }
    if (!shared.length) shared = [head];
    groups.push({ key: shared.join("-"), label: titleCase(shared), sessionIds: members.map((m) => m.id) });
  }
  // Largest suggestions first; stable tiebreak by key so the chip order never churns.
  return groups.sort((a, b) => b.sessionIds.length - a.sessionIds.length || a.key.localeCompare(b.key));
}

export function createRenderer(options: { wrap: HTMLElement; state: RenderState; onboard?: OnboardHandlers }): DashboardRenderer {
  const { wrap, state, onboard } = options;

  const ST: Record<string, { label: string; cls: string; color: string }> = {
    block: { label: "Blocked · needs input", cls: "block", color: "var(--st-block)" },
    run: { label: "Running", cls: "run", color: "var(--st-run)" },
    loop: { label: "Looping", cls: "run", color: "var(--st-run)" },
    sign: { label: "Done · awaiting sign-off", cls: "sign", color: "var(--st-sign)" },
    merge: { label: "Completed · merged", cls: "merge", color: "var(--st-merge)" },
    fail: { label: "Failed", cls: "fail", color: "var(--st-fail)" },
    queued: { label: "Queued", cls: "idle", color: "var(--st-idle)" },
    planned: { label: "Planned · not started", cls: "idle", color: "var(--st-idle)" },
    unset: { label: "Set criterion", cls: "unset", color: "var(--st-sign)" },
  };
  function byAttention(a: { status: string; id?: string; name?: string }, b: { status: string; id?: string; name?: string }) {
    return (statusRank(a.status) - statusRank(b.status)) || String(a.id || a.name || "").localeCompare(String(b.id || b.name || ""));
  }

  // a sign-status session resting on stale/unrun command evidence — can't be signed off yet (#5)
  function signPending(s: VSession) { return s.status === "sign" && !!s._prog && (s._prog.unrun > 0 || s._prog.stale > 0); }

  // ─────────────────────────── small helpers ───────────────────────────
  // Escape the FULL attribute-safe set (& < > " '), matching dashboard.ts escapeHtml — every
// interpolation here can land in a double-quoted HTML attribute assigned via innerHTML, so a
// bare & < > escaper would let a value containing a quote break out and inject an event handler
// (stored DOM XSS via a project name/description/path or an agent-authored elicitation option).
  const esc = (t?: unknown) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  // S7 interactions (sign-off / quick-reply / recheck / batch sign-off / focus-triage) are now
  // LIVE — wired in dashboard.ts to the real REST surface (PATCH /api/dod/criterion/:id optimistic,
  // POST /api/prompt for chips, the /api/dod/evaluate recheck stub). These helpers used to render
  // the controls as `disabled`/`soon` placeholders for the read-only S5 slice; they're now no-ops
  // so the buttons render as ordinary enabled affordances the delegated handler picks up.
  const deferTip = (what: string) => ` title="${esc(what)}"`;
  // The sign-off CTAs are live one-click controls again, so drop the "soon" treatment + tag.
  const soonTag = ``;
  // a HARD need = a FAILURE, a STRUCTURALLY-ELICITED block, or a git-CONFLICT block
  // (spec §5.3); a non-elicited, non-conflict free-text stop can't be PROVEN a blocker, so
  // it degrades to a quiet "may be waiting", never Needs-you. Uses the shared module helpers.
  const isNeed = (s: VSession) => isHardNeedV(s);
  const isSoftWait = (s: VSession) => isSoftWaitV(s);
  const isRecent = (ago?: string) => /(^now|sec|min|m ago|h ago|hour)/i.test(ago || "");
  function blastRadius(s: VSession): string {
    if (s.blast) return s.blast;
    const t = ((s.live || "") + " " + (s.name || "")).toLowerCase();
    if (/(drop|delete|destroy|migrat|irrevers|\brm\b|--force|reset --hard|truncate)/.test(t)) return "hi";
    return "lo";
  }
  const blastRank = (b: string) => (b === "hi" ? 0 : b === "md" ? 1 : 2);
  const blastLabel = (b: string) => (b === "hi" ? "high blast radius" : b === "md" ? "elevated blast radius" : "low blast radius");
  function waitLabel(s: VSession) { if (!s.meta) return ""; const m = agoToMin(s.meta); return (m >= 1e9 || m <= 0) ? "" : fmtMin(m); }
  const shortWs = (nm?: string) => String(nm || "").replace("Nightly ", "").replace("Spike: ", "").replace(" loop", "");

  // ─────────────────────────── SEGMENTED progress ring (#1,#5,#15) ───────────────────────────
  function segArcs(met: number, runTotal: number, unrun: number, _percent: number, color: string) {
    const r = 15.5, C = 2 * Math.PI * r, n = runTotal + unrun;
    if (n > 6) { // past 6 criteria → one clean proportional arc over the RUN criteria (#15)
      const off = C * (1 - (runTotal ? met / runTotal : 0));
      const faint = unrun ? `<circle cx="18" cy="18" r="${r}" fill="none" stroke="color-mix(in srgb,var(--st-idle) 42%,transparent)" stroke-width="1.6" stroke-dasharray="2 3"/>` : "";
      return faint + `<circle class="ring-fill" cx="18" cy="18" r="${r}" stroke="${color}" stroke-dasharray="${C} ${C}" stroke-dashoffset="${off}" transform="rotate(-90 18 18)"/>`;
    }
    const seg = C / n, gap = Math.min(seg * 0.22, 3.4), dash = Math.max(seg - gap, 1.4);
    let out = "";
    for (let i = 0; i < n; i++) {
      const isUnrun = i >= runTotal;
      const stroke = i < met ? color : (isUnrun ? "color-mix(in srgb,var(--st-idle) 45%,transparent)" : "var(--seg-off)");
      const sw = isUnrun ? 1.6 : 3.4;
      const da = isUnrun ? `${(dash * 0.5).toFixed(2)} ${(C - dash * 0.5).toFixed(2)}` : `${dash.toFixed(2)} ${(C - dash).toFixed(2)}`;
      out += `<circle cx="18" cy="18" r="${r}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="butt" ` +
        `stroke-dasharray="${da}" stroke-dashoffset="${(-i * seg).toFixed(2)}" transform="rotate(-90 18 18)"/>`;
    }
    return out;
  }
  // colourblind-safe status SHAPE at the 12-o'clock cap (#13)
  function ringShape(st: string, color: string) {
    if (st === "run") return `<circle cx="18" cy="3.6" r="2.7" fill="${color}"/>`;
    if (st === "block") return `<rect x="15.3" y="0.9" width="5.4" height="5.4" rx="0.7" fill="${color}"/>`;
    if (st === "sign") return `<rect x="15.4" y="1" width="5.2" height="5.2" fill="${color}" transform="rotate(45 18 3.6)"/>`;
    if (st === "fail") return `<text x="18" y="7.6" text-anchor="middle" font-size="11" font-weight="800" fill="${color}">×</text>`;
    return "";
  }
  // item = a session or workstream carrying .status, ._prog (or ._sessGauge for mixed), .loop.
  // [data-testid="ring"] + [data-percent]/[data-asterisk] are the e2e contract hooks; data-percent
  // ALWAYS equals a server-derived percent (never an invented one), satisfying DoD invariant #6.
  function ringSvg(item: RingItem, size: number, opts?: { neutral?: boolean }) {
    const o = opts || {}, r = 15.5, C = 2 * Math.PI * r, st = item.status || "";
    const hue = (ST[st] && ST[st].color) || "var(--st-idle)";
    const color = o.neutral ? "color-mix(in srgb,var(--muted) 70%,transparent)" : hue;
    const svgAttrs = (extra?: string) => `class="ring" data-testid="ring"${extra || ""} viewBox="0 0 36 36" style="width:${size}px;height:${size}px"`;
    const wrap2 = (inner: string, track?: boolean, extra?: string) => `<svg ${svgAttrs(extra)}>${track ? `<circle class="ring-track" cx="18" cy="18" r="${r}"/>` : ""}${inner}</svg>`;
    if (item._evaluating) return `<svg ${svgAttrs()}><circle class="ring-track eval" cx="18" cy="18" r="${r}"/></svg>`;
    if (st === "merge") return wrap2(`<circle class="ring-fill" cx="18" cy="18" r="${r}" stroke="${color}" stroke-dasharray="${C} ${C}" stroke-dashoffset="0" transform="rotate(-90 18 18)"/><text class="ring-gly" x="18" y="22.5" text-anchor="middle" fill="${color}">✓</text>`, true, ` data-percent="100" data-asterisk="0"`);
    if (st === "loop" || item.loop) { // an autonomous loop is just "running" (cyan ∞); no live alarm
      return wrap2(`<circle class="ring-dot" cx="18" cy="18" r="${r}" style="stroke:color-mix(in srgb,var(--st-run) 55%,transparent)"/><text class="ring-gly" x="18" y="22.8" text-anchor="middle" fill="${color}">∞</text>`, true);
    }
    if (st === "queued" || st === "planned") return wrap2(`<circle class="ring-dot" cx="18" cy="18" r="${r}"/><text class="ring-gly" x="18" y="22.6" text-anchor="middle" fill="var(--st-idle)">·</text>`, true);
    if (item._sessGauge) {
      const g = item._sessGauge;
      return wrap2(`${segArcs(g.done, g.total, 0, g.percent, "color-mix(in srgb,var(--muted) 78%,transparent)")}${ringShape(st, o.neutral ? color : hue)}<text class="ring-num" x="18" y="22.2" text-anchor="middle" font-size="9">${g.done}/${g.total}</text>`, false, ` data-percent="${g.percent}" data-asterisk="0"`);
    }
    const prog = item._prog;
    if (st === "unset" || !prog || (prog.total === 0 && !prog.unrun)) return wrap2(`<circle class="ring-dot" cx="18" cy="18" r="${r}" style="stroke:color-mix(in srgb,var(--st-sign) 55%,transparent)"/><text class="ring-gly" x="18" y="22.5" text-anchor="middle" fill="var(--st-sign)">?</text>`, true);
    const showFrac = prog.unrun > 0 || prog.stale > 0;
    const numTxt = `${prog.met}/${prog.total}${showFrac ? "*" : ""}`;
    const numFill = showFrac ? "color-mix(in srgb,var(--muted) 88%,transparent)" : (o.neutral ? color : "var(--text)");
    const tip = `<title>${prog.percent}% · ${prog.met} of ${prog.total} criteria met${prog.unrun ? ` · ${prog.unrun} not yet run` : ""}${prog.stale ? ` · ${prog.stale} stale` : ""}</title>`;
    return wrap2(`${tip}${segArcs(prog.met, prog.total, prog.unrun || 0, prog.percent, color)}${ringShape(st, o.neutral ? color : hue)}<text class="ring-num" x="18" y="22.3" text-anchor="middle" font-size="9" fill="${numFill}">${numTxt}</text>`, false, ` data-percent="${prog.percent}" data-asterisk="${showFrac ? "1" : "0"}"`);
  }

  function badge(status: string, soft?: boolean) {
    const m = ST[status]; if (!m) return "";
    if (status === "block" && soft) return `<span class="badge idle"><span class="d"></span>Idle · may be waiting</span>`;
    return `<span class="badge ${m.cls}"><span class="d"></span>${m.label}</span>`;
  }
  function srcTag(src?: string) { return `<span class="srcTag" title="DoD source: ${esc(src)}">${esc(src)}</span>`; }
  function dodInline(dod?: string, src?: string) { return `${esc(dod)} ${srcTag(src)}`; }

  // dot-strip: one shape-coded dot per workstream (compact rows + onboarding only, #15), capped (#6)
  function dotStrip(p: VProject) {
    const DCAP = 12, ws = p.workstreams, shown = ws.slice(0, DCAP), extra = ws.length - shown.length;
    const dots = shown.map((w) => {
      const cls = ST[w.status] ? ST[w.status].cls : "idle";
      return `<span class="d ${cls}" title="${esc(w.name)} · ${esc((ST[w.status] || {}).label || w.status)}"></span>`;
    }).join("");
    const tail = extra > 0 ? `<span class="dot-more" title="${extra} more workstream${extra > 1 ? "s" : ""} — full list below">+${extra}</span>` : "";
    return `<span class="dotstrip">${dots}${tail}</span>`;
  }

  // per-project counts
  function projNeeds(p: VProject) {
    let you = 0, fail = 0, sign = 0, run = 0;
    p.workstreams.forEach((w) => w.sessions.forEach((s) => {
      if (s.status === "block" && (s.elicited || s.gitBlocked)) you++;
      if (s.status === "fail") fail++;
      if (s.status === "sign") sign++;
      if (s.status === "run" || s.status === "loop") run++;
    }));
    return { you, fail, sign, run };
  }
  function allUnset(p: VProject) { let any = false; for (const w of p.workstreams) for (const s of w.sessions) { any = true; if (s.status !== "unset") return false; } return any; }
  function pClass(p: VProject) { const c = projNeeds(p); if (c.you || c.fail) return "attn"; if (c.run) return "active"; if (c.sign) return "signoff"; if (allUnset(p)) return "needsSetup"; return "calm"; }
  function cardBlast(p: VProject) { let best = "lo"; p.workstreams.forEach((w) => w.sessions.forEach((s) => { if (isNeed(s)) { const b = blastRadius(s); if (blastRank(b) < blastRank(best)) best = b; } })); return best; }
  function firstSessId(p: VProject, statuses: string[]) { for (const w of p.workstreams) for (const s of w.sessions) if (statuses.includes(s.status)) return s.id; return null; }

  // representative live one-liner (#A): surface the HIGHEST-priority state first and point UP when blocking
  function cardLive(p: VProject): CardLive {
    let top: VSession | null = null, topW: VWorkstream | null = null, topRank = 99;
    p.workstreams.forEach((w) => w.sessions.forEach((s) => {
      const rk = statusRank(s.status);
      if (rk < topRank) { topRank = rk; top = s; topW = w; }
    }));
    if (!top || !topW) return { tone: "calm", loop: false, txt: "All quiet.", id: null };
    const t: VSession = top, w: VWorkstream = topW;
    const st = t.status, wn = shortWs(w.name);
    if (isSoftWaitV(t)) return { tone: "calm", loop: false, txt: `${wn} went idle — may be waiting, or may have finished`, id: t.id };
    if (st === "block") return { tone: "block", loop: false, pointUp: "sec-needs", txt: t.gitBlocked ? `${wn} has a git conflict — resolve to continue` : `${wn} needs your input — ${t.live}`, id: t.id };
    if (st === "fail") return { tone: "fail", loop: false, pointUp: "sec-needs", txt: `${wn} failed — ${t.live}`, id: t.id };
    if (st === "run" || st === "loop") {
      const qd = (st === "loop" && t.queueTotal != null) ? { total: t.queueTotal } : null;
      return { tone: st === "loop" ? "loop" : "run", loop: st === "loop", txt: t.live || "", id: t.id, qDelta: qd };
    }
    if (st === "sign") return { tone: "sign", loop: false, pointUp: "sec-signoff", txt: `${wn} is done per its DoD — sign off above`, id: t.id };
    if (st === "unset") return { tone: "calm", loop: false, txt: `${wn} — no Definition of Done set yet`, id: t.id, unset: true };
    if (st === "queued" || st === "planned") return { tone: "calm", loop: false, txt: t.live || "", id: t.id };
    return { tone: "calm", loop: false, txt: "All work merged. Nothing pending.", id: t.id };
  }
  // wsDone / wsOpenEnded / wsUnscorable are NO LONGER the project gauge — the displayed
  // project ring percent now comes straight from the server `p._prog` (rollup.ts
  // projectProgress) so the client never re-derives a shown percent (review finding). They
  // survive ONLY as the `longPole` spotlight heuristic (which one workstream to call out as
  // the bottleneck) — a cosmetic pick, never a number rendered as truth.
  function wsDone(w: VWorkstream) { return w.status === "merge" || w.status === "sign" || !!(w._prog && w._prog.allMet) || !!(w._sessGauge && w._sessGauge.total > 0 && w._sessGauge.done === w._sessGauge.total); }
  function wsOpenEnded(w: VWorkstream) { return w.status === "loop" || !!w.loop; }
  function wsEmptyDod(w: VWorkstream) {
    if (w.status === "merge" || w.status === "sign") return false;
    if (w._mixed) return false;
    return !w._prog;
  }
  function wsUnscorable(w: VWorkstream) { return wsOpenEnded(w) || wsEmptyDod(w); }
  function longPole(p: VProject): VWorkstream | null {
    const closed = p.workstreams.filter((w) => !wsUnscorable(w));
    const order = closed.slice().sort((a, b) => byAttention(a, b) || ((a._prog ? a._prog.percent : 0) - (b._prog ? b._prog.percent : 0)));
    return order.find((w) => !wsDone(w)) || order[order.length - 1] || null;
  }

  // ─────────────────────────── icons ───────────────────────────
  const continueIcon = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-6A8.4 8.4 0 1 1 21 11.5Z"/></svg>`;
  const chevIcon = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="14" height="14"><path d="m9 6 6 6-6 6"/></svg>`;
  const plusIcon = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>`;
  const focusIcon = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>`;
  const recheckIcon = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>`;
  const closeIcon = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="14" height="14"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  const kebabIcon = () => `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`;

  // ─────────────────────────── per-workstream lifecycle menu (M3) ───────────────────────────
  // A kebab (⋯) on every workstream row + card header opens a small menu with the full
  // lifecycle: Mark done / Archive / Cancel (abandon) / Delete — all driven from the UI
  // (operability lens), wired in dashboard.ts to the REAL PATCH/DELETE registry routes.
  // The menu is data-attribute-only (the delegated click handler in dashboard.ts reads
  // `data-wsaction` + `data-wsid`); it carries no inline handlers. Destructive verbs
  // (Cancel/Delete) get a confirm + (for Delete) an undo toast in the controller.
  //
  // `inactive` (archived/abandoned) rows flip the menu to restore-oriented verbs: Restore
  // (un-archive / re-open) + Delete — Mark done / Archive / Cancel are meaningless on
  // already-shelved work, so they're hidden to keep the menu honest.
  function wsMenu(w: VWorkstream): string {
    // The synthetic Unfiled bucket has no stored workstream to act on — no lifecycle menu.
    if (w._synthetic) return "";
    const id = esc(w.id);
    const item = (action: string, label: string, danger?: boolean) =>
      `<button class="wsmenu-item${danger ? " danger" : ""}" type="button" data-wsaction="${action}" data-wsid="${id}" role="menuitem">${esc(label)}</button>`;
    let items: string;
    if (w._inactive) {
      const restoreLabel = w._itemStatus === "abandoned" ? "Re-open workstream" : "Restore from archive";
      items = item("restore", restoreLabel) + item("delete", "Delete permanently…", true);
    } else {
      const markDone = w._itemStatus === "done" ? "" : item("done", "Mark done");
      items = markDone
        + item("archive", "Archive")
        + item("cancel", "Cancel — no longer relevant…", true)
        + item("delete", "Delete…", true);
    }
    return `<div class="wsmenu" data-wsmenu="${id}">
      <button class="wskebab" type="button" data-wsmenu-toggle="${id}" aria-haspopup="menu" aria-expanded="false" title="Workstream actions" aria-label="Workstream actions">${kebabIcon()}</button>
      <div class="wsmenu-pop" role="menu" hidden>${items}</div>
    </div>`;
  }

  // ── project-level lifecycle menu (operability lens) ──────────────────────────
  // A per-project kebab mirroring wsMenu: Rename / Archive / Delete, all data-attribute-only
  // (the delegated handler reads `data-projaction` + `data-projid`). Destructive verbs confirm
  // + (Delete) offer an Undo in the controller. The synthetic Unfiled project (if any) carries
  // no registry id to act on — but it never reaches a card header, so no guard needed here.
  function projMenu(p: VProject): string {
    const id = esc(p.id);
    const item = (action: string, label: string, danger?: boolean) =>
      `<button class="projmenu-item${danger ? " danger" : ""}" type="button" data-projaction="${action}" data-projid="${id}" role="menuitem">${esc(label)}</button>`;
    // "New workstream…" gives every project — including a freshly-registered zero-session
    // folder — a session-independent path to create a workstream and author its DoD from the
    // UI (operability lens). Without it, a project with no sessions has no create affordance.
    const items = item("newws", "New workstream…") + item("rename", "Rename…") + item("archive", "Archive") + item("delete", "Delete…", true);
    return `<div class="projmenu" data-projmenu="${id}">
      <button class="projkebab" type="button" data-projmenu-toggle="${id}" aria-haspopup="menu" aria-expanded="false" title="Project actions" aria-label="Project actions">${kebabIcon()}</button>
      <div class="projmenu-pop" role="menu" hidden>${items}</div>
    </div>`;
  }

  // ═══════════════════════════ master render ═══════════════════════════
  function renderAll(sc?: { empty?: boolean; candidates?: number }) {
    const scn = sc || {};
    if (scn.empty) { wrap.innerHTML = onboardHtml(scn.candidates || 0); bindOnboard(); return; }

    const counts = fleetCounts();
    state._pingId = (function () {
      let best: string | null = null, rk = 99;
      activeSess().forEach(({ s }) => { if (s.status === "run" || s.status === "loop") { const r = statusRank(s.status); if (r < rk) { rk = r; best = s.id; } } });
      return best;
    })();
    wrap.innerHTML = `
      <section class="hero">${heroHtml(counts)}<div class="rail" id="rail"></div></section>
      ${needsSectionHtml(counts)}
      ${signoffSectionHtml(counts)}
      ${projectsSectionHtml(counts)}
      ${plannedSectionHtml(counts)}
      ${doneSectionHtml(counts)}
      ${archivedSectionHtml()}
      ${tailNoteHtml(counts)}
    `;
    renderRail(counts);
    renderNeeds();
    renderSignoff();
    renderGrid(counts);
    renderPlanned();
    renderDone();
    renderArchived();
  }

  // ─────────────────────────── archived / abandoned surface (M3) ───────────────────────────
  // A separate COLLAPSED surface for archived + abandoned workstreams: excluded from every
  // active count, the gauge, the long-pole and the fleet hero (the adapter already split
  // them off into `p.archivedWorkstreams`). Each row carries Restore + Delete so a shelved
  // workstream is fully recoverable from the UI (full-lifecycle lens). Collapsed by default
  // so it never competes with live work for attention.
  function archivedRows(): Array<{ w: VWorkstream; p: VProject }> {
    const rows: Array<{ w: VWorkstream; p: VProject }> = [];
    state.data.forEach((p) => (p.archivedWorkstreams || []).forEach((w) => rows.push({ w, p })));
    return rows;
  }
  function archivedSectionHtml(): string {
    if (!archivedRows().length) return "";
    return `<section class="done archived" id="sec-archived" data-testid="archived" style="margin-top:32px"></section>`;
  }
  function renderArchived() {
    const host = document.getElementById("sec-archived"); if (!host) return;
    const rows = archivedRows();
    if (!rows.length) { host.innerHTML = ""; return; }
    const abandoned = rows.filter(({ w }) => w._itemStatus === "abandoned").length;
    const archived = rows.length - abandoned;
    const sumBits: string[] = [];
    if (archived) sumBits.push(`${archived} archived`);
    if (abandoned) sumBits.push(`${abandoned} cancelled`);
    const row = ({ w, p }: { w: VWorkstream; p: VProject }) => {
      const sessN = w.sessions.length;
      const why = w._itemStatus === "abandoned"
        ? `<span class="badge idle"><span class="d"></span>Cancelled · no longer relevant</span>`
        : `<span class="badge idle"><span class="d"></span>Archived</span>`;
      const restoreLabel = w._itemStatus === "abandoned" ? "Re-open" : "Restore";
      return `<div class="drow archrow" data-ws-id="${esc(w.id)}">
        <div class="dleft">
          <div class="dcrumb"><b>${esc(p.name)}</b>${p.nest ? ` <span class="nest">⤷ ${esc(p.nest)}</span>` : ""} › ${esc(w.name)}</div>
          <div class="dname">${esc(w.name)} ${why}</div>
          <div class="dnote">${sessN} session${sessN === 1 ? "" : "s"} · excluded from the project gauge &amp; active counts · last DoD: ${dodInline(w.dod || "none set", w.dodSrc)}</div>
        </div>
        <div class="sess-act">
          <button class="btn ghost sm" type="button" data-wsaction="restore" data-wsid="${esc(w.id)}" title="Bring this workstream back into the active grid">${restoreLabel}</button>
          <button class="btn ghost sm danger" type="button" data-wsaction="delete" data-wsid="${esc(w.id)}" title="Permanently delete this workstream + its Definition of Done">Delete</button>
        </div>
      </div>`;
    };
    const CAP = 6, shown = rows.slice(0, CAP), extra = rows.slice(CAP);
    host.innerHTML = `
      <div class="done-head" data-toggle="done">
        <div class="done-title">⦸ Archived</div>
        <div class="done-sum"><b>${rows.length} shelved workstream${rows.length === 1 ? "" : "s"}</b> — ${esc(sumBits.join(" · "))} · out of the active gauge &amp; counts</div>
        <span class="chev">${chevIcon()}</span>
      </div>
      <div class="done-body">
        <div class="done-grp"><div class="done-grp-h"><span class="sw"></span> Shelved · ${rows.length}</div>
          ${shown.map(row).join("")}${extra.length ? `<div class="more-rows" hidden>${extra.map(row).join("")}</div><button class="morelink" data-toggle="more">+${extra.length} more — show all</button>` : ""}</div>
      </div>`;
  }

  // FLEET-LEVEL session iteration must exclude sessions inside archived/abandoned
  // workstreams. The adapter deliberately indexes BOTH active and archived workstreams'
  // sessions into state.SESS so archived rows stay reachable for restore/delete, but the
  // server keeps each shelved session's derived per-session status (sign/block/fail/merge)
  // — only the workstream's counts.abandoned is re-tallied. Without this filter a 'sign'
  // session inside a Cancelled workstream still inflates the hero "N need you", the Sign-off
  // list, Needs-you triage, the Merged delta and the running/loop pings, even though its
  // card correctly left the active grid. Per-PROJECT functions are safe because they iterate
  // the pre-filtered p.workstreams; only these SESS-iterating fleet functions need the guard.
  // renderArchived / contextBand / recheck lookups that legitimately need archived rows keep
  // reading state.SESS directly.
  function activeSess(): Array<{ s: VSession; w: VWorkstream; p: VProject }> {
    return Object.values(state.SESS).filter(({ w }) => !w._inactive);
  }

  function dormantIds() { return new Set(state.data.filter((p) => pClass(p) === "calm").map((p) => p.id)); }
  function setupIds() { return new Set(state.data.filter((p) => pClass(p) === "needsSetup").map((p) => p.id)); }

  function fleetCounts(): Counts {
    const c: Counts = { run: 0, loop: 0, block: 0, softwait: 0, sign: 0, plan: 0, merge: 0, fail: 0, unset: 0, total: 0, projects: state.data.length, active: 0, needs: 0, healthy: 0, setup: 0 };
    const dorm = dormantIds();
    activeSess().forEach(({ s, p }) => {
      c.total++;
      const inDorm = dorm.has(p.id);
      if (s.status === "run") c.run++;
      else if (s.status === "loop") c.loop++;
      else if (s.status === "block") { if (s.elicited || s.gitBlocked) c.block++; else c.softwait++; }
      else if (s.status === "sign") c.sign++;
      else if (s.status === "queued" || s.status === "planned") { if (!inDorm) c.plan++; }
      else if (s.status === "merge") { if (!inDorm) c.merge++; }
      else if (s.status === "fail") c.fail++;
      else if (s.status === "unset") c.unset++;
    });
    c.active = c.run + c.loop;
    c.needs = c.block + c.fail;
    c.healthy = dorm.size;
    c.setup = setupIds().size;
    return c;
  }

  const NEEDS_LOUD = 12;
  function needsOverflow(c: Counts): { n: number; dominant: { cause: string; n: number } | null } | null {
    if (c.needs < NEEDS_LOUD) return null;
    const tally: Record<string, number> = {};
    activeSess().forEach(({ s }) => {
      if (!isNeed(s)) return;
      const cause = (s.failAction || "").trim();
      if (cause) { tally[cause] = (tally[cause] || 0) + 1; }
    });
    let top: string | null = null, topN = 0;
    Object.keys(tally).forEach((k) => { if (tally[k] > topN) { topN = tally[k]; top = k; } });
    const dominant = (top && topN >= Math.ceil(c.needs * 0.55)) ? { cause: top, n: topN } : null;
    return { n: c.needs, dominant };
  }

  const fmtN = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
  function fleetDelta() {
    let merges = 0, add = 0, del = 0, blocked = 0;
    const visitMin = agoToMin(state.lastVisit || "");
    const sinceVisit = (ago?: string) => { const m = agoToMin(ago); return m < 1e9 && m <= visitMin; };
    activeSess().forEach(({ s, w }) => {
      if (s.status === "merge" && sinceVisit((s.artifact && s.artifact.mergedAgo) || (w && w.mergedAgo) || "")) {
        merges++; if (s.artifact) { add += s.artifact.add || 0; del += s.artifact.del || 0; }
      }
      if (s.status === "block" && (s.elicited || s.gitBlocked) && sinceVisit(s.meta)) blocked++;
    });
    return { merges, add, del, blocked, since: state.lastVisit };
  }
  function deltaClause(needs: number) {
    // No persisted last-visit baseline → no "since you last looked" delta. Without this
    // guard a null baseline degrades to agoToMin("")=1e9 and counts every merged item
    // all-time, not since the last visit (review finding). dashboard.ts persists the
    // baseline so the clause lights up correctly on the second and later visits.
    if (!state.lastVisit) return "";
    const d = fleetDelta();
    const frags: string[] = [];
    if (d.merges) {
      const net = (d.add || d.del) ? ` <span class="dnums">+${fmtN(d.add)}/−${fmtN(d.del)} lines</span>` : "";
      const tip = (d.add || d.del) ? "net git numstat over commits merged since your last visit" : "merged since your last visit";
      frags.push(`<a data-jump="sec-done" title="${esc(tip)}"><b>+${d.merges}</b> merged${net}</a>`);
    }
    if (d.blocked && !needs) frags.push(`<a data-jump="sec-needs"><b>${d.blocked}</b> newly blocked</a>`);
    if (!frags.length) return "";
    const head = d.since ? `Since you last looked <b>${esc(d.since)}</b>` : `Recent activity`;
    return `<span class="delta">${head}: ${frags.join('<span class="sep">·</span> ')}.</span>`;
  }

  function wsLoopMinutes(w: VWorkstream) { let best = 0; (w.sessions || []).forEach((s) => { if (s.loop) { const m = loopMinutes(s); if (m > best) best = m; } }); return best; }
  function longestLoop(): { min: number; label: string } | null {
    let best: { min: number; label: string } | null = null;
    activeSess().forEach(({ s }) => { if (s.loop) { const min = loopMinutes(s); if (!best || min > best.min) best = { min, label: fmtMin(min) }; } });
    return best;
  }
  const CLOSE_TAB_LOOP_MIN = 45;

  // ─────────────────────────── hero ───────────────────────────
  function heroHtml(c: Counts) {
    const now = new Date();
    const day = `${now.toLocaleDateString(undefined, { weekday: "long" })} · ${now.getDate()} ${now.toLocaleDateString(undefined, { month: "short" })}`;
    const maybe = c.softwait ? `<span class="maybe" title="non-elicited idle stops — pi can't PROVE these are blocked, so they're a quiet tally, never inside the 'things need you' count."><b>${c.softwait}</b> may be waiting</span>` : "";
    const softLine = c.softwait ? `<div class="softline"><span class="dot"></span>${maybe} — pi can't prove these are blocked (free-text stops, not structured asks)<button class="swjump" data-jump="sec-proj">review idle work →</button></div>` : "";
    if (c.needs === 0) {
      const bits: string[] = [];
      if (c.loop) bits.push(`${c.loop} loop${c.loop > 1 ? "s" : ""} running`);
      if (c.run) bits.push(`${c.run} task${c.run > 1 ? "s" : ""} running`);
      const runTxt = bits.length ? bits.join(" · ") : "nothing running";
      let headline: string; const subBits: string[] = [];
      if (c.sign) {
        headline = `<em class="sign">${c.sign} done</em> — review below.`;
        if (c.loop) subBits.push(`<b>${c.loop} loop${c.loop > 1 ? "s" : ""}</b> running`);
        if (c.run) subBits.push(`<b>${c.run} running</b>`);
      } else if (c.setup) {
        headline = `<em class="setup">${c.setup} project${c.setup > 1 ? "s" : ""} need${c.setup > 1 ? "" : "s"} setup</em> — author a Definition of Done to start tracking.`;
        if (c.loop) subBits.push(`<b>${c.loop} loop${c.loop > 1 ? "s" : ""}</b> running`);
        if (c.run) subBits.push(`<b>${c.run} running</b>`);
      } else {
        headline = `<em class="calm">Nothing needs you.</em> ${esc(runTxt)}, everything else can wait.`;
      }
      if (c.plan) subBits.push(`<b>${c.plan} planned</b>`);
      let closeTab = "";
      if (c.sign === 0 && c.needs === 0 && !c.softwait && !c.setup) {
        const ll = longestLoop();
        closeTab = (ll && ll.min >= CLOSE_TAB_LOOP_MIN) ? ` Longest loop running <b>${esc(ll.label)}</b>.` : " You can close this tab.";
      } else if (c.setup && c.sign === 0 && c.needs === 0 && !c.softwait) {
        closeTab = ` <button class="hero-setup-cta" data-jump="sec-setup">Set a Definition of Done →</button>`;
      }
      const dc = deltaClause(c.needs);
      return `<div class="eyebrow">${day} · everything in one quiet view</div>
        <h1 class="headline">${headline}</h1>
        <p class="subline">${subBits.join(" · ")}${subBits.length && !(dc && !closeTab) ? "." : ""}${closeTab}${dc}</p>${softLine}`;
    }
    const subBits: string[] = [];
    if (c.active) {
      const runProjects = state.data.filter((p) => projNeeds(p).run > 0);
      const activeProjects = runProjects.length;
      subBits.push(activeProjects === 1
        ? `<b>${c.active} running</b> in ${esc(runProjects[0].name)}`
        : `<b>${c.active} running</b> across ${activeProjects} active projects`);
    }
    const dc = deltaClause(c.needs);
    const ov = needsOverflow(c);
    let needHeadline: string;
    if (ov) {
      const causeClause = ov.dominant
        ? ` — most (<b>${ov.dominant.n}</b>) clear with one fix: <b>${esc(ov.dominant.cause)}</b>.`
        : `, but they can wait their turn.`;
      needHeadline = `<em>A lot needs you</em> — <b>${ov.n}</b> items${causeClause}`;
    } else {
      needHeadline = `<em>${c.needs} ${c.needs === 1 ? "thing needs" : "things need"} you.</em> Everything else can wait.`;
    }
    return `<div class="eyebrow">${day} · everything in one quiet view</div>
      <h1 class="headline">${needHeadline}</h1>
      <p class="subline">${subBits.join(" · ")}${subBits.length && !dc ? "." : ""}${dc}</p>${softLine}`;
  }

  // ─────────────────────────── tally rail (jump-links) ───────────────────────────
  function renderRail(c: Counts) {
    const railEl = document.getElementById("rail"); if (!railEl) return;
    const pills: Array<[string, string, number | string, string, boolean]> = [];
    const calm = c.needs === 0;
    if (c.sign) pills.push(["sign", "Sign-off", c.sign, "sec-signoff", true]);
    if (c.active) pills.push(["", "Running", calm ? "" : c.active, "sec-proj", false]);
    if (c.plan) pills.push(["", "Planned", c.plan, "sec-planned", false]);
    if (c.merge) pills.push(["", "Merged", calm ? "" : c.merge, "sec-done", false]);
    if (c.setup) pills.push(["setup", "Needs setup", c.setup, "sec-setup", true]);
    if (c.healthy) pills.push(["", `Healthy · ${c.healthy} project${c.healthy > 1 ? "s" : ""}`, "", "sec-healthy", false]);
    if (!pills.length && c.needs === 0 && !c.setup) pills.push(["", "Everything healthy — nothing needs you", "", "sec-proj", false]);
    railEl.innerHTML = pills.map(([cl, l, n, j, sw]) =>
      `<button class="pill ${cl}" data-jump="${j}">${sw ? '<span class="sw"></span>' : ""}${l}${n !== "" ? ` <span class="n">${n}</span>` : ""}</button>`).join("");
  }

  // ─────────────────────────── needs you (4 bands, #14) ───────────────────────────
  function needsSectionHtml(c: Counts) {
    if (c.needs === 0) return "";
    const focusBtn = c.needs > 2 ? `<button class="hbtn" id="focusBtn"${deferTip("Triage-all")}>${focusIcon()} Triage all in focus</button>` : `<span class="hint">answer inline — your reply continues the conversation</span>`;
    return `<div class="shead" id="sec-needs"><h2>Needs you</h2>${focusBtn}</div>
      <section class="needs${c.needs === 1 ? " single" : ""}" id="needs" data-testid="needs-you"></section>`;
  }
  function renderNeeds() {
    const host = document.getElementById("needs"); if (!host) return;
    const items: Array<{ s: VSession; w: VWorkstream; p: VProject }> = [];
    activeSess().forEach(({ s, w, p }) => { if (isNeed(s)) items.push({ s, w, p }); });
    items.sort((a, b) => blastRank(blastRadius(a.s)) - blastRank(blastRadius(b.s))
      || (agoToMin(b.s.meta) - agoToMin(a.s.meta))
      || ((a.s.status === "block" ? 0 : 1) - (b.s.status === "block" ? 0 : 1))
      || String(a.s.id).localeCompare(String(b.s.id)));
    const top = items.slice(0, 2);
    const rest = items.slice(2);
    let html = top.map(({ s, w, p }) => {
      const cls = s.status === "block" ? "block" : "fail";
      const blast = blastRadius(s);
      const soft = isSoftWaitV(s);
      const statusBadge = s.status === "fail" ? badge("fail") : badge("block", soft);
      const blastTag = (blast === "hi" || blast === "md") ? `<span class="blast ${cls}" title="Blast radius is a HEURISTIC triage hint. It only ORDERS Needs-you; it gates nothing.">${blastLabel(blast)}</span>` : "";
      const wait = waitLabel(s);
      const waitTag = wait ? `<span class="waitage" title="time since the agent went idle waiting on you">waiting ${wait}</span>` : "";
      const headTag = `${statusBadge} ${blastTag} ${waitTag}`;
      let chips = "";
      if (s.elicited && s.chips && s.chips.length) {
        chips = `<div class="qreply"><span class="qlbl">quick reply →</span>` + s.chips.map((q) => `<button data-reply="${s.id}" data-text="${esc(q)}"${deferTip("Quick reply")}>${esc(q)}</button>`).join("") + `</div>`;
      }
      const askHtml = soft
        ? `<span style="color:var(--muted)">No structured question — pi went idle (${esc(s.meta || "a while ago")}), unread. It may be waiting on you, or may simply have finished. Open to read its last message.</span>`
        : esc(s.live);
      let actions: string;
      if (s.status === "fail") {
        const remedy = esc(s.failAction || "Re-run");
        if (!chips) {
          chips = `<div class="qreply"><span class="qlbl">quick reply →</span><button data-reply="${s.id}" data-text="${remedy}"${deferTip("Quick reply")}>${remedy}</button></div>`;
        }
        actions = `<button class="btn primary" data-open="${s.id}">${continueIcon()} Continue the conversation</button>`;
      } else {
        actions = `<button class="btn primary" data-open="${s.id}">${continueIcon()} ${soft ? "Open conversation" : "Continue the conversation"}</button>`;
      }
      return `<article class="need ${cls}">
        <div class="crumb"><b>${esc(p.name)}</b> &nbsp;›&nbsp; ${esc(w.name)}</div>
        <div class="sname"><span class="nm">${esc(s.name)}</span> ${headTag}</div>
        <div class="ask">${askHtml}</div>
        ${chips}
        <div class="actions">
          ${actions}
        </div>
      </article>`;
    }).join("");
    if (rest.length) {
      const needRow = ({ s, w, p }: { s: VSession; w: VWorkstream; p: VProject }) => {
        const blast = blastRadius(s);
        const blastTag = (blast === "hi" || blast === "md") ? `<span class="blast ${s.status === "fail" ? "fail" : "block"}" title="Blast radius is a HEURISTIC triage hint. It only orders Needs-you; it gates nothing.">${blast === "hi" ? "high" : "elevated"}</span>` : "";
        const wait = waitLabel(s); const waitTag = wait ? `<span class="waitage">waiting ${wait}</span>` : "";
        let rowChips = (s.elicited && s.chips && s.chips.length)
          ? `<div class="qreply rowqreply"><span class="qlbl">quick reply →</span>` + s.chips.map((q) => `<button data-reply="${s.id}" data-text="${esc(q)}"${deferTip("Quick reply")}>${esc(q)}</button>`).join("") + `</div>`
          : "";
        if (s.status === "fail" && !rowChips) {
          const rRemedy = esc(s.failAction || "Re-run");
          rowChips = `<div class="qreply rowqreply"><span class="qlbl">quick reply →</span><button data-reply="${s.id}" data-text="${rRemedy}"${deferTip("Quick reply")}>${rRemedy}</button></div>`;
        }
        const rowBtn = `<button class="btn primary sm" data-open="${s.id}">${continueIcon()} Continue</button>`;
        const hay = esc(`${p.name} ${w.name} ${s.name} ${s.live || ""}`.toLowerCase());
        return `<div class="needrow" id="needrow-${esc(s.id)}" data-needfilter="${hay}">
          <span class="sess-dot ${(ST[s.status] || {}).cls || "idle"}" style="background:${(ST[s.status] || {}).color}"></span>
          <div class="nleft">
            <div class="ncrumb"><b>${esc(p.name)}</b> › ${esc(w.name)} ${blastTag}${waitTag}</div>
            <div class="nq">${esc(s.live)}</div>
            ${rowChips}
          </div>
          ${rowBtn}
        </div>`;
      };
      const RCAP = 6, rShown = rest.slice(0, RCAP), rExtra = rest.slice(RCAP);
      const JUMP_MIN = 8;
      const jumpBox = rest.length >= JUMP_MIN
        ? `<input class="needjump" type="search" placeholder="jump to item — filter ${rest.length} by project / workstream / name" aria-label="jump to a blocked item">`
        : "";
      html += `<div class="needmore" id="needmore" style="grid-column:1/-1">
        <div class="needmore-h" data-toggle="needmore"><b>+${rest.length} more need you</b> — collapsed to stay calm; ordered by blast radius, then waiting time<span class="chev">${chevIcon()}</span></div>
        <div class="needmore-b">${jumpBox}<div class="needjump-empty" hidden>No matching item.</div>${rShown.map(needRow).join("")}${rExtra.length ? `<div class="more-rows" hidden>${rExtra.map(needRow).join("")}</div><button class="morelink" data-toggle="more">+${rExtra.length} more — show all</button>` : ""}</div>
      </div>`;
    }
    host.innerHTML = html;
  }
  function filterNeeds(inp: HTMLInputElement) {
    const w = inp.closest(".needmore-b"); if (!w) return;
    const q = String(inp.value || "").trim().toLowerCase();
    const tail = w.querySelector<HTMLElement>(".more-rows");
    const moreBtn = w.querySelector<HTMLElement>(".morelink");
    const empty = w.querySelector<HTMLElement>(".needjump-empty");
    const rows = Array.from(w.querySelectorAll<HTMLElement>(".needrow"));
    if (q) { if (tail) tail.hidden = false; if (moreBtn) moreBtn.style.display = "none"; }
    else { if (moreBtn) moreBtn.style.display = ""; }
    let shown = 0;
    rows.forEach((r) => { const hit = !q || (r.getAttribute("data-needfilter") || "").includes(q); r.style.display = hit ? "" : "none"; if (hit) shown++; });
    if (!q && tail) { tail.hidden = true; tail.querySelectorAll<HTMLElement>(".needrow").forEach((r) => { r.style.display = ""; }); }
    if (empty) empty.hidden = !(q && shown === 0);
  }

  // ─────────────────────────── sign-off — first-class to-do LIST ───────────────────────────
  function hasGitBranch(s: VSession) { return !!(s.artifact && s.artifact.branch && s.artifact.kind !== "doc"); }
  function branchOf(s: VSession) { return (s.artifact && s.artifact.branch) || ""; }
  function signoffSectionHtml(c: Counts) {
    if (!c.sign) return "";
    const batch = c.sign > 1
      ? `<button class="hbtn sgn" id="signAll"${deferTip("Sign off every clean item — sign-off is NOT merge")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="13" height="13"><path d="M20 6 9 17l-5-5"/></svg> Sign off all ${c.sign}</button>`
      : `<span class="hint">review each below — one-click sign-off, merge stays a separate step</span>`;
    const cnt = c.sign > 1 ? "" : `<span class="cnt">${c.sign} done</span>`;
    return `<div class="shead" id="sec-signoff"><h2>Awaiting your sign-off</h2>${cnt}${batch}</div>
      <section class="signoff" id="signoffHost" data-testid="signoff"></section>`;
  }
  function mergeAffordance(s: VSession) {
    // The merge button actually SENDS the merge prompt via POST /api/prompt (data-merge,
    // handled in dashboard.ts like a quick-reply chip) — the tooltip now matches what it
    // does instead of asserting a send the old data-open (open-only) button never made
    // (review honesty finding). Merge stays a SEPARATE step from sign-off.
    const br = branchOf(s);
    return hasGitBranch(s)
      ? `<button class="btn ghost sm" data-merge="${s.id}" data-branch="${esc(br)}">Ask pi to merge ${esc(br)} → main</button><span class="infg" title="Merge is a SEPARATE step — sends the agent the prompt &quot;merge ${esc(br)} into main&quot; via /api/prompt, then opens the conversation so you can watch it land.">i</span>`
      : `<button class="btn ghost sm" data-open="${s.id}">Archive</button>`;
  }
  function renderSignoff() {
    const host = document.getElementById("signoffHost"); if (!host) return;
    const items: Array<{ s: VSession; w: VWorkstream; p: VProject }> = [];
    activeSess().forEach(({ s, w, p }) => { if (s.status === "sign") items.push({ s, w, p }); });
    const CAP = 3, shown = items.slice(0, CAP), rest = items.slice(CAP);
    const rowHtml = ({ s, w, p }: { s: VSession; w: VWorkstream; p: VProject }) => {
      const gate = s._gate, gone = !!state.signed[s.id], pending = signPending(s);
      // S5 DOM contract: data-signoff carries the GATE CRITERION id (what S7 PATCHes via
      // /api/dod/criterion/:id), not the session id. data-recheckcard stays the session id
      // (the recheck handler resolves the stale criterion via SESS[id]._gate).
      const critId = gate?.id ?? "";
      const lineage = p.nest ? ` <span class="nest" title="own project root nested inside its parent — not counted toward the parent">⤷ ${esc(p.nest)}</span>` : "";
      const crit = pending
        ? `<span class="pend">Done — pending recheck</span> · ${esc((gate && gate.text) || s.dod)} ${srcTag(s.dodSrc)}`
        : `Done per its DoD — <span class="gk">${esc((gate && gate.text) || s.dod)}</span> ${srcTag(s.dodSrc)}`;
      const act = gone
        ? `<span style="color:var(--st-merge);font-weight:650">✓ Signed off</span>${mergeAffordance(s)}`
        : pending
          // Stale/unrun command evidence can't back a sign-off promotion — offer the on-demand
          // re-check (the /api/dod/evaluate stub this slice) before the gate can flip.
          ? `<button class="btn remedy sm" data-recheckcard="${s.id}" title="command DoD evidence is stale — re-run it on demand">${recheckIcon()} Re-check</button><button class="btn ghost sm" data-open="${s.id}">Review</button>`
          // Sign-off is now a LIVE one-click control (optimistic PATCH of the gate criterion);
          // Review (the read action) stays beside it. Sign-off is NEVER fused with merge.
          // "Cancel — no longer relevant" abandons the owning workstream (PATCH status:
          // "abandoned", confirm) — a first-class lifecycle exit beside sign-off (M3): a
          // done-per-DoD item the user has decided to shelve rather than ship.
          : `<button class="btn sign sm" data-signoff="${esc(critId)}"${deferTip("Sign off — merge stays a separate step")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg> Sign off</button><button class="btn ghost sm" data-open="${s.id}">Review</button>${w._synthetic ? "" : `<button class="btn ghost danger sm wscancel" data-wscancel="${esc(w.id)}" title="No longer relevant — abandon this whole workstream instead of signing it off (it moves to Archived, out of active counts)">Not relevant</button>`}`;
      return `<article class="soff ${gone ? "gone" : ""}">
        <div class="sleft">
          <div class="scrumb"><b>${esc(p.name)}</b>${lineage} › ${esc(w.name)} · <span class="sn">${esc(s.name)}</span></div>
          <div class="scrit">${crit}${s.artifact ? ` <span style="opacity:.45">·</span> ${artChip(s)}` : ""}</div>
        </div>
        <div class="sact">${act}</div>
      </article>`;
    };
    let html = shown.map(rowHtml).join("");
    if (rest.length) {
      html += `<div class="needmore" id="signmore"><div class="needmore-h" data-toggle="needmore"><b>+${rest.length} more to sign off</b> — collapsed to keep the fold tight<span class="chev">${chevIcon()}</span></div>
        <div class="needmore-b">${rest.map(rowHtml).join("")}</div></div>`;
    }
    host.innerHTML = html;
  }

  // ─────────────────────────── projects ───────────────────────────
  function projectsSectionHtml(_c: Counts) {
    // A persistent "+ New project" affordance lives in the populated grid's header so a SECOND
    // (third, …) project is registerable from the UI — not only on the empty-onboarding path
    // (operability lens). data-projaction="new" carries no id; the controller prompts for a
    // folder (reusing refreshCandidates) + name, then POSTs /api/projects.
    return `<div class="shead" id="sec-proj"><h2>Projects</h2><span class="cnt">${state.data.length}</span>
        <span class="hint">tap a card to drill in <span class="infg" title="Each ring is one workstream. Segments = its Definition-of-Done criteria, filled = met. ✓ = merged · ∞ = autonomous loop · ? = no DoD set yet.">?</span></span>
        <button class="btn ghost sm newproj" type="button" data-projaction="new" title="Register another project folder — its sessions roll up by cwd-prefix">${plusIcon()} New project</button>
      </div>
      <section id="projectsHost"></section>`;
  }
  function projWarn(_p: VProject) { return false; }
  function allWsSurfaced(p: VProject) { return p.workstreams.length > 0 && p.workstreams.every((w) => (w.sessions || []).length > 0 && w.sessions.every((s) => s.status === "block" || s.status === "fail")); }
  function agoToMin(a?: string) {
    const s = String(a || "").toLowerCase(); const m = s.match(/(\d+(?:\.\d+)?)/); const v = m ? parseFloat(m[1]) : 1;
    if (/yesterday/.test(s)) return 1440;
    if (/min|m ago/.test(s)) return v;
    if (/h ago|hour/.test(s)) return v * 60;
    if (/d ago|day/.test(s)) return v * 1440;
    if (/w ago|week/.test(s)) return v * 10080;
    return 1e9;
  }
  function mergeRecency(p: VProject) { let best = 1e9; p.workstreams.forEach((w) => w.sessions.forEach((s) => { const a = (s.artifact && s.artifact.mergedAgo) || w.mergedAgo; if (a) { const n = agoToMin(a); if (n < best) best = n; } })); return best; }

  function renderGrid(c: Counts) {
    const host = document.getElementById("projectsHost"); if (!host) return;
    const attn = state.data.filter((p) => pClass(p) === "attn");
    const active = state.data.filter((p) => pClass(p) === "active");
    const dormant = state.data.filter((p) => pClass(p) === "calm");
    const setup = state.data.filter((p) => pClass(p) === "needsSetup");
    let signoff = state.data.filter((p) => pClass(p) === "signoff");

    let fullSign: VProject[] = [];
    if (!attn.length && !active.length && signoff.length) { fullSign = signoff.slice(); signoff = []; }

    const fullCandidates = attn.concat(active);
    const allCollapse = fullCandidates.length > 0 && fullCandidates.every(allWsSurfaced) && !active.some(projWarn);

    let out = "";
    if (allCollapse) {
      out += `<div class="surfline" style="border:1px solid var(--border);border-radius:14px;background:var(--panel);margin-bottom:14px">
        <span class="sq"></span><b>All work across ${fullCandidates.length} project${fullCandidates.length > 1 ? "s" : ""}</b> is in Needs&nbsp;you above — nothing extra to surface here
        <button class="jump" data-jump="sec-needs">answer ↑</button></div>
        <div class="grpcard" id="sec-collapsed"><div class="grp-h" data-toggle="grp"><span class="gt">In Needs you</span> <span class="gc">${fullCandidates.length} project${fullCandidates.length > 1 ? "s" : ""} · drill in for full context</span><span class="chev">${chevIcon()}</span></div>
          <div class="grp-b">` + fullCandidates.map((p) => renderRow(p)).join("") + `</div></div>`;
    } else {
      const ATTN_CAP = 4;
      const attnSorted = attn.slice().sort((a, b) => blastRank(cardBlast(a)) - blastRank(cardBlast(b)));
      const attnFull = attnSorted.slice(0, ATTN_CAP);
      const attnOverflow = attnSorted.slice(attnFull.length);
      const ACTIVE_CAP = 4;
      const activeFull = active.slice(0, ACTIVE_CAP);
      const activeOverflow = active.slice(activeFull.length);
      const full = attnFull.concat(activeFull).concat(fullSign);
      // Center the lone card ONLY in the pure-calm state. When a full-width sign-off band
      // (c.sign) and/or a Needs-setup section (setup) sits beside it, keep the card's LEFT
      // edge lined up with the heading + sibling bands — but let it span the FULL row width
      // (`.solo`) so it matches those full-width bands instead of stranding an empty right
      // gutter at min-width (review finding). The two states are mutually exclusive.
      const single = full.length === 1 && !signoff.length && !dormant.length && !activeOverflow.length && !attnOverflow.length && !setup.length && c.sign === 0;
      const soloFull = full.length === 1 && (c.sign > 0 || setup.length > 0);
      if (full.length) out += `<div class="grid ${single ? "single" : soloFull ? "solo" : ""}">` + full.map((p) => renderCard(p)).join("") + `</div>`;
      if (attnOverflow.length) {
        const AOC = 6, aoShown = attnOverflow.slice(0, AOC), aoExtra = attnOverflow.slice(AOC);
        out += `<div class="grpcard" id="sec-attn-more"><div class="grp-h" data-toggle="grp"><span class="gt">Needs attention</span> <span class="gc">${attnOverflow.length} more need attention · answer in Needs you above</span><button class="jump" data-jump="sec-needs">answer ↑</button><span class="chev">${chevIcon()}</span></div>
          <div class="grp-b">` + aoShown.map((p) => renderRow(p)).join("")
          + (aoExtra.length ? `<div class="more-rows" hidden>${aoExtra.map((p) => renderRow(p)).join("")}</div><button class="morelink" data-toggle="more">+${aoExtra.length} more — show all</button>` : "")
          + `</div></div>`;
      }
      if (activeOverflow.length) {
        out += `<div class="grpcard" id="sec-running"><div class="grp-h" data-toggle="grp"><span class="gt">Running</span> <span class="gc">${activeOverflow.length} more loop${activeOverflow.length > 1 ? "s" : ""} · live · nothing needs you</span><span class="chev">${chevIcon()}</span></div>
          <div class="grp-b">` + activeOverflow.map((p) => renderRow(p, { live: true })).join("") + `</div></div>`;
      }
    }
    if (signoff.length) {
      out += `<div class="grpcard" id="sec-signoff-grid"><div class="grp-h" data-toggle="grp"><span class="gt">Awaiting sign-off</span> <span class="gc">${signoff.length} project${signoff.length > 1 ? "s" : ""} · sign off in the strip above · drill in to review</span><button class="jump" data-jump="sec-signoff">sign off ↑</button><span class="chev">${chevIcon()}</span></div>
        <div class="grp-b">` + signoff.map((p) => renderRow(p, { navOnly: true })).join("") + `</div></div>`;
    }
    if (setup.length) {
      out += `<div class="grpcard open" id="sec-setup" data-testid="needs-setup"><div class="grp-h" data-toggle="grp"><span class="gt sup">Needs setup</span> <span class="gc">${setup.length} project${setup.length > 1 ? "s" : ""} · no Definition of Done authored yet · set one to start tracking</span><span class="chev">${chevIcon()}</span></div>
        <div class="grp-b">` + setup.map((p) => renderRow(p, { setup: true })).join("") + `</div></div>`;
    }
    if (dormant.length) {
      const sorted = dormant.slice().sort((a, b) => mergeRecency(a) - mergeRecency(b));
      const CAP = 6, shown = sorted.slice(0, CAP), extra = sorted.slice(CAP);
      out += `<div class="grpcard" id="sec-healthy"><div class="grp-h" data-toggle="grp"><span class="gt">Healthy &amp; dormant</span> <span class="gc">${dormant.length} project${dormant.length > 1 ? "s" : ""} · nothing needs you · last-known cached status</span><span class="chev">${chevIcon()}</span></div>
        <div class="grp-b">` + shown.map((p) => renderRow(p)).join("")
        + (extra.length ? `<div class="more-rows" hidden>${extra.map((p) => renderRow(p)).join("")}</div><button class="morelink" data-toggle="more">+${extra.length} more — show all</button>` : "")
        + `</div></div>`;
    }
    host.innerHTML = out;
  }

  function renderWsList(p: VProject, opts?: RowOpts) {
    const all = p.workstreams.slice().sort(byAttention);
    const CAP = 6, shown = all.slice(0, CAP), more = all.slice(CAP);
    return shown.map((w) => renderWorkstream(w, p, opts)).join("")
      + (more.length ? `<div class="more-rows" hidden>${more.map((w) => renderWorkstream(w, p, opts)).join("")}</div><button class="morelink" data-toggle="more">+${more.length} more workstream${more.length > 1 ? "s" : ""}</button>` : "");
  }

  function renderCard(p: VProject) {
    const c = projNeeds(p);
    const live = cardLive(p);
    const hasNeeds = (c.you || c.fail) > 0;
    const countPills: string[] = [];
    if (c.sign) { countPills.push(`<button class="countpill sgn jumplink" data-jump="sec-signoff">${c.sign} to sign off ↑</button>`); }
    if (!hasNeeds && !c.sign) { countPills.push(c.run ? `<span class="countpill calm">${c.run} running</span>` : `<span class="countpill calm">all calm</span>`); }

    // The project gauge is the SERVER's k-of-n ProgressSnapshot (rollup.ts
    // projectProgress), not a client re-derivation — `met`/`total` are scorable
    // workstreams done / counted (review finding: one source of truth, no client copy of
    // the formula that can silently diverge from the server's workstreamDone()).
    const pp = p._prog;
    const g = { done: pp?.met ?? 0, total: pp?.total ?? 0, percent: pp?.percent ?? 0 };
    const pole = longPole(p);
    const someLoop = p.workstreams.some(wsOpenEnded);
    const allOpenEnded = g.total === 0 && someLoop;
    const noDod = g.total === 0 && !someLoop;
    const gaugeItem: RingItem = allOpenEnded ? { status: "loop", loop: true }
      : noDod ? { status: "unset" }
        : { status: "gauge", _sessGauge: { done: g.done, total: g.total, percent: g.percent } };
    const poleInNeeds = pole && (pole.status === "block" || pole.status === "fail");
    const poleTag = poleInNeeds
      ? `<button class="muted-jump" data-jump="sec-needs">· in Needs you ↑</button>`
      : (pole ? badge(pole.status) : "");
    const loopWs = p.workstreams.filter(wsOpenEnded).length;
    const loopClause = loopWs ? ` · <b>${loopWs} loop${loopWs > 1 ? "s" : ""} running</b>` : "";
    const scopedWord = loopWs ? `scoped workstream${g.total > 1 ? "s" : ""}` : `workstream${g.total > 1 ? "s" : ""}`;
    const poleLine = allOpenEnded
      ? `<div class="csum-pole"><span class="plbl">Continuous loop — no terminal Definition of Done.</span></div>`
      : noDod
        ? `<div class="csum-pole"><span class="plbl">No Definition of Done set — add one to track progress.</span></div>`
        : pole && !wsDone(pole)
          ? `<div class="csum-pole"><span class="plbl">Long pole:</span> <b>${esc(shortWs(pole.name))}</b> ${poleTag}</div>`
          : ``;
    const gaugeLine = allOpenEnded
      ? `<div class="csum-line"><b>∞ looping</b> · open-ended ${dotStrip(p)}</div>`
      : noDod
        ? `<div class="csum-line"><span class="muted">No Definition of Done set yet</span> ${dotStrip(p)}</div>`
        : `<div class="csum-line"><b>${g.done} of ${g.total}</b> ${scopedWord} met DoD${loopClause} ${dotStrip(p)}</div>`;
    const ringsBlock = `<div class="csum">
      <div class="csum-ring" title="${allOpenEnded ? "an open-ended loop has no terminal DoD to be k-of-n against — shown as running ∞" : noDod ? "no Definition of Done set on any workstream yet — nothing to gauge" : "k of " + g.total + " workstreams have met their Definition of Done — an honest aggregate, not an authored percent"}">${ringSvg(gaugeItem, 50)}</div>
      <div class="csum-body">
        ${gaugeLine}
        ${poleLine}
      </div>
    </div>`;

    const ws = renderWsList(p);
    const liveRun = (live.tone === "run" || live.tone === "loop");
    let olActs: string, olAttr: string, ping = "";
    if (live.pointUp) {
      const lbl = live.pointUp === "sec-needs" ? "Answer ↑" : "Sign off ↑";
      olActs = `<button class="btn ghost sm" data-jump="${live.pointUp}">${lbl}</button>`;
      olAttr = `data-jump="${live.pointUp}"`;
    } else {
      olActs = live.id
        ? `<button class="btn primary sm" data-open="${live.id}">${continueIcon()} ${live.unset ? "Define done" : liveRun ? "Open" : "Continue"}</button>`
        : "";
      olAttr = live.id ? `data-open="${live.id}"` : "";
      ping = (live.id && live.id === state._pingId) ? " ping" : "";
    }

    return `<article class="pcard" id="card-${p.id}" data-p="${p.id}" data-project-id="${p.id}">
      <div class="pcard-head" data-toggle="card">
        <div class="pcard-id">
          <div class="pname"><span class="nm">${esc(p.name)}</span> ${p.nest ? `<span class="nest" title="own project root nested inside its parent — its work is NOT counted toward the parent">⤷ ${esc(p.nest)}</span>` : ""}</div>
          <div class="ppath mono" title="${esc(p.path)}${p.desc ? ` · ${esc(p.desc)}` : ""}"><span class="pp-path">${esc(p.path)}</span>${p.desc ? `<span class="pp-desc"> · ${esc(p.desc)}</span>` : ""}</div>
        </div>
        <div class="pcard-counts">
          <div class="pcard-counts-top">
            ${p.workstreams.length === 1 ? wsMenu(p.workstreams[0]) : ""}
            ${projMenu(p)}
            <span class="chev">${chevIcon()}</span>
          </div>
          ${countPills.join("")}
        </div>
      </div>
      ${ringsBlock}
      <div class="oneliner ${live.tone}${ping}" ${olAttr}>
        <span class="live"></span>
        <span class="txt">${live.loop ? `<b>loop · </b>` : ""}${esc(live.txt)}</span>
        ${live.qDelta ? `<span class="qdelta" title="~${live.qDelta.total} items in the loop's planned queue — best-effort parsed from the agent's notes.">~${live.qDelta.total} queued</span>` : ""}
        ${olActs ? `<span class="ol-act">${olActs}</span>` : ""}
      </div>
      <div class="pbody">${ws}</div>
    </article>`;
  }

  function renderRow(p: VProject, opts?: RowOpts) {
    const o = opts || {};
    const c = projNeeds(p);
    const lv = o.live ? cardLive(p) : null;
    const unset = !o.live && allUnset(p);
    let sum: string;
    if (o.live && lv) sum = `<span style="color:var(--st-run)">${lv.loop ? "∞ " : ""}live</span>`;
    else if (c.you || c.fail) sum = `<b>${c.you + c.fail}</b> need you`;
    else if (c.sign) sum = `<b>${c.sign}</b> to sign off`;
    else if (unset) sum = `<span class="setup-sum" title="No Definition of Done authored on any workstream yet. Open to set one."><span class="qmk">?</span> needs setup</span>`;
    else {
      const merged = p.workstreams.filter((w) => w.status === "merge").length; const q = p.workstreams.filter((w) => w.status === "queued" || w.status === "planned").length;
      sum = merged ? `<b>${merged}</b> merged` + (q ? ` · ${q} queued` : "") : (q ? `<b>${q}</b> queued` : "healthy");
    }
    const ppTxt = (o.live && lv) ? esc(lv.txt) : esc(p.path);
    const ppCls = o.live ? "pp" : "pp mono";
    const ppTitle = (o.live && lv) ? esc(lv.txt) : esc(p.path);
    const ws = renderWsList(p, { navOnly: o.navOnly });
    // The setup CTA routes to the DoD drawer for the first UNSET session. `unset` already
    // requires ≥1 session (allUnset is false for an empty project), so this id is non-null in
    // practice — but guard the empty-string fallback so we never render a dead `data-open=""`
    // button. A zero-session project reaches workstream creation via the project kebab's
    // "New workstream…" instead.
    const setupSessId = (o.setup && unset) ? firstSessId(p, ["unset"]) : null;
    const setupAct = setupSessId
      ? `<button class="btn ghost sm setup-cta" data-open="${esc(setupSessId)}">${continueIcon()} Set a Definition of Done</button>`
      : "";
    return `<div class="prow" id="card-${p.id}" data-toggle="prow" data-rowp="${p.id}" data-project-id="${p.id}">
        ${dotStrip(p)}
        <span class="pn">${esc(p.name)}${p.nest ? ` <span class="nest" title="nested under its parent — counted only here, not toward the parent">⤷ ${esc(p.nest)}</span>` : ""}</span>
        <span class="${ppCls}" title="${ppTitle}">${ppTxt}</span>
        <span class="psum">${sum}</span>
        ${setupAct}
        ${projMenu(p)}
        <span class="chev">${chevIcon()}</span>
      </div>
      <div class="prow-body" data-rowbody="${p.id}"><div class="pbody" style="display:block;border-top:0">${ws}</div></div>`;
  }

  function renderWorkstream(w: VWorkstream, p: VProject, opts?: RowOpts) {
    let extra = "";
    if (w.status === "loop") {
      extra = `<span class="loopBadge"><span class="inf">∞</span> looping ${esc(fmtMin(wsLoopMinutes(w)))}</span>`;
    } else extra = badge(w.status);
    // M4: the synthetic Unfiled bucket lets the user organize loose sessions — its rows are
    // multi-selectable and it carries an assignment bar + auto-group suggestions. Real
    // workstreams keep their existing (non-selectable) rows.
    const isUnfiled = !!w._synthetic;
    const rowOpts: RowOpts | undefined = isUnfiled ? { ...(opts || {}), selectable: true } : opts;
    const sorted = w.sessions.slice().sort(byAttention);
    const CAP = 6, shown = sorted.slice(0, CAP), more = sorted.slice(CAP);
    const sess = shown.map((s) => renderSession(s, w, p, rowOpts)).join("")
      + (more.length ? `<div class="sess-extra" hidden>${more.map((s) => renderSession(s, w, p, rowOpts)).join("")}</div><button class="sessmore" data-toggle="sessmore">+${more.length} more session${more.length > 1 ? "s" : ""}</button>` : "");
    const mixedNote = w._mixed && w._sessGauge ? ` <span class="srcTag" title="this workstream's sessions use different DoD evaluators, so the ring is a 'k of n sessions done' gauge — not a blended percent">mixed sources · ${w._sessGauge.done}/${w._sessGauge.total} done</span>` : "";
    const wsDod = (w.status === "unset"
      ? `<span style="color:var(--st-sign)">not set</span> ${srcTag(w.dodSrc)}`
      : dodInline(w.dod, w.dodSrc)) + mixedNote;
    const unfiledTools = isUnfiled ? unfiledAssignHtml(w, p) : "";
    return `<div class="ws${isUnfiled ? " ws-unfiled" : ""}" data-w="${w.id}" data-ws-id="${w.id}"${isUnfiled ? ` data-unfiled-project="${esc(p.id)}"` : ""}>
      <div class="ws-head" data-toggle="ws">
        <div class="ws-ring">${ringSvg(w, 44)}</div>
        <div class="ws-id">
          <div class="ws-name">${esc(w.name)} ${extra}</div>
          <div class="ws-dod">${isUnfiled ? `<span class="muted">loose sessions matched to this project root — select to group them into a workstream</span>` : wsDod}</div>
        </div>
        <div class="ws-meta">
          <span class="ws-cnt">${w.sessions.length} session${w.sessions.length > 1 ? "s" : ""}</span>
          ${wsMenu(w)}
          <span class="ws-chev chev">${chevIcon()}</span>
        </div>
      </div>
      <div class="sess-list">${unfiledTools}${sess}</div>
    </div>`;
  }

  // ── M4 Unfiled organizer: auto-group suggestions + the multi-select assignment bar ──────
  // Both live INSIDE the Unfiled bucket's sess-list (above the rows). The data-attributes are
  // the delegated-handler contract (dashboard.ts): data-autogroup (one-click pre-create),
  // data-mn-newws / data-mn-movews (act on the current selection), data-mn-clear. The bar's
  // count + disabled state reflect the controller's transient `mnSelection` set, re-rendered on
  // every selection change. The "Move to existing" picker lists the project's REAL workstreams
  // (never the synthetic bucket itself).
  function realWorkstreamsOf(p: VProject): VWorkstream[] {
    // ONLY active, real workstreams are valid move targets. The synthetic Unfiled bucket is
    // never a target (no stored ws to attach to), and an archived/abandoned workstream
    // (`_inactive`) must be excluded too: moving live sessions into a shelved workstream would
    // silently tally them as `abandoned` and drop them out of the active grid/gauge — a
    // data-visibility loss masquerading as a successful move. `p.archivedWorkstreams` are
    // already split off by the adapter, so reading `p.workstreams` alone is correct; we still
    // guard `_inactive`/`_synthetic` defensively in case the split ever changes.
    return (p.workstreams || []).filter((x) => !x._synthetic && !x._inactive);
  }
  function unfiledAssignHtml(w: VWorkstream, p: VProject): string {
    const groups = clusterUnfiledSessions(w.sessions.map((s) => ({ id: s.id, name: s.name })));
    const selected = w.sessions.filter((s) => state.mnSelection?.has(s.id));
    const n = selected.length;
    const targets = realWorkstreamsOf(p);
    // Auto-group chips: only surface a suggestion that isn't already fully selected, so a chip
    // stays a one-click shortcut, not a no-op. Cap to keep the strip calm.
    const chips = groups.slice(0, 4).map((g) => {
      const count = g.sessionIds.length;
      return `<button class="mn-suggest" type="button" data-autogroup="${esc(g.key)}" data-project="${esc(p.id)}" data-sessions="${esc(g.sessionIds.join(","))}" title="Create a workstream &quot;${esc(g.label)}&quot; from these ${count} similarly-named sessions">✦ Group ${count} “${esc(g.label)}” →</button>`;
    }).join("");
    const suggestRow = chips
      ? `<div class="mn-suggests"><span class="mn-suggest-lbl" title="Heuristic only — clustered by shared session-name prefix. One click pre-creates a workstream; nothing is grouped until you confirm.">Suggested groups</span>${chips}</div>`
      : "";
    // The assignment bar — visible (with actions enabled) only when ≥1 row is selected.
    const movePicker = targets.length
      ? `<div class="mn-move"><select class="mn-move-sel" data-mn-movesel aria-label="Move to existing workstream"><option value="">Move to…</option>${targets.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select><button class="btn ghost sm" type="button" data-mn-movews="${esc(p.id)}"${n ? "" : " disabled"}>Move ${n || ""}</button></div>`
      : "";
    const bar = `<div class="mn-bar${n ? " active" : ""}" data-mn-bar>
      <span class="mn-count">${n ? `<b>${n}</b> selected` : "Select sessions to organize"}</span>
      <span class="mn-grow"></span>
      <button class="btn primary sm" type="button" data-mn-newws="${esc(p.id)}"${n ? "" : " disabled"}>${plusIcon()} New workstream from selection</button>
      ${movePicker}
      ${n ? `<button class="mn-clear" type="button" data-mn-clear title="Clear selection">Clear</button>` : ""}
    </div>`;
    return `<div class="mn-organize">${suggestRow}${bar}</div>`;
  }

  function artChip(s: VSession) {
    const a = s.artifact; if (!a) return "";
    if (a.kind === "doc") {
      const gate = s._gate; const reviewed = !gate || gate.met || state.signed[s.id];
      const tag = reviewed ? `<span class="ok">✓ user-reviewed</span>` : `<span style="color:var(--muted)">awaiting your review</span>`;
      return `<span class="artchip doc" title="No repo — file count derived from this session's write/edit tool_result entries.">📄 ${esc(a.note)} · ${a.files} file${(a.files || 0) > 1 ? "s" : ""} · ${tag}</span>`;
    }
    if (a.kind === "spark") {
      return `<span class="artchip doc" title="Visual snapshot (rendered output) — verification is your review of the rendered chart, not a git diff.">🖼 ${esc(a.note || "visual")} · <span class="ok">✓ visual · reviewed</span></span>`;
    }
    const merged = a.merged;
    // numstat is only shown when the server actually has it (a durable diff receipt) —
    // the git-derived artifact (server gitArtifact) carries a real branch/merged flag but
    // NO add/del/sha (gitStatus exposes neither), so we omit the `+N/−N` rather than render
    // `+undefined/−undefined` (no-fabricated-signal rule; review finding).
    const diff = a.add != null && a.del != null
      ? ` · <span class="add">+${a.add}</span>/<span class="del">−${a.del}</span>`
      : "";
    const head = merged ? (a.sha ? `✓ merged · ${esc(a.sha)}` : "✓ merged") : esc(a.branch);
    return `<span class="artchip ${merged ? "mg" : ""}">${esc(head)}${diff}</span>`;
  }

  function iterSparkHtml(arr: number[]) {
    const max = Math.max(...arr, 1);
    return `<span class="iterspark" title="iteration rhythm — tool_execution_end events per loop iteration (health, not progress)">` + arr.map((v) => `<i style="height:${Math.max(3, Math.round(v / max * 16))}px"></i>`).join("") + `</span>`;
  }
  function proposedLoop(s: VSession) {
    const parts: string[] = [];
    if (s.iter != null) parts.push(`<b>iter ${s.iter}</b>`);
    if (s.iterspark && s.iterspark.length) parts.push(iterSparkHtml(s.iterspark));
    const b = s.budget || {};
    if (b.maxMinutes != null && s.elapsedMin != null) parts.push(`budget ${s.elapsedMin}/${b.maxMinutes}m`);
    else if (b.maxCostUsd != null && s.cost != null) parts.push(`budget $${s.cost}/$${b.maxCostUsd}`);
    const body = parts.length ? parts.join(" · ") + " — not live yet" : "iteration count, rhythm & budget — not live yet";
    return `<div class="proposed" title="Loop iteration telemetry needs a durable per-iteration log + an orchestrator pi does NOT expose today. Shown MUTED as a proposed signal — never live data.">
      <span class="plab">proposed</span><span class="pbody">${body}</span></div>`;
  }
  function renderSession(s: VSession, w: VWorkstream, p: VProject, opts?: RowOpts) {
    const navOnly = !!(opts && opts.navOnly);
    const cls = (ST[s.status] || {}).cls || "idle";
    // M4: a checkbox to multi-select Unfiled sessions for "New workstream from selection" /
    // "Move to existing". Only the synthetic Unfiled bucket is selectable; clicking the box
    // must NOT open the session (the delegated handler stops there). `mnSelection` is the
    // controller's transient set, so a re-render preserves the checked state.
    const selectable = !!(opts && opts.selectable);
    const checked = selectable && !!state.mnSelection?.has(s.id);
    const checkbox = selectable
      ? `<label class="mnselect" title="Select to group / move this session" onclick="event.stopPropagation()"><input type="checkbox" data-mnselect="${esc(s.id)}"${checked ? " checked" : ""} aria-label="Select ${esc(s.name)}"></label>`
      : "";
    const dot = `<span class="sess-dot ${cls}" style="background:${(ST[s.status] || {}).color || "var(--st-idle)"}"></span>`;
    const artifact = s.artifact ? `<div style="margin-top:8px">${artChip(s)}</div>` : "";
    let queue = "";
    if (s.queue && s.queue.length) {
      const total = s.queueTotal || s.queue.length;
      const shown = s.queue.slice(0, 3);
      const more = total - shown.length;
      queue = `<div class="qnext"><span class="qsrc" title="pi has no TodoWrite/plan primitive — these items are best-effort parsed from the agent's notes (~).">~ parsed from notes →</span>`
        + shown.map((q) => `<span class="qchip">${esc(q)}</span>`).join("")
        + (more > 0 ? `<span class="qmore">~${more} more planned</span>` : "")
        + `<span class="infg" title="Planned-next items are best-effort, parsed from the agent's notes (~).">i</span></div>`;
    }
    const verb = (navOnly && s.status === "sign") ? "Review"
      : s.status === "merge" ? "View" : (s.status === "run" || s.status === "loop") ? "Open" : s.status === "unset" ? "Define done" : "Continue";
    const primary = `<button class="btn primary sm" data-open="${s.id}">${continueIcon()} ${verb}</button>`;
    let secondary = "";
    if (s.status === "sign" && !navOnly) secondary = `<button class="btn sign sm" data-signoff="${esc(s._gate?.id ?? "")}"${deferTip("Sign off — merge stays a separate step")}>✓ Sign off</button>`;
    else if (s.status === "fail") secondary = `<button class="btn ghost sm" data-open="${s.id}">${esc(s.failAction || "Re-run")}</button>`;

    const dodTxt = s.status === "unset" ? `<span style="color:var(--st-sign)">no criterion set — define what done means</span> ${srcTag(s.dodSrc)}`
      : dodInline(s.dod, s.dodSrc);
    const dodHoisted = w && w.status !== "unset" && s.status !== "unset" && s.dod === w.dod && s.dodSrc === w.dodSrc;
    const loopTag = s.loop ? `<span class="loopBadge"><span class="inf">∞</span> looping ${esc(fmtMin(loopMinutes(s)))}</span>` : "";
    const softTag = isSoftWaitV(s) ? ` ${badge("block", true)}` : "";

    return `<div class="sess${selectable ? " selectable" : ""}${checked ? " mnchecked" : ""}" data-open="${s.id}">
      ${checkbox}
      ${dot}
      <div class="sess-main">
        <div class="sess-top"><span class="sess-name">${esc(s.name)}</span>${softTag} ${loopTag}</div>
        <div class="sess-live">${s.kind === "question" ? "❔ " : ""}${s.kind === "failed" ? "⚠ " : ""}<b>${esc(s.live)}</b>${(!s.loop && s.meta && s.kind !== "failed" && s.status !== "block" && s.status !== "unset") ? ` · ${esc(s.meta)}` : ""}</div>
        ${dodHoisted ? "" : `<div class="sess-dod">${dodTxt}</div>`}
        ${artifact}
        ${queue}
        ${s.loop ? proposedLoop(s) : ""}
      </div>
      <div class="sess-act">
        ${primary}
        ${secondary}
      </div>
    </div>`;
  }

  // ─────────────────────────── planned surface ───────────────────────────
  function plannedSectionHtml(c: Counts) {
    if (!c.plan) return "";
    return `<section class="done" id="sec-planned" style="margin-top:32px"></section>`;
  }
  function renderPlanned() {
    const host = document.getElementById("sec-planned"); if (!host) return;
    const dorm = dormantIds();
    const items: Array<{ s: VSession; w: VWorkstream; p: VProject }> = [];
    activeSess().forEach(({ s, w, p }) => { if ((s.status === "queued" || s.status === "planned") && !dorm.has(p.id)) items.push({ s, w, p }); });
    const row = ({ s, w, p }: { s: VSession; w: VWorkstream; p: VProject }) => {
      const total = s.queueTotal || (s.queue ? s.queue.length : 0); const shown = (s.queue || []).slice(0, 3); const more = total - shown.length;
      const plan = s.queue && s.queue.length ? `<div class="qnext"><span class="qsrc" title="pi has no TodoWrite/plan primitive — best-effort parsed from notes (~).">~ parsed from notes →</span>` + shown.map((q) => `<span class="qchip">${esc(q)}</span>`).join("") + (more > 0 ? `<span class="qmore">~${more} more planned</span>` : "") + `<span class="infg" title="Best-effort, parsed from the agent's notes (~).">i</span></div>` : "";
      return `<div class="drow" data-open="${s.id}">
        <div class="dleft">
          <div class="dcrumb"><b>${esc(p.name)}</b>${p.nest ? ` <span class="nest">⤷ ${esc(p.nest)}</span>` : ""} › ${esc(w.name)}</div>
          <div class="dname">${esc(s.name)} ${badge(s.status)}</div>
          <div class="dnote">${esc(s.live)} · DoD: ${dodInline(s.dod, s.dodSrc)}</div>
          ${plan}
        </div>
        <div class="sess-act">
          <button class="btn primary sm" data-open="${s.id}">${continueIcon()} Start</button>
        </div>
      </div>`;
    };
    const CAP = 6, shown = items.slice(0, CAP), extra = items.slice(CAP);
    host.innerHTML = `
      <div class="done-head" data-toggle="done">
        <div class="done-title">≡ Planned</div>
        <div class="done-sum"><b class="p">${items.length} planned</b>, not started — each has a ready plan</div>
        <span class="chev">${chevIcon()}</span>
      </div>
      <div class="done-body">
        <div class="done-grp"><div class="done-grp-h plan"><span class="sw"></span> Ready to start · ${items.length}</div>
          ${shown.map(row).join("")}${extra.length ? `<div class="more-rows" hidden>${extra.map(row).join("")}</div><button class="morelink" data-toggle="more">+${extra.length} more — show all</button>` : ""}</div>
      </div>`;
  }

  // ─────────────────────────── done surface — COMPLETED & MERGED only ───────────────────────────
  function doneSectionHtml(c: Counts) {
    if (!c.merge) return "";
    return `<section class="done" id="sec-done" style="margin-top:32px"></section>`;
  }
  function renderDone() {
    const host = document.getElementById("sec-done"); if (!host) return;
    const dorm = dormantIds();
    const mergeToday: Array<{ s: VSession; w: VWorkstream; p: VProject }> = [], mergeEarlier: Array<{ s: VSession; w: VWorkstream; p: VProject }> = [];
    activeSess().forEach(({ s, w, p }) => {
      if (s.status === "merge") {
        if (dorm.has(p.id)) return;
        const ago = (s.artifact && s.artifact.mergedAgo) || w.mergedAgo || "";
        (isRecent(ago) ? mergeToday : mergeEarlier).push({ s, w, p });
      }
    });
    const CAP = 6;
    const row = ({ s, w, p }: { s: VSession; w: VWorkstream; p: VProject }) => {
      const ago = (s.artifact && s.artifact.mergedAgo) || w.mergedAgo;
      const note = `DoD met: <b style="color:var(--text);font-weight:650">${esc(s.dod)}</b> ${srcTag(s.dodSrc)}${ago ? ` · merged ${esc(ago)}` : ""}`;
      return `<div class="drow" data-open="${s.id}">
        <div class="dleft">
          <div class="dcrumb"><b>${esc(p.name)}</b>${p.nest ? ` <span class="nest">⤷ ${esc(p.nest)}</span>` : ""} › ${esc(w.name)}</div>
          <div class="dname">${esc(s.name)} ${badge("merge")}</div>
          <div class="dnote">${note}</div>
          <div style="margin-top:8px">${artChip(s)}</div>
        </div>
        <div class="sess-act">
          <button class="btn ghost sm" data-open="${s.id}">View merge</button>
        </div>
      </div>`;
    };
    const cap = (arr: Array<{ s: VSession; w: VWorkstream; p: VProject }>, label: string, cls: string) => {
      if (!arr.length) return "";
      const shown = arr.slice(0, CAP), extra = arr.slice(CAP);
      return `<div class="done-grp"><div class="done-grp-h ${cls}"><span class="sw"></span> ${label} · ${arr.length}</div>
        ${shown.map(row).join("")}${extra.length ? `<div class="more-rows" hidden>${extra.map(row).join("")}</div><button class="morelink" data-toggle="more">+${extra.length} older — show all</button>` : ""}</div>`;
    };
    const mtot = mergeToday.length + mergeEarlier.length;
    host.innerHTML = `
      <div class="done-head" data-toggle="done">
        <div class="done-title">✓ Done</div>
        <div class="done-sum"><b class="m">${mtot} completed &amp; merged</b> — verified receipts <span class="infg" title="Verification-first: no done card without its receipt — a diff, a merge sha, or a rendered doc.">?</span></div>
        <span class="chev">${chevIcon()}</span>
      </div>
      <div class="done-body">
        ${cap(mergeToday, "Completed &amp; merged · today", "merge")}
        ${cap(mergeEarlier, "Completed &amp; merged · earlier", "merge earlier")}
      </div>`;
  }

  function tailNoteHtml(c: Counts) {
    if (c.needs === 0) return "";
    return `<p class="calmnote">All other loops are quiet. pi will surface them here the moment they need you.</p>`;
  }

  // ─────────────────────────── first-run onboarding (S9) ───────────────────────────
  // The folder glyph for an unregistered candidate cwd (mockup L2795 `candglyph`).
  const folderIcon = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="15" height="15"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/></svg>`;
  function onboardHtml(_candidates: number) {
    // Candidate roots are DERIVED CLIENT-SIDE from GET /api/sessions cwds (impl-plan S9 —
    // prefer client-derive to stay frontend-only). Each card registers THAT specific root on
    // tap via POST /api/projects, so cold-start setup is one click, not three manual layers.
    const cands = state.candidates || [];
    const disc = cands.length > 0 ? `
      <div class="disc">
        pi found <b>${cands.length} recent session folder${cands.length > 1 ? "s" : ""}</b> that look like projects. Add one with a tap:
        <div class="cands">
          ${cands.map((c) => `<div class="cand">
            <span class="candglyph" title="unregistered folder — no rollup, status or DoD computed yet" style="color:var(--muted);display:inline-flex;align-items:center">${folderIcon()}</span>
            <span class="cpath mono" title="${esc(c.path)}">${esc(c.display)}</span>
            <span class="cmeta">${c.sessions} session${c.sessions > 1 ? "s" : ""}</span>
            <button class="btn ghost sm" data-cand="${esc(c.name)}" data-candpath="${esc(c.path)}">Add</button>
          </div>`).join("")}
        </div>
      </div>` : `
      <div class="disc">No sessions yet — once you start one, pi will offer to roll its folder up into a project automatically.</div>`;
    return `<div class="onboard" data-testid="first-run">
      <div class="glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="11" height="6" rx="1.5"/><path d="M18 14v6M21 17h-6" opacity=".6"/></svg></div>
      <h2>Roll up your work into projects</h2>
      <p>pi-web groups your sessions into a calm, at-a-glance view. Tell it which folders are projects, and it organizes everything underneath.</p>
      <div class="model">
        <span class="node">Project</span><span class="arr">›</span>
        <span class="node">Workstream</span><span class="arr">›</span>
        <span class="node">Session</span><span class="arr">·</span>
        <span class="node">Definition of Done</span>
      </div>
      <ol class="obsteps">
        <li><b>Register a project</b> — point pi-web at a folder. Its sessions roll up automatically by longest-path match.</li>
        <li><b>Attach sessions to a workstream</b> — group a project's sessions into a workstream (e.g. "auth", "billing").</li>
        <li><b>Set a Definition of Done</b> — pick what "done" means. A ring shows honest k-of-n progress toward it.</li>
      </ol>
      <div class="actions">
        <button class="btn primary" id="obAdd">${plusIcon()} Add a project</button>
        <button class="btn" id="obStart">${continueIcon()} Start your first session</button>
      </div>
      ${disc}
    </div>`;
  }
  // Wire the onboarding intents to the controller's REAL REST handlers (impl-plan S9). The
  // conversion flow gates ALL of the dashboard's value, so its handlers must be EXERCISED, not
  // no-ops: each candidate's Add registers THAT root (POST /api/projects), "Add a project"
  // registers the first candidate (or no-ops with a hint when none), and "Start your first
  // session" opens a real pi session that the next rollup folds in by cwd-prefix.
  function bindOnboard() {
    if (!onboard) return;
    const add = wrap.querySelector<HTMLButtonElement>("#obAdd");
    if (add) add.onclick = () => {
      const first = (state.candidates || [])[0];
      if (first) onboard.onRegister(first.name, first.path);
      else onboard.onStartSession(); // nothing to register yet → start a session to seed a candidate
    };
    const start = wrap.querySelector<HTMLButtonElement>("#obStart");
    if (start) start.onclick = () => onboard.onStartSession();
    wrap.querySelectorAll<HTMLButtonElement>("[data-cand]").forEach((b) => {
      b.onclick = () => onboard.onRegister(b.getAttribute("data-cand") || "project", b.getAttribute("data-candpath") || "");
    });
  }

  // The Needs-you "jump to item" filter is driven by a single delegated `input` listener on
  // `wrap` (mirroring the delegated click discipline) — no inline `oninput` attribute, no
  // window global. createRenderer runs once, so this binds exactly once.
  wrap.addEventListener("input", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.classList.contains("needjump")) filterNeeds(t);
  });

  // ─────────────────────────── drill-in oversight context band ───────────────────────────
  // The structured DoDSource.kind → its evaluator family label (mirrors the mockup critList #18).
  const evalFamily = (src?: string) => src === "command" ? "command" : src === "session_idle" ? "runtime" : (src && src.indexOf("git") === 0) ? "git" : "manual";
  function critRow(c: VCrit): string {
    const fam = evalFamily(c.src);
    const atTxt = c.at ? ` <span class="cat">· ${esc(c.at)}</span>` : "";
    const ev = (c.ev || c.at) ? `<div class="cev">${esc(c.ev || "")}${atTxt}</div>` : "";
    const gatePill = c.gate ? `<span class="gatepill">sign-off gate · excluded from %</span>` : "";
    return `<div class="crit ${c.met ? "met" : ""} ${c.gate ? "gate" : ""}">
      <span class="box">${c.met ? "✓" : (c.gate ? "…" : "")}</span>
      <div class="cbody"><div class="ctext">${esc(c.text)} <span class="srcTag" title="evaluator: ${esc(fam)}">${esc(fam)}</span>${gatePill}</div>${ev}</div>
    </div>`;
  }
  function contextBandHtml(sessionId: string): string | null {
    const ref = state.SESS[sessionId];
    if (!ref) return null;
    const { s, w, p } = ref;
    const ringItem: RingItem = (s._prog || s.status !== "queued") ? s : w;
    const dodLine = s.status === "unset"
      ? `<span class="cb-unset">not set — no Definition of Done yet</span>`
      : `${esc(s.dod)}${(s.status === "sign" && s._gate) ? ` <span class="cb-pend">· evaluable criteria met — sign-off gate pending</span>` : ""}`;
    const hasCrit = !!(s.crit && s.crit.length);
    const crit = hasCrit ? `<div class="cb-crit">${s.crit!.map(critRow).join("")}</div>` : "";
    const exp = hasCrit ? `<span class="cb-exp">${chevIcon()}</span>` : "";
    const soft = isSoftWaitV(s);
    return `<div class="cb-bar"${hasCrit ? ' data-cb-toggle role="button" tabindex="0"' : ""}>
      <div class="cb-ring">${ringSvg(ringItem, 40)}</div>
      <div class="cb-main">
        <div class="cb-crumb"><b>${esc(p.name)}</b>${p.nest ? ` <span class="cb-nest">⤷ ${esc(p.nest)}</span>` : ""} &nbsp;›&nbsp; ${esc(w.name)} · <span class="cb-sn">${esc(s.name)}</span> ${badge(s.status, soft)}</div>
        <div class="cb-dod"><span class="cb-lbl">Definition of Done</span> ${srcTag(s.dodSrc)} <span class="cb-dtxt">${dodLine}</span></div>
      </div>
      ${exp}
      <button class="cb-close" type="button" data-cb-close aria-label="Dismiss oversight context" title="Dismiss">${closeIcon()}</button>
    </div>${crit}`;
  }

  // M4 — repaint each Unfiled bucket's sess-list in place from the current `mnSelection`,
  // so toggling a checkbox updates the bar + the checked rows without re-rendering the whole
  // grid (which would collapse open cards / lose scroll). Each `.ws-unfiled` carries its
  // project id; we re-derive its session rows + organizer and swap only the sess-list.
  function renderUnfiled() {
    wrap.querySelectorAll<HTMLElement>(".ws-unfiled").forEach((wsEl) => {
      const wsId = wsEl.getAttribute("data-ws-id") || "";
      const projectId = wsEl.getAttribute("data-unfiled-project") || "";
      const p = state.data.find((x) => x.id === projectId);
      const w = p && [...(p.workstreams || []), ...(p.archivedWorkstreams || [])].find((x) => x.id === wsId);
      if (!p || !w) return;
      const list = wsEl.querySelector<HTMLElement>(".sess-list");
      if (!list) return;
      const sorted = w.sessions.slice().sort(byAttention);
      const CAP = 6, shown = sorted.slice(0, CAP), more = sorted.slice(CAP);
      const rowOpts: RowOpts = { selectable: true };
      const sess = shown.map((s) => renderSession(s, w, p, rowOpts)).join("")
        + (more.length ? `<div class="sess-extra" hidden>${more.map((s) => renderSession(s, w, p, rowOpts)).join("")}</div><button class="sessmore" data-toggle="sessmore">+${more.length} more session${more.length > 1 ? "s" : ""}</button>` : "");
      list.innerHTML = unfiledAssignHtml(w, p) + sess;
    });
  }

  return {
    renderAll,
    contextBandHtml,
    renderSignoff,
    renderGrid: () => renderGrid(fleetCounts()),
    renderArchived,
    renderUnfiled,
    signPending: (id: string) => { const ref = state.SESS[id]; return !!ref && signPending(ref.s); },
  };
}
