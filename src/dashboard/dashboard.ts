// Project Rollups — dashboard controller (S4 scaffold).
//
// Owns the full-screen rollup overlay: a statusBar-toggled surface layered above
// `main.app` that fetches `GET /api/rollups` and renders the Project → Workstream
// → Session rollups. This S4 slice wires the shell (open/close/reveal, fetch, an
// empty/loading render) and leaves the byte-for-byte render port for S5 (the
// `rollupAdapter` + `render` modules drop into `renderRollups` here).
//
// Purely additive: it never unmounts `#messages`/the composer, and closing returns
// to the live conversation untouched.

import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import type { SessionsController } from "../sessions/sessionDrawer.js";
import type { ProjectRollup } from "./types.js";
import { createRenderer, type RenderState } from "./render.js";
import { toViewModel } from "./rollupAdapter.js";

export type DashboardController = {
  init: () => void;
  open: () => void; // fetch /api/rollups, render, reveal overlay
  close: () => void; // hide overlay (keeps DOM)
  isOpen: () => boolean;
  toggle: () => void;
  applyRollupChange: (projectId?: string) => void; // debounced refetch on realtime
};

type DashboardState = {
  rollups: ProjectRollup[];
  loading: boolean;
  error: string | null;
};

const REFETCH_DEBOUNCE_MS = 250;
const LAST_VISIT_KEY = "pi-dashboard-last-visit";

// `/Users/<name>/foo` → `~/foo` for a calmer onboarding display path (matches the adapter).
function prettyPath(root: string): string {
  return root.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}
// The trailing folder name of an absolute cwd — the default project name when registering.
function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

// Persist a real "last looked at the dashboard" timestamp so the hero delta clause counts
// only work merged/blocked since the PREVIOUS visit — never treating a null baseline as the
// beginning of time (which made `fleetDelta` count every merged item all-time). Returns an
// "ago"-style string the renderer's `agoToMin` already parses, or null on the first visit.
function readLastVisit(): string | null {
  try {
    const raw = window.localStorage.getItem(LAST_VISIT_KEY);
    if (!raw) return null;
    const epoch = Number(raw);
    if (!Number.isFinite(epoch) || epoch <= 0) return null;
    const min = Math.max(0, Math.round((Date.now() - epoch) / 60000));
    if (min < 60) return `${Math.max(1, min)}m ago`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  } catch {
    return null;
  }
}
function writeLastVisit(): void {
  try {
    window.localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
  } catch {
    /* storage unavailable — the delta simply stays suppressed */
  }
}

export function createDashboard(options: {
  elements: AppElements;
  api: ApiClient;
  sessions: SessionsController;
  addMessage: (role: "system", text: string, extraClass?: string) => HTMLDivElement;
}): DashboardController {
  const { elements, api, sessions, addMessage } = options;

  let open = false;
  let fetchToken = 0;
  let refetchTimer: number | undefined;
  const state: DashboardState = { rollups: [], loading: false, error: null };

  // The mockup-shaped view model the ported render core reads. `toViewModel` (the
  // adapter seam) fills `data`/`SESS` from the server `ProjectRollup[]`; the client
  // trusts the server `ProgressSnapshot` and never re-derives it here.
  const view: RenderState = { data: [], SESS: {}, signed: {}, lastVisit: null, _pingId: null, candidates: [] };
  const renderer = createRenderer({
    wrap: elements.dashboardWrap,
    state: view,
    // Cold-start onboarding intents (S9), wired to the REAL REST surface.
    onboard: { onRegister: registerProject, onStartSession: startFirstSession },
  });

  function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (char) =>
      char === "&" ? "&amp;"
        : char === "<" ? "&lt;"
        : char === ">" ? "&gt;"
        : char === '"' ? "&quot;"
        : "&#39;",
    );
  }

  function renderLoadingOrError(): boolean {
    if (state.error) {
      elements.dashboardWrap.innerHTML = `
        <section class="hero">
          <div class="eyebrow">Project Rollups</div>
          <h1 class="headline">Couldn't load rollups</h1>
          <p class="subline">${escapeHtml(state.error)}</p>
        </section>`;
      return true;
    }
    if (state.loading && view.data.length === 0) {
      elements.dashboardWrap.innerHTML = `
        <section class="hero">
          <div class="eyebrow">Project Rollups</div>
          <h1 class="headline">Loading your projects…</h1>
          <p class="subline">Aggregating live pi sessions into project rollups.</p>
        </section>`;
      return true;
    }
    return false;
  }

  // Drive the ported render core (rollupAdapter.toViewModel → render.renderAll). An
  // empty registry renders the first-run onboarding (with candidate cwds derived from
  // /api/sessions); otherwise the full rollup grid.
  function renderWrap() {
    if (renderLoadingOrError()) return;
    renderer.renderAll(view.data.length === 0 ? { empty: true, candidates: (view.candidates || []).length } : {});
  }

  // ── cold-start onboarding (impl-plan S9) ──
  // Derive candidate project roots CLIENT-SIDE from GET /api/sessions cwds (prefer client-derive
  // to stay frontend-only). A candidate is a cwd pi has sessions in that no registered project
  // root already covers (longest-prefix). Sorted by session count so the busiest folder leads.
  async function refreshCandidates() {
    try {
      const res = await fetch("/api/sessions", { headers: api.headers() });
      if (!res.ok) { view.candidates = []; return; }
      const data = await res.json();
      const sessions: Array<{ cwd?: string }> = Array.isArray(data?.sessions) ? data.sessions : [];
      // Roots already registered — a candidate under one of these is NOT offered again.
      const registeredRoots = state.rollups.flatMap((r) => r.project?.roots ?? []);
      const covered = (cwd: string) => registeredRoots.some((root) => cwd === root || cwd.startsWith(root.endsWith("/") ? root : root + "/"));
      const byCwd = new Map<string, number>();
      for (const s of sessions) {
        const cwd = (s.cwd || "").trim();
        if (!cwd || covered(cwd)) continue;
        byCwd.set(cwd, (byCwd.get(cwd) || 0) + 1);
      }
      view.candidates = Array.from(byCwd.entries())
        .map(([path, n]) => ({ path, display: prettyPath(path), name: basename(path), sessions: n }))
        .sort((a, b) => b.sessions - a.sessions || a.path.localeCompare(b.path));
    } catch {
      view.candidates = [];
    }
  }

  // Register a candidate (or "Add a project") → POST /api/projects {name, roots}; then refetch the
  // rollups so the freshly-registered project re-renders into the grid (needs-setup, no DoD yet —
  // an honest "?" ring, never a fabricated percent). The toast names the real API.
  async function registerProject(name: string, path: string) {
    const root = (path || "").trim();
    if (!root) { showToast("Pick a folder to register, or start a session first."); return; }
    const projName = (name || basename(root) || "New project").trim();
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ name: projName, roots: [root] }),
      });
      if (res.ok || res.status === 201) {
        showToast(`Registered <b>${escText(projName)}</b> — its sessions roll up by cwd-prefix. Set a Definition of Done to track progress.`);
        await refreshCandidates();
        await refetch();
      } else {
        showToast(`Couldn't register <b>${escText(projName)}</b> — ${escText(await res.text())}`);
      }
    } catch (error) {
      showToast(`Couldn't register <b>${escText(projName)}</b> — ${escText(error instanceof Error ? error.message : String(error))}`);
    }
  }

  // Start the user's first pi session, then close the overlay so they land in the live composer.
  // The next rollup folds the new session into a project by cwd-prefix.
  async function startFirstSession() {
    closeDashboard();
    try {
      await sessions.startNewSession();
    } catch (error) {
      addMessage("system", `Couldn't start a session: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function refetch() {
    const token = ++fetchToken;
    state.loading = true;
    state.error = null;
    if (open) renderWrap();
    try {
      const res = await fetch("/api/rollups", { headers: api.headers() });
      if (token !== fetchToken) return; // a newer fetch superseded this one
      if (res.status === 401) {
        state.error = "Unauthorized";
        state.loading = false;
        if (open) renderWrap();
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (token !== fetchToken) return;
      state.rollups = Array.isArray(data?.rollups) ? (data.rollups as ProjectRollup[]) : [];
      const vm = toViewModel(state.rollups);
      view.data = vm.data;
      view.SESS = vm.SESS;
      // Cold-start: an empty registry renders the first-run onboarding, which needs candidate
      // cwds derived from /api/sessions. Fetch them BEFORE the empty render so the card shows
      // real folders to register, not a bare disclaimer (impl-plan S9).
      if (view.data.length === 0) {
        await refreshCandidates();
        if (token !== fetchToken) return;
      }
      state.loading = false;
      if (open) renderWrap();
    } catch (error) {
      if (token !== fetchToken) return;
      state.loading = false;
      state.error = error instanceof Error ? error.message : String(error);
      if (open) renderWrap();
      addMessage("system", `Failed to load project rollups: ${state.error}`, "error");
    }
  }

  function reveal() {
    open = true;
    elements.dashboardView.hidden = false;
  }

  function hide() {
    open = false;
    elements.dashboardView.hidden = true;
  }

  function openDashboard() {
    if (open) return;
    hideContextBand(); // the band is the drill-in frame; reopening the dashboard supersedes it
    // Establish the "since you last looked" baseline from the previous visit, then record
    // this visit so the next open compares against it.
    view.lastVisit = readLastVisit();
    writeLastVisit();
    reveal();
    // Show the loading hero (not the empty-onboarding flash) until the first fetch lands.
    if (view.data.length === 0) state.loading = true;
    renderWrap();
    void refetch();
  }

  function closeDashboard() {
    if (!open) return;
    closeDodDrawer(); // a left-open authoring drawer must not survive the overlay closing
    hide();
  }

  function toggle() {
    if (open) closeDashboard();
    else openDashboard();
  }

  function applyRollupChange(_projectId?: string) {
    if (!open) return; // only the open dashboard refetches
    if (refetchTimer !== undefined) window.clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => {
      refetchTimer = undefined;
      void refetch();
    }, REFETCH_DEBOUNCE_MS);
  }

  // ── undo toast (ported from the mockup showToast L2249-2256) ──
  // Mounted INSIDE #dashboardView (the `.toast` CSS is scoped under it), so it rides above the
  // overlay and disappears when the overlay closes. `undoFn` renders an Undo button that fires the
  // inverse action (e.g. the inverse sign-off PATCH).
  let toastTimer: number | undefined;
  function showToast(msg: string, undoFn?: () => void) {
    let toast = elements.dashboardView.querySelector<HTMLDivElement>("#dashboardToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "dashboardToast";
      toast.className = "toast";
      elements.dashboardView.appendChild(toast);
    }
    toast.innerHTML = `<span>${msg}</span>` + (undoFn ? `<button class="undo" id="dashboardToastUndo">Undo</button>` : "");
    toast.classList.add("show");
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast?.classList.remove("show"), 5200);
    const undo = toast.querySelector<HTMLButtonElement>("#dashboardToastUndo");
    if (undo) undo.onclick = () => { undoFn?.(); toast?.classList.remove("show"); };
  }
  // HTML-escape for toast copy (the renderer's `esc` is private to createRenderer).
  function escText(value?: string) {
    return String(value ?? "").replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");
  }

  // ── manual sign-off — OPTIMISTIC (impl-plan S7 + HARD RULE) ──
  // Flip the gate locally + re-render immediately, THEN fire PATCH /api/dod/criterion/:id {met}.
  // On failure: revert the local flip + error toast. Undo sends the INVERSE PATCH. Sign-off is
  // NEVER fused with merge — the toast copy says so, and there is no merge call here.
  async function patchCriterion(criterionId: string, met: boolean): Promise<boolean> {
    try {
      const res = await fetch(`/api/dod/criterion/${encodeURIComponent(criterionId)}`, {
        method: "PATCH",
        headers: api.headers(),
        body: JSON.stringify({ met }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  function flipLocal(sessionId: string, met: boolean) {
    const ref = view.SESS[sessionId];
    if (!ref) return;
    view.signed[sessionId] = met;
    const gate = ref.s._gate;
    if (gate) gate.met = met;
  }
  function signOff(sessionId: string) {
    const ref = view.SESS[sessionId];
    if (!ref) return;
    const critId = ref.s._gate?.id;
    if (!critId) return; // no manual gate to sign off (read-only evidence) — nothing to PATCH
    flipLocal(sessionId, true);
    renderer.renderSignoff();
    showToast(`<b>${escText(ref.s.name)}</b> signed off — merge is a separate step.`, () => {
      // Undo: inverse flip locally + inverse PATCH.
      flipLocal(sessionId, false);
      renderer.renderSignoff();
      void patchCriterion(critId, false);
    });
    void patchCriterion(critId, true).then((ok) => {
      if (!ok) {
        // Server rejected — revert the optimistic flip and surface the failure.
        flipLocal(sessionId, false);
        renderer.renderSignoff();
        showToast(`Couldn't sign off <b>${escText(ref.s.name)}</b> — try again.`);
      }
    });
  }
  function signOffAll() {
    const flipped: Array<{ id: string; critId: string }> = [];
    Object.values(view.SESS).forEach(({ s }) => {
      if (s.status === "sign" && !renderer.signPending(s.id) && !view.signed[s.id] && s._gate?.id) {
        flipLocal(s.id, true);
        flipped.push({ id: s.id, critId: s._gate.id });
      }
    });
    if (!flipped.length) return;
    renderer.renderSignoff();
    showToast(`<b>${flipped.length}</b> signed off — merges are separate steps.`, () => {
      flipped.forEach(({ id }) => flipLocal(id, false));
      renderer.renderSignoff();
      flipped.forEach(({ critId }) => void patchCriterion(critId, false));
    });
    flipped.forEach(({ id, critId }) => {
      void patchCriterion(critId, true).then((ok) => {
        if (!ok) { flipLocal(id, false); renderer.renderSignoff(); }
      });
    });
  }

  // ── recheck (impl-plan S7 STUB) ──
  // On-demand re-check of a stale/unrun command DoD. The full command runner is S10; here we POST
  // the stub /api/dod/evaluate {criterionId}, show the neutral pulsing "_evaluating" ring, then let
  // the realtime rollup_changed echo (or a refetch) clear it. Never spawns a command on render.
  function recheckCard(sessionId: string) {
    const ref = view.SESS[sessionId];
    if (!ref) return;
    const s = ref.s;
    const critId = s.crit?.find((c) => c.src === "command" && !c.gate)?.id ?? s._gate?.id;
    s._evaluating = true;
    renderer.renderGrid();
    showToast(`Re-checking <b>${escText(s.name)}</b>… (on-demand command DoD)`);
    void fetch("/api/dod/evaluate", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify(critId ? { criterionId: critId } : { sessionId }),
    }).catch(() => undefined).finally(() => {
      // The eval endpoint lands in S10; until then clear the pulsing ring and re-render from the
      // server snapshot (a fresh refetch reconciles any change the stub produced).
      s._evaluating = false;
      renderer.renderGrid();
      void refetch();
    });
  }

  // ── DoD authoring drawer (impl-plan S10) ──
  // The authoring flow is keyed to a WORKSTREAM (DoD is stored per-workstream and PUT to
  // /api/workstreams/:id/dod), reached by clicking "Define done" on any unset session row.
  // It is a modal panel mounted INSIDE #dashboardView (its .dodDrawer CSS is scoped there),
  // so it rides above the grid and never touches the host document. On save it PUTs the
  // structured criteria, then refetches /api/rollups so the ring updates to honest k-of-n —
  // no fabricated percent, no client re-derivation of the saved progress.
  //
  // The evaluator catalog mirrors the validated mockup (index.html L2899-2906): auto-computing
  // evaluators (git/session) re-check on every read with zero upkeep and lead; command + manual
  // follow. Each maps to a REAL structured `source.kind` the server normalizer accepts.
  type DraftCrit = { text: string; source: DodSource; gate?: boolean };
  type DodSource =
    | { kind: "manual" }
    | { kind: "git_clean" }
    | { kind: "git_ahead_zero" }
    | { kind: "git_merged"; into: string }
    | { kind: "session_idle"; sessionId: string }
    | { kind: "command"; cwd: string; cmd: string };

  const DOD_EVALUATORS: Array<{
    key: string;
    fam: string;
    label: string;
    auto: boolean;
    make: (ctx: { cwd: string; sessionId: string }) => DodSource;
  }> = [
    { key: "git_merged", fam: "git", label: "Branch merged into main", auto: true, make: () => ({ kind: "git_merged", into: "main" }) },
    { key: "git_clean", fam: "git", label: "Working tree clean", auto: true, make: () => ({ kind: "git_clean" }) },
    { key: "git_ahead_zero", fam: "git", label: "Branch fully pushed", auto: true, make: () => ({ kind: "git_ahead_zero" }) },
    { key: "session_idle", fam: "runtime", label: "Session idle (loop settled)", auto: true, make: (ctx) => ({ kind: "session_idle", sessionId: ctx.sessionId }) },
    { key: "command", fam: "command", label: "A test/lint command exits 0", auto: false, make: (ctx) => ({ kind: "command", cwd: ctx.cwd, cmd: "npm test" }) },
    { key: "manual", fam: "manual", label: "A manual boolean I check", auto: false, make: () => ({ kind: "manual" }) },
  ];

  // `synthetic` flags the rollup-time "Unfiled" bucket (`${projectId}:unfiled`) which has NO stored
  // workstream to PUT to. Authoring a DoD on it CREATES a real workstream under the project (POST
  // /api/projects/:id/workstreams with the criteria + the session attached), then the next /api/rollups
  // folds the session into that real workstream with an honest k-of-n ring.
  let drawer:
    | { workstreamId: string; projectId: string; synthetic: boolean; wsName: string; cwd: string; sessionId: string; draft: DraftCrit[] }
    | null = null;

  // The structured `source.kind` → the short evaluator-family label shown on each draft chip.
  function famOf(source: DodSource): string {
    switch (source.kind) {
      case "git_clean":
      case "git_ahead_zero":
      case "git_merged": return "git";
      case "command": return "command";
      case "session_idle": return "runtime";
      default: return "manual";
    }
  }

  function drawerEl(): HTMLDivElement {
    let el = elements.dashboardView.querySelector<HTMLDivElement>("#dashboardDodDrawer");
    if (!el) {
      el = document.createElement("div");
      el.id = "dashboardDodDrawer";
      el.className = "dodDrawer";
      el.hidden = true;
      elements.dashboardView.appendChild(el);
    }
    return el;
  }

  // Open the authoring drawer for the workstream that owns `sessionId`. Seeds the draft from any
  // existing criteria so re-opening edits rather than wipes (the server PUT replaces the full set).
  function openDodDrawer(sessionId: string) {
    const ref = view.SESS[sessionId];
    if (!ref) return;
    const ws = ref.w;
    const seed: DraftCrit[] = (ref.s.crit ?? [])
      .map((c) => {
        const kind = (c.src || "manual") as DodSource["kind"];
        let source: DodSource;
        if (kind === "git_merged") source = { kind: "git_merged", into: "main" };
        else if (kind === "git_clean") source = { kind: "git_clean" };
        else if (kind === "git_ahead_zero") source = { kind: "git_ahead_zero" };
        else if (kind === "session_idle") source = { kind: "session_idle", sessionId };
        else if (kind === "command") source = { kind: "command", cwd: ref.s.cwd ?? "", cmd: "npm test" };
        else source = { kind: "manual" };
        return { text: c.text ?? "", source, gate: c.gate };
      });
    const synthetic = ws.id.endsWith(":unfiled");
    drawer = {
      workstreamId: ws.id,
      projectId: ref.p.id,
      synthetic,
      // For the synthetic Unfiled bucket, author a fresh, descriptively-named workstream rather
      // than literally calling it "Unfiled" (which would be a confusing real workstream name).
      wsName: synthetic ? (ref.s.name || "New workstream") : ws.name,
      cwd: ref.s.cwd ?? "",
      sessionId,
      draft: seed,
    };
    renderDrawer();
  }

  function closeDodDrawer() {
    drawer = null;
    const el = elements.dashboardView.querySelector<HTMLDivElement>("#dashboardDodDrawer");
    if (el) { el.hidden = true; el.innerHTML = ""; el.classList.remove("open"); }
  }

  function renderDrawer() {
    if (!drawer) { closeDodDrawer(); return; }
    const el = drawerEl();
    const auto = DOD_EVALUATORS.filter((e) => e.auto);
    const other = DOD_EVALUATORS.filter((e) => !e.auto);
    const pick = (arr: typeof DOD_EVALUATORS) => arr
      .map((e) => `<button class="dodpick-b${e.auto ? " auto" : ""}" data-critadd="${e.key}"><span>+ ${escText(e.label)}</span><span class="ev">${escText(e.fam)}${e.auto ? " · auto" : ""}</span></button>`)
      .join("");
    const draftList = drawer.draft
      .map((c, i) => `<li><span class="fam">${escText(famOf(c.source))}</span><span class="grow-txt">${escText(c.text)}</span>${c.gate ? `<span class="gatepill" title="excluded from %; the manual gate you sign off">gate</span>` : ""}<span class="grow"></span><button data-critrm="${i}" title="remove criterion">✕</button></li>`)
      .join("");
    const count = drawer.draft.length;
    const note = count
      ? `${count} ${count > 1 ? "criteria" : "criterion"} drafted — saving starts honest k-of-n tracking via <span class="mono">PUT /api/workstreams/:id/dod</span>.`
      : "Pick at least one criterion to start tracking progress.";
    el.innerHTML = `
      <div class="dodDrawer-scrim" data-dod-close></div>
      <div class="dodDrawer-panel" role="dialog" aria-modal="true" aria-label="Define done">
        <div class="dodDrawer-head">
          <div>
            <div class="dodDrawer-eyebrow">Definition of Done</div>
            <div class="dodDrawer-title">${escText(drawer.wsName)}</div>
          </div>
          <button class="dashClose dodDrawer-x" data-dod-close title="Close">✕</button>
        </div>
        <div class="dodauthor" data-author>
          <div class="dah">Add / remove criteria, pick an evaluator</div>
          <div class="grp"><b>Auto-computing</b> · re-checked on every read, zero upkeep — these keep the ring honest with no maintenance</div>
          <div class="dodpick">${pick(auto)}</div>
          <div class="grp"><b>On-demand / manual</b> · a command (re-run to refresh) or a boolean you toggle</div>
          <div class="dodpick">${pick(other)}</div>
          <div class="addrow"><input type="text" id="dodCritText" placeholder="…or describe a criterion in your own words"><button data-critaddtext>Add</button></div>
          <ul class="draft">${draftList || `<li class="empty">No criteria yet — the ring honestly shows "?" (not set), and this workstream is excluded from the project gauge until you add one.</li>`}</ul>
          <div class="saverow">
            <span class="note">${note}</span>
            <button class="btn primary sm" data-critsave ${count ? "" : "disabled"}>Save Definition of Done</button>
          </div>
        </div>
      </div>`;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("open"));
    const input = el.querySelector<HTMLInputElement>("#dodCritText");
    if (input) input.focus();
  }

  function addDraftEvaluator(key: string) {
    if (!drawer) return;
    const e = DOD_EVALUATORS.find((x) => x.key === key);
    if (!e) return;
    const source = e.make({ cwd: drawer.cwd, sessionId: drawer.sessionId });
    // The manual gate is the human sign-off; offer it as a gate so the ring's % excludes it (the
    // HARD RULE: a manual boolean is the only toggleable truth, and a sign-off gate is excluded
    // from the percent). Other evaluators are plain weighted criteria.
    drawer.draft.push({ text: e.label, source });
    renderDrawer();
  }
  function addDraftManual(text: string) {
    if (!drawer) return;
    const t = (text || "").trim();
    if (!t) return;
    drawer.draft.push({ text: t, source: { kind: "manual" } });
    renderDrawer();
  }
  function removeDraft(i: number) {
    if (!drawer || i < 0 || i >= drawer.draft.length) return;
    drawer.draft.splice(i, 1);
    renderDrawer();
  }

  // Persist the draft via PUT /api/workstreams/:id/dod {criteria}, then refetch /api/rollups so the
  // ring re-renders at the server's honest k-of-n. The criteria carry STRUCTURED source.kind the
  // registry normalizer accepts; weights default to 1 server-side. No fabricated percent here — the
  // ring updates only from the re-fetched ProgressSnapshot.
  async function saveDoD() {
    if (!drawer || !drawer.draft.length) return;
    const { projectId, synthetic, sessionId } = drawer;
    const wsId = drawer.workstreamId;
    const wsName = drawer.wsName;
    const criteria = drawer.draft.map((c) => ({
      text: c.text,
      source: c.source,
      ...(c.gate ? { gate: true } : {}),
      ...(c.source.kind === "manual" ? { met: false } : {}),
    }));
    try {
      let res: Response;
      if (synthetic) {
        // No stored workstream behind the Unfiled bucket → create a REAL one under the project,
        // carrying the criteria + the originating session so the next rollup folds it in. The
        // registry normalizer applies the same DoD validation as the PUT path.
        res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workstreams`, {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ name: wsName, sessionIds: [sessionId], dod: { criteria } }),
        });
      } else {
        res = await fetch(`/api/workstreams/${encodeURIComponent(wsId)}/dod`, {
          method: "PUT",
          headers: api.headers(),
          body: JSON.stringify({ criteria }),
        });
      }
      if (!res.ok) {
        showToast(`Couldn't save Definition of Done for <b>${escText(wsName)}</b> — ${escText(await res.text())}`);
        return;
      }
      closeDodDrawer();
      showToast(`Definition of Done saved for <b>${escText(wsName)}</b> — tracking honest k-of-n. Auto-evaluators re-check with zero upkeep.`);
      await refetch();
    } catch (error) {
      showToast(`Couldn't save Definition of Done for <b>${escText(wsName)}</b> — ${escText(error instanceof Error ? error.message : String(error))}`);
    }
  }

  // ── quick-reply chip → POST /api/prompt (answering IS continuing) ──
  // The chip text becomes a steer message on the session; on the 202 we toast and open the REAL
  // conversation so the user sees their reply land. cfill (drawer-prefill) routes here too.
  async function replyChip(sessionId: string, text: string) {
    const ref = view.SESS[sessionId];
    const cwd = ref?.s.cwd ?? "";
    let accepted = false;
    try {
      const res = await fetch("/api/prompt", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId, message: text }),
      });
      accepted = res.status === 202;
    } catch {
      accepted = false;
    }
    if (accepted) {
      showToast(`Replied to <b>${escText(ref?.s.name)}</b> — your answer continues the conversation.`);
      closeDashboard();
      await sessions.openSession(sessionId, cwd);
      showContextBand(sessionId);
    } else {
      showToast(`Couldn't send your reply — open the conversation to retry.`);
    }
  }

  // Find an overlay element by id WITHOUT touching the host document — keeps every
  // `data-jump` target scoped under #dashboardView (HARD RULE: nothing leaks out).
  function byId(id: string): HTMLElement | null {
    if (!id) return null;
    try {
      return elements.dashboardWrap.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    } catch {
      return null;
    }
  }

  // Drill-in / continue → the REAL session. Look up the session's cwd from the
  // adapter-built SESS index, close the overlay, then reuse the sessions controller's
  // open flow (POST /api/sessions/open → writeActiveSessionIdToUrl → refresh). The
  // landing target is the live conversation + composer — never a synthetic one.
  async function openSessionFromCard(sessionId: string) {
    const ref = view.SESS[sessionId];
    const cwd = ref?.s.cwd ?? "";
    closeDashboard();
    await sessions.openSession(sessionId, cwd);
    // Keep the oversight frame on the drill: render a compact context band (project › workstream
    // breadcrumb + k-of-n ring + DoD criteria) ABOVE the real conversation, so opening a session
    // from a rollup doesn't drop into a context-free full-view (review finding). It survives the
    // openSession clearMessages/refresh because it lives in its own element, not in #messages.
    showContextBand(sessionId);
  }

  // The oversight context band above the live conversation. It is a SNAPSHOT taken at drill-in
  // time (the dashboard is closed while it shows, so realtime refetch doesn't touch it); it clears
  // when you dismiss it, reopen the dashboard, or navigate to another session.
  function showContextBand(sessionId: string) {
    const html = renderer.contextBandHtml(sessionId);
    if (!html) { hideContextBand(); return; }
    elements.rollupContextBand.innerHTML = html;
    elements.rollupContextBand.classList.remove("open");
    elements.rollupContextBand.hidden = false;
  }
  function hideContextBand() {
    if (elements.rollupContextBand.hidden) return;
    elements.rollupContextBand.hidden = true;
    elements.rollupContextBand.classList.remove("open");
    elements.rollupContextBand.innerHTML = "";
  }

  // Ported from the mockup click delegation (index.html L3166-3213), scoped to
  // #dashboardView. S6 wires: data-open (overridden → real session), data-jump
  // (scroll + auto-expand), and the data-toggle expand/collapse family. Quick-reply
  // chips, sign-off, recheck, batch sign-off and focus-triage land in S7 — until then
  // render.ts ships them as `disabled` affordances, so they never reach here as live no-ops.
  function handleClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // Quick-reply chip → POST /api/prompt then open the session. Checked BEFORE data-open so a chip
    // inside a `data-open` session row routes to the reply, not a bare open.
    const reply = target.closest<HTMLElement>("[data-reply]");
    if (reply) {
      event.preventDefault();
      event.stopPropagation();
      const id = reply.getAttribute("data-reply");
      const text = reply.getAttribute("data-text") || "";
      if (id) void replyChip(id, text);
      return;
    }

    // Recheck a stale/unrun command DoD (S10 eval stub) — show the evaluating ring.
    const recheck = target.closest<HTMLElement>("[data-recheckcard]");
    if (recheck) {
      event.preventDefault();
      event.stopPropagation();
      const id = recheck.getAttribute("data-recheckcard");
      if (id) recheckCard(id);
      return;
    }

    // Manual sign-off (optimistic). data-signoff carries the GATE CRITERION id; we resolve the
    // owning session via the SESS index so the optimistic flip + PATCH target the right criterion.
    const so = target.closest<HTMLElement>("[data-signoff]");
    if (so) {
      event.preventDefault();
      event.stopPropagation();
      const critId = so.getAttribute("data-signoff") || "";
      const sessionId = Object.values(view.SESS).find(({ s }) => s._gate?.id === critId)?.s.id;
      if (sessionId) signOff(sessionId);
      return;
    }

    // Batch sign-off — flip every clean (non-pending) item at once with a single undo.
    if (target.closest("#signAll")) {
      event.preventDefault();
      event.stopPropagation();
      signOffAll();
      return;
    }

    const openEl = target.closest<HTMLElement>("[data-open]");
    if (openEl) {
      event.preventDefault();
      event.stopPropagation();
      const id = openEl.getAttribute("data-open");
      // "Define done" — an unset session (no DoD) routes to the authoring drawer for its workstream
      // (PUT /api/workstreams/:id/dod), NOT into the conversation. Every other status opens the
      // real session as before.
      if (id && view.SESS[id]?.s.status === "unset") openDodDrawer(id);
      else if (id) void openSessionFromCard(id);
      return;
    }

    // jump-links land ON the matching surface AND auto-expand collapsed targets.
    const jump = target.closest<HTMLElement>("[data-jump]");
    if (jump) {
      event.preventDefault();
      event.stopPropagation();
      const el = byId(jump.getAttribute("data-jump") || "");
      if (el) {
        const grp = el.closest(".grpcard");
        if (grp) grp.classList.add("open");
        if (el.classList.contains("grpcard") || el.classList.contains("done") || el.classList.contains("pcard")) el.classList.add("open");
        if (el.classList.contains("prow")) {
          el.classList.add("open");
          const body = el.nextElementSibling;
          if (body && body.classList.contains("prow-body")) body.classList.add("open");
        }
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    // Triage-all in focus — open the highest-priority need (FAILs + elicited blocks, ordered by
    // blast radius). Until a true multi-session focus queue lands, this drops into the first need's
    // REAL conversation so the user can start answering immediately.
    if (target.closest("#focusBtn")) {
      event.preventDefault();
      event.stopPropagation();
      const needs = Object.values(view.SESS)
        .map(({ s }) => s)
        .filter((s) => s.status === "fail" || (s.status === "block" && s.elicited))
        .sort((a, b) => (a.status === "block" ? 0 : 1) - (b.status === "block" ? 0 : 1) || String(a.id).localeCompare(String(b.id)));
      if (needs[0]) void openSessionFromCard(needs[0].id);
      return;
    }

    // generic "show all" reveal — Done/Planned groups + the dormant/needs lists.
    const more = target.closest<HTMLElement>("[data-toggle=more]");
    if (more) {
      event.stopPropagation();
      const mr = more.previousElementSibling as HTMLElement | null;
      if (mr && mr.classList.contains("more-rows")) mr.hidden = false;
      more.remove();
      return;
    }

    const tg = target.closest<HTMLElement>("[data-toggle]");
    if (tg) {
      const kind = tg.getAttribute("data-toggle");
      if (kind === "card") tg.closest(".pcard")?.classList.toggle("open");
      else if (kind === "ws") tg.closest(".ws")?.classList.toggle("open");
      else if (kind === "sessmore") {
        const ex = tg.previousElementSibling as HTMLElement | null;
        if (ex && ex.classList.contains("sess-extra")) ex.hidden = false;
        tg.remove();
      } else if (kind === "done") tg.closest(".done")?.classList.toggle("open");
      else if (kind === "grp") tg.closest(".grpcard")?.classList.toggle("open");
      else if (kind === "needmore") tg.closest(".needmore")?.classList.toggle("open");
      else if (kind === "prow") {
        tg.classList.toggle("open");
        const id = tg.getAttribute("data-rowp") || "";
        const body = id ? elements.dashboardWrap.querySelector<HTMLElement>(`[data-rowbody="${CSS.escape(id)}"]`) : null;
        if (body) body.classList.toggle("open");
      }
      return;
    }
  }

  function init() {
    elements.dashboardCloseButton.addEventListener("click", () => closeDashboard());
    // The opaque full-screen #dashboardView is the click target; clicking its scroll
    // surface (outside the centered .wrap) closes — no separate backdrop node needed.
    elements.dashboardView.addEventListener("click", (event) => {
      if (event.target === elements.dashboardView) closeDashboard();
    });
    // Delegated drill-in / continue / expand-collapse, scoped to the overlay.
    elements.dashboardWrap.addEventListener("click", handleClick);
    // DoD authoring drawer — its own delegated click + Enter handler (the drawer is a sibling of
    // .wrap, mounted lazily into #dashboardView, so it has its own listener wiring once).
    const drawerHost = drawerEl();
    drawerHost.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-dod-close]")) { closeDodDrawer(); return; }
      const add = target.closest<HTMLElement>("[data-critadd]");
      if (add) { addDraftEvaluator(add.getAttribute("data-critadd") || ""); return; }
      if (target.closest("[data-critaddtext]")) {
        const inp = drawerHost.querySelector<HTMLInputElement>("#dodCritText");
        if (inp) addDraftManual(inp.value);
        return;
      }
      const rm = target.closest<HTMLElement>("[data-critrm]");
      if (rm) { removeDraft(Number.parseInt(rm.getAttribute("data-critrm") || "-1", 10)); return; }
      if (target.closest("[data-critsave]")) { void saveDoD(); return; }
    });
    drawerHost.addEventListener("keydown", (event) => {
      const ke = event as KeyboardEvent;
      const target = ke.target as HTMLElement | null;
      if (target && target.id === "dodCritText" && ke.key === "Enter") {
        ke.preventDefault();
        addDraftManual((target as HTMLInputElement).value);
      }
    });
    // Drill-in context band: dismiss (×) or expand/collapse the DoD criteria list.
    elements.rollupContextBand.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-cb-close]")) { hideContextBand(); return; }
      if (target.closest("[data-cb-toggle]")) elements.rollupContextBand.classList.toggle("open");
    });
    // Switching to another session (drawer item, tab bar, or a new session) leaves the drilled
    // session, so the band's snapshot no longer applies — clear it.
    const clearOnNav = () => hideContextBand();
    elements.sessionListEl.addEventListener("click", clearOnNav);
    elements.sessionBarEl.addEventListener("click", clearOnNav);
    elements.sessionNewButton.addEventListener("click", clearOnNav);
    elements.newSessionHeaderButton.addEventListener("click", clearOnNav);
  }

  return {
    init,
    open: openDashboard,
    close: closeDashboard,
    isOpen: () => open,
    toggle,
    applyRollupChange,
  };
}
