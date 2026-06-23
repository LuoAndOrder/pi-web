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
import { readDashboardViewFromUrl, writeDashboardViewToUrl } from "../app/types.js";
import type { ProjectRollup } from "./types.js";
import { createRenderer, type RenderState } from "./render.js";
import { toViewModel } from "./rollupAdapter.js";

// Open/close can be driven either by a user gesture (push `?view=dashboard` onto
// history so Back/reload behave), by an explicit deep-link or launch default (replace,
// so the route isn't a spurious extra history entry), or by a `popstate` reconcile —
// where the URL is ALREADY the source of truth and must NOT be re-written (that would
// loop / corrupt the history stack).
type ViewSyncOptions = { syncUrl?: boolean; mode?: "push" | "replace" };

export type DashboardController = {
  init: () => void;
  open: (opts?: ViewSyncOptions) => void; // fetch /api/rollups, render, reveal overlay
  close: (opts?: ViewSyncOptions) => void; // hide overlay (keeps DOM)
  isOpen: () => boolean;
  toggle: () => void;
  applyRollupChange: (projectId?: string) => void; // debounced refetch on realtime
  // Reconcile the overlay's open/closed state to match `?view=dashboard` in the URL,
  // called from the app's `popstate` handler. Never writes the URL back.
  reconcileFromUrl: () => void;
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
  // Per-project realtime coalescing (S8). The server scopes rollup_changed to a single
  // dirty project; we collect those ids and splice ONLY those projects on flush via
  // GET /api/rollups/:id, falling back to a full refetch only when a registry change
  // (project_registry_changed, no projectId) needs the whole set re-assembled.
  const dirtyProjectIds = new Set<string>();
  let fullRefetchPending = false;
  const state: DashboardState = { rollups: [], loading: false, error: null };

  // The mockup-shaped view model the ported render core reads. `toViewModel` (the
  // adapter seam) fills `data`/`SESS` from the server `ProjectRollup[]`; the client
  // trusts the server `ProgressSnapshot` and never re-derives it here.
  const view: RenderState = { data: [], SESS: {}, signed: {}, lastVisit: null, _pingId: null, candidates: [], mnSelection: new Set<string>() };
  const renderer = createRenderer({
    wrap: elements.dashboardWrap,
    state: view,
    // Cold-start onboarding intents (S9), wired to the REAL REST surface.
    onboard: { onRegister: registerProject, onStartSession: startFirstSession },
  });

  function renderLoadingOrError(): boolean {
    if (state.error) {
      elements.dashboardWrap.innerHTML = `
        <section class="hero">
          <div class="eyebrow">Project Rollups</div>
          <h1 class="headline">Couldn't load rollups</h1>
          <p class="subline">${escText(state.error)}</p>
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

  // Rebuild the mockup-shaped view model from the current state.rollups and (when open)
  // re-render. The single seam from server ProjectRollup[] → renderer view model.
  //
  // Reconcile the optimistic sign-off overlay against server truth (review finding):
  // `view.signed[id]` is a PRE-ECHO optimism written by `flipLocal`; the server
  // `ProgressSnapshot` is the single source of truth after a refetch. Rebuild the map
  // from the fresh `_gate.met` so (a) it never grows unbounded over a long-lived
  // dashboard, and (b) a gate un-signed elsewhere (another tab / a reused criterion id)
  // can no longer keep rendering a stale "✓ Signed off" that the server contradicts.
  // Any still-in-flight optimistic flip is re-applied immediately after, so a refetch
  // landing mid-PATCH doesn't flicker the row back.
  function rebuildView() {
    const vm = toViewModel(state.rollups);
    view.data = vm.data;
    view.SESS = vm.SESS;
    reconcileSigned();
    pruneSelection();
  }

  // M4 — the multi-select set only ever holds sessions that are STILL in an Unfiled bucket.
  // After a refetch, a session that was assigned into a real workstream has left Unfiled, so
  // it's dropped from the selection (otherwise the bar would keep counting a row no longer
  // selectable). Mutates the set in place so the renderer's `state.mnSelection` reference holds.
  function unfiledSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const p of view.data) {
      for (const w of p.workstreams) {
        if (w._synthetic) w.sessions.forEach((s) => ids.add(s.id));
      }
    }
    return ids;
  }
  function pruneSelection() {
    const sel = view.mnSelection;
    if (!sel || !sel.size) return;
    const valid = unfiledSessionIds();
    for (const id of [...sel]) if (!valid.has(id)) sel.delete(id);
  }

  // Sessions with an optimistic sign-off PATCH still genuinely in flight — their local
  // flip must survive a refetch that lands before the server echo, so we don't prune them
  // in the reconcile. (Counts outstanding PATCHes via critInFlight, which — unlike a
  // settled critChain promise — reads 0 the moment a criterion is quiescent.)
  function hasPendingFlip(sessionId: string): boolean {
    const critId = view.SESS[sessionId]?.s._gate?.id;
    return !!critId && (critInFlight.get(critId) ?? 0) > 0;
  }
  function reconcileSigned() {
    const next: Record<string, boolean> = {};
    for (const sessionId of Object.keys(view.SESS)) {
      // Server truth is the gate's met flag (the adapter only surfaces an UNMET gate as
      // `_gate`, so a missing/already-met gate means the session is past sign-off). Keep
      // an optimistic `true` only while its PATCH is in flight (the pre-echo window) so a
      // refetch landing mid-PATCH doesn't flicker the row back to unsigned.
      const gate = view.SESS[sessionId].s._gate;
      const serverSigned = !gate || gate.met === true;
      // When the server already reports the gate met (or there is no unmet gate), the
      // renderer derives "signed" straight from `_gate` — no overlay entry needed. Only
      // a still-unmet gate with an in-flight PATCH retains its optimistic flip.
      if (!serverSigned && view.signed[sessionId] && hasPendingFlip(sessionId)) {
        next[sessionId] = true;
      }
    }
    view.signed = next;
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
      rebuildView();
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

  // Splice the dirty projects' updated rollups into state.rollups via the per-project
  // endpoint (GET /api/rollups/:id) instead of re-assembling the WHOLE fleet's git
  // fan-out on every terminal event in any one project (review finding — the server
  // already scopes rollup_changed to one project). A project that 404s (deleted) is
  // dropped from state. Falls back to a full refetch if we have no baseline yet.
  async function refetchDirtyProjects(ids: string[]) {
    if (!state.rollups.length) { await refetch(); return; }
    const token = ++fetchToken;
    let changed = false;
    await Promise.all(ids.map(async (id) => {
      try {
        const res = await fetch(`/api/rollups/${encodeURIComponent(id)}`, { headers: api.headers() });
        if (token !== fetchToken) return;
        if (res.status === 404) {
          const idx = state.rollups.findIndex((r) => r.project?.id === id);
          if (idx >= 0) { state.rollups.splice(idx, 1); changed = true; }
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        const one = data?.rollup as ProjectRollup | undefined;
        if (!one || !one.project?.id) return;
        const idx = state.rollups.findIndex((r) => r.project?.id === one.project.id);
        if (idx >= 0) state.rollups[idx] = one;
        else state.rollups.push(one);
        changed = true;
      } catch {
        /* a single project's splice failing must not blow up the others */
      }
    }));
    if (token !== fetchToken) return;
    if (changed) {
      rebuildView();
      if (open) renderWrap();
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

  // Mirror the overlay's open/closed state into the URL (`?view=dashboard`) so the route is
  // deep-linkable and survives reload + Back — exactly as `?sessionId=` works. `syncUrl:false`
  // (the popstate path) skips the write because the URL is already the source of truth.
  function syncUrl(isOpen: boolean, opts?: ViewSyncOptions) {
    if (opts?.syncUrl === false) return;
    writeDashboardViewToUrl(isOpen, opts?.mode ?? "push");
  }

  function openDashboard(opts?: ViewSyncOptions) {
    if (open) return;
    hideContextBand(); // the band is the drill-in frame; reopening the dashboard supersedes it
    // Establish the "since you last looked" baseline from the previous visit, then record
    // this visit so the next open compares against it.
    view.lastVisit = readLastVisit();
    writeLastVisit();
    reveal();
    syncUrl(true, opts);
    // Show the loading hero (not the empty-onboarding flash) until the first fetch lands.
    if (view.data.length === 0) state.loading = true;
    renderWrap();
    void refetch();
  }

  function closeDashboard(opts?: ViewSyncOptions) {
    if (!open) return;
    closeDodDrawer(); // a left-open authoring drawer must not survive the overlay closing
    hide();
    syncUrl(false, opts);
  }

  function toggle() {
    if (open) closeDashboard();
    else openDashboard();
  }

  // Bring the overlay in line with `?view=dashboard` after a Back/Forward navigation.
  // The URL already reflects the desired state, so neither branch re-writes it.
  function reconcileFromUrl() {
    const wantOpen = readDashboardViewFromUrl();
    if (wantOpen && !open) openDashboard({ syncUrl: false });
    else if (!wantOpen && open) closeDashboard({ syncUrl: false });
  }

  // Realtime entry point (S8). A `rollup_changed{projectId}` marks ONE project dirty
  // (spliced via the per-project endpoint on flush); a `project_registry_changed`
  // (no projectId) forces a full refetch since the whole set may have re-shaped. The
  // 250ms debounce coalesces a burst either way; a full refetch supersedes any pending
  // per-project splices in the same window.
  function applyRollupChange(projectId?: string) {
    if (!open) return; // only the open dashboard refetches
    if (typeof projectId === "string" && projectId) dirtyProjectIds.add(projectId);
    else fullRefetchPending = true;
    if (refetchTimer !== undefined) window.clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => {
      refetchTimer = undefined;
      if (fullRefetchPending) {
        fullRefetchPending = false;
        dirtyProjectIds.clear();
        void refetch();
        return;
      }
      const ids = Array.from(dirtyProjectIds);
      dirtyProjectIds.clear();
      if (ids.length) void refetchDirtyProjects(ids);
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
  //
  // Concurrency guard (review finding): sign-off → revert-on-fail AND Undo can race —
  // two PATCHes for ONE criterion could land server-side out of order, leaving persisted
  // `met` out of sync with the rendered flip. A per-criterion GENERATION token (mirrors
  // refetch's fetchToken) makes the LAST user intent win: each new intent bumps the
  // criterion's gen and serializes its PATCH after any in-flight one; a PATCH result whose
  // gen is stale is IGNORED (a newer intent already superseded it). The next /api/rollups
  // reconciles the truth regardless.
  // critGen/critChain hold the serialization state for the CURRENTLY-active PATCHes of a
  // criterion; both are EVICTED once the criterion goes quiescent (critInFlight → 0 and
  // the settled promise is still the chain tail) so a long-lived dashboard that signs off
  // many criteria leaves no residue (review finding — they used to grow unbounded).
  const critGen = new Map<string, number>();
  const critChain = new Map<string, Promise<boolean>>();
  // Count of genuinely outstanding PATCHes per criterion (incremented when an intent is
  // queued, decremented when it settles). `reconcileSigned` reads this to keep an
  // optimistic flip across a refetch ONLY while its PATCH is actually in flight; it also
  // drives the critChain/critGen eviction above so a quiescent criterion leaves nothing.
  const critInFlight = new Map<string, number>();

  // Serialize PATCHes for one criterion so they can't land out of order. Returns whether
  // THIS call's intent is still the latest (its gen is current) AND the PATCH succeeded.
  function patchCriterionGuarded(criterionId: string, met: boolean): Promise<boolean> {
    const gen = (critGen.get(criterionId) ?? 0) + 1;
    critGen.set(criterionId, gen);
    critInFlight.set(criterionId, (critInFlight.get(criterionId) ?? 0) + 1);
    const prior = critChain.get(criterionId) ?? Promise.resolve(true);
    const settled = prior
      .catch(() => false)
      .then(async () => {
        // A newer intent superseded this one before its turn — skip the network call.
        if (critGen.get(criterionId) !== gen) return false;
        try {
          const res = await fetch(`/api/dod/criterion/${encodeURIComponent(criterionId)}`, {
            method: "PATCH",
            headers: api.headers(),
            body: JSON.stringify({ met }),
          });
          // Only report success if we're STILL the latest intent (else a later one owns the truth).
          return res.ok && critGen.get(criterionId) === gen;
        } catch {
          return false;
        }
      });
    // Decrement the in-flight counter once this PATCH settles (success or failure), so
    // `hasPendingFlip` stops protecting its optimistic entry from the next reconcile.
    // When a criterion goes fully quiescent (no more in-flight PATCHes) AND this settled
    // promise is still the tail of its chain, evict its `critChain`/`critGen` residue too
    // — otherwise every distinct criterion ever signed off leaks a resolved promise +
    // a gen counter for the life of the dashboard (review finding). A newer intent that
    // raced in already replaced `critChain` with its own promise, so the identity check
    // keeps us from deleting a live chain.
    const next: Promise<boolean> = settled.finally(() => {
      const remaining = (critInFlight.get(criterionId) ?? 1) - 1;
      if (remaining > 0) {
        critInFlight.set(criterionId, remaining);
      } else {
        critInFlight.delete(criterionId);
        if (critChain.get(criterionId) === next) {
          critChain.delete(criterionId);
          critGen.delete(criterionId);
        }
      }
    });
    critChain.set(criterionId, next);
    return next;
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
      // Undo: inverse flip locally + serialized inverse PATCH (bumps the gen so a late
      // sign-off PATCH result for this criterion is ignored).
      flipLocal(sessionId, false);
      renderer.renderSignoff();
      void patchCriterionGuarded(critId, false);
    });
    void patchCriterionGuarded(critId, true).then((ok) => {
      // Revert ONLY when the PATCH failed AND the local state still reflects THIS sign-off
      // (view.signed===true). If a newer Undo superseded it, the local state is already
      // false and that intent owns the truth — don't churn it back. The next /api/rollups
      // reconciles regardless. This avoids the double-flip the un-guarded revert caused.
      if (!ok && view.signed[sessionId] === true) {
        flipLocal(sessionId, false);
        renderer.renderSignoff();
        showToast(`Couldn't sign off <b>${escText(ref.s.name)}</b> — try again.`);
      }
    });
  }
  function signOffAll() {
    const flipped: Array<{ id: string; critId: string }> = [];
    // Skip sessions inside archived/abandoned workstreams: the user explicitly shelved them,
    // so a fleet-wide batch sign-off must not PATCH a manual gate on shelved work. Mirrors
    // the render-side activeSess() filter so counts and actions stay consistent.
    Object.values(view.SESS).forEach(({ s, w }) => {
      if (w._inactive) return;
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
      flipped.forEach(({ critId }) => void patchCriterionGuarded(critId, false));
    });
    flipped.forEach(({ id, critId }) => {
      // Same generation guard as signOff: revert only if the PATCH failed AND this
      // sign-off is still the latest local intent for that session.
      void patchCriterionGuarded(critId, true).then((ok) => {
        if (!ok && view.signed[id] === true) { flipLocal(id, false); renderer.renderSignoff(); }
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
    // resolveDodTarget (server) routes only by criterionId / workstreamId / projectId — a body keyed
    // by sessionId matches NOTHING (404). When the card has no command criterion / manual gate, fall
    // back to the owning WORKSTREAM's DoD (then the project's), resolved via the SESS index, so the
    // eval request is always routable instead of silently 404ing (review finding).
    const body = critId
      ? { criterionId: critId }
      : !ref.w.id.endsWith(":unfiled")
        ? { workstreamId: ref.w.id }
        : { projectId: ref.p.id };
    void fetch("/api/dod/evaluate", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify(body),
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

  // The repo's integration branch fallback when one can't be detected. `git_merged` is
  // evaluated as `git merge-base --is-ancestor <branch> <into>`; on a repo whose default
  // branch is `master` (or anything non-`main`), a hardcoded `into:"main"` hits git exit
  // 128 (ref unavailable) and the criterion can NEVER be met (review finding). The drawer
  // detects the repo's default branch and lets the user override the target per criterion.
  const DEFAULT_MERGE_TARGET = "main";

  const DOD_EVALUATORS: Array<{
    key: string;
    fam: string;
    label: string;
    auto: boolean;
    make: (ctx: { cwd: string; sessionId: string; defaultBranch: string }) => DodSource;
  }> = [
    { key: "git_merged", fam: "git", label: "Branch merged into target", auto: true, make: (ctx) => ({ kind: "git_merged", into: ctx.defaultBranch || DEFAULT_MERGE_TARGET }) },
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
  // `defaultBranch` is the repo's detected integration branch (origin/HEAD short → current
  // branch → "main"); it seeds new `git_merged` criteria so they target a ref that exists.
  let drawer:
    | { workstreamId: string; projectId: string; synthetic: boolean; wsName: string; cwd: string; sessionId: string; defaultBranch: string; draft: DraftCrit[] }
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

  // Whether a draft criterion is one the RING can score — i.e. it lands in the
  // server's `evaluable` set (server/rollups/progress.ts: !gate && !rootScoped &&
  // !livenessOnly). A sign-off gate, a repo-root `git_clean`, and a liveness-only
  // `session_idle` are all excluded from the percent, so a DoD made of ONLY those
  // produces `emptyProgress` (allMet hardcoded false) and the workstream strands at
  // "planned" forever with no reachable sign-off. This predicate lets saveDoD refuse
  // such a dead-end draft. Mirror the server's exclusion set exactly.
  function isScorableCriterion(c: DraftCrit): boolean {
    if (c.gate) return false;
    if (c.source.kind === "git_clean") return false; // rootScoped — surfaced once at repo scope
    if (c.source.kind === "session_idle") return false; // livenessOnly — never a completion %
    return true;
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

  // Detect the repo's integration branch for a session's cwd so new `git_merged` criteria
  // target a ref that EXISTS (review finding: a hardcoded "main" strands a `master` repo at
  // git exit 128 forever). Reads GET /api/git/status?sessionId, preferring origin/HEAD's
  // short name, then the current branch, then "main". Best-effort — the drawer's editable
  // target input lets the user correct it regardless.
  async function detectDefaultBranch(sessionId: string): Promise<string> {
    try {
      const res = await fetch(`/api/git/status?sessionId=${encodeURIComponent(sessionId)}`, { headers: api.headers() });
      if (!res.ok) return DEFAULT_MERGE_TARGET;
      const st = await res.json();
      const remote = typeof st?.defaultRemoteBranch === "string" ? st.defaultRemoteBranch.trim() : "";
      // origin/HEAD short form is "origin/main" — strip the remote prefix to a local ref.
      const fromRemote = remote.includes("/") ? remote.slice(remote.indexOf("/") + 1) : remote;
      const branch = typeof st?.branch === "string" ? st.branch.trim() : "";
      return fromRemote || branch || DEFAULT_MERGE_TARGET;
    } catch {
      return DEFAULT_MERGE_TARGET;
    }
  }

  // Open the authoring drawer for the workstream that owns `sessionId`. Seeds the draft from any
  // existing criteria so re-opening edits rather than wipes (the server PUT replaces the full set).
  async function openDodDrawer(sessionId: string) {
    const ref = view.SESS[sessionId];
    if (!ref) return;
    const ws = ref.w;
    const defaultBranch = await detectDefaultBranch(sessionId);
    // A newer drawer-open superseded this async detection — abandon this stale open.
    if (!view.SESS[sessionId]) return;
    const seed: DraftCrit[] = (ref.s.crit ?? [])
      .map((c) => {
        const kind = (c.src || "manual") as DodSource["kind"];
        let source: DodSource;
        // Re-seed git_merged from the REAL stored target (c.into), not a hardcoded "main".
        if (kind === "git_merged") source = { kind: "git_merged", into: (c.into || defaultBranch || DEFAULT_MERGE_TARGET) };
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
      defaultBranch,
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
    // A sign-off gate must be a manual boolean (data-model §5.2): only `manual`-source
    // criteria offer the gate toggle. Toggling marks the criterion as the human sign-off —
    // excluded from the percent and surfaced as the one-click sign-off the S7 path drives.
    const draftList = drawer.draft
      .map((c, i) => {
        const gateToggle = c.source.kind === "manual"
          ? `<button class="critgate${c.gate ? " on" : ""}" data-critgate="${i}" title="${c.gate ? "this manual boolean is the sign-off gate (excluded from %) — click to make it a plain criterion" : "make this the sign-off gate you approve (excluded from %)"}" aria-pressed="${c.gate ? "true" : "false"}">${c.gate ? "gate ✓" : "make gate"}</button>`
          : "";
        // git_merged needs an EDITABLE target branch — a hardcoded "main" can never be met on
        // a repo whose default branch is "master" (review finding). The input is bound to
        // source.into and persisted as the criterion's target ref.
        const mergeTarget = c.source.kind === "git_merged"
          ? `<label class="critinto" title="the branch your work must be merged into (this repo's default branch by default)">into <input type="text" class="critinto-in" data-critinto="${i}" value="${escText(c.source.into)}" spellcheck="false"></label>`
          : "";
        return `<li><span class="fam">${escText(famOf(c.source))}</span><span class="grow-txt">${escText(c.text)}</span>${mergeTarget}${c.gate ? `<span class="gatepill" title="excluded from %; the manual gate you sign off">gate</span>` : ""}<span class="grow"></span>${gateToggle}<button data-critrm="${i}" title="remove criterion">✕</button></li>`;
      })
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
    const source = e.make({ cwd: drawer.cwd, sessionId: drawer.sessionId, defaultBranch: drawer.defaultBranch });
    // The manual gate is the human sign-off; offer it as a gate so the ring's % excludes it (the
    // HARD RULE: a manual boolean is the only toggleable truth, and a sign-off gate is excluded
    // from the percent). Other evaluators are plain weighted criteria.
    drawer.draft.push({ text: e.label, source });
    renderDrawer();
  }
  // Update a git_merged draft criterion's target branch (source.into) from its inline input.
  // Mutates the draft model directly (no re-render) so typing isn't interrupted; saveDoD reads
  // the final value. An empty target falls back to the detected default so we never PUT a
  // criterion the normalizer drops (it requires a non-empty `into`).
  function setDraftMergeTarget(i: number, into: string) {
    if (!drawer || i < 0 || i >= drawer.draft.length) return;
    const c = drawer.draft[i];
    if (c.source.kind !== "git_merged") return;
    c.source.into = into.trim() || drawer.defaultBranch || DEFAULT_MERGE_TARGET;
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
  // Flip a manual criterion into / out of the sign-off gate. Gates are manual-only
  // (data-model §5.2) and excluded from the percent; this is the control that makes a
  // fully user-authored DoD reach "done · awaiting sign-off" instead of auto-merging.
  function toggleDraftGate(i: number) {
    if (!drawer || i < 0 || i >= drawer.draft.length) return;
    const c = drawer.draft[i];
    if (c.source.kind !== "manual") return;
    c.gate = !c.gate;
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
    // Auto-pair: a DoD made only of auto/command criteria (no manual sign-off gate) would
    // reach 100% and flip straight to "merged", skipping human sign-off entirely. Mirror the
    // mockup fixtures (index.html L1019) by appending a manual "you review & sign off" gate so
    // the workstream lands at "done · awaiting sign-off" and the S7 sign-off path is reachable.
    const draft = [...drawer.draft];
    // Refuse a dead-end DoD: one made of ONLY excluded-from-percent criteria (sign-off
    // gates, repo-root git_clean, liveness-only session_idle) computes to emptyProgress
    // (allMet hardcoded false) server-side, so deriveUiStatus falls through to "planned"
    // forever and the one-click sign-off path is never reachable. The auto-pair below
    // only guarantees a GATE exists — it does NOT guarantee a criterion the ring can
    // score — so guard before it. (A `command` IS scorable, just unrun until /api/dod/
    // evaluate runs it, so a gate+command DoD is allowed and lands at "queued".)
    if (!draft.some(isScorableCriterion)) {
      showToast(
        `Add a criterion the ring can score (a command, a git check, or a plain boolean) before the sign-off gate — a gate-only Definition of Done can never reach "done · awaiting sign-off".`,
      );
      return;
    }
    if (!draft.some((c) => c.gate)) {
      draft.push({ text: "You review & sign off", source: { kind: "manual" }, gate: true });
    }
    const criteria = draft.map((c) => ({
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

  // ── merge affordance → POST /api/prompt (the merge button's real action) ──
  // Sign-off ≠ merge: this is a SEPARATE step that asks the agent to merge the session's
  // branch into main via a steer message, then opens the conversation so the user watches
  // it land — exactly what the button's tooltip claims (the old button only opened the
  // conversation and sent nothing, a UI honesty break; review finding). No local git merge
  // endpoint exists, so an agent prompt is the honest v1 path (impl-plan S11 / §6).
  async function mergeRequest(sessionId: string, branch: string) {
    const ref = view.SESS[sessionId];
    const cwd = ref?.s.cwd ?? "";
    const message = branch ? `merge ${branch} into main` : "merge this branch into main";
    let accepted = false;
    try {
      const res = await fetch("/api/prompt", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId, message }),
      });
      accepted = res.status === 202;
    } catch {
      accepted = false;
    }
    if (accepted) {
      showToast(`Asked pi to merge <b>${escText(branch || "the branch")}</b> → main — watch it land in the conversation.`);
      closeDashboard();
      await sessions.openSession(sessionId, cwd);
      showContextBand(sessionId);
    } else {
      showToast(`Couldn't send the merge request — open the conversation to retry.`);
    }
  }

  // ── M4: create & assign workstreams from the Unfiled bucket ─────────────────
  // The Unfiled bucket holds sessions matched to a project root but to no workstream. The
  // user organizes them straight from the UI (operability lens): multi-select rows → "New
  // workstream from selection" (name prompt → POST /api/projects/:id/workstreams with the
  // selected sessionIds) or "Move to existing" (PUT /api/workstreams/:id/sessions, UNION with
  // the target's current members). Plus one-click auto-group suggestion chips that pre-create
  // a workstream from a similarly-named cluster. After every mutation we refetch so the
  // assigned sessions leave Unfiled and fold under the new/target workstream.

  function selectionIds(): string[] {
    return Array.from(view.mnSelection ?? []);
  }

  // Toggle one Unfiled session's selection, then repaint just the Unfiled bucket(s) so the
  // assignment bar's count + the checked state update without collapsing the open grid.
  function toggleSelect(sessionId: string, on: boolean) {
    const sel = view.mnSelection ?? (view.mnSelection = new Set<string>());
    if (on) sel.add(sessionId);
    else sel.delete(sessionId);
    renderer.renderUnfiled();
  }
  function clearSelection() {
    view.mnSelection?.clear();
    renderer.renderUnfiled();
  }

  // Create a real workstream under `projectId` carrying `sessionIds` (the registry attaches
  // them at create time). Used by BOTH the manual "New workstream from selection" flow and the
  // one-click auto-group chip. `name` is required; the caller prompts / derives it.
  async function createWorkstreamWithSessions(projectId: string, name: string, sessionIds: string[]): Promise<boolean> {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workstreams`, {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ name, sessionIds }),
      });
      return res.ok || res.status === 201;
    } catch {
      return false;
    }
  }

  // "New workstream from selection" — prompt for a name, create the workstream with the
  // selected sessions, then refetch (which prunes them out of Unfiled).
  async function newWorkstreamFromSelection(projectId: string) {
    const ids = selectionIds();
    if (!ids.length) { showToast("Select at least one session first."); return; }
    const suggested = ids.length === 1 ? (view.SESS[ids[0]]?.s.name || "New workstream") : "New workstream";
    const name = (window.prompt(`Name the new workstream for ${ids.length} session${ids.length === 1 ? "" : "s"}:`, suggested) || "").trim();
    if (!name) return; // cancelled / empty → no-op (no fabricated default)
    const ok = await createWorkstreamWithSessions(projectId, name, ids);
    if (ok) {
      clearSelection();
      showToast(`Created <b>${escText(name)}</b> with ${ids.length} session${ids.length === 1 ? "" : "s"} — moved out of Unfiled.`);
      await refetch();
    } else {
      showToast(`Couldn't create <b>${escText(name)}</b> — try again.`);
    }
  }

  // "New workstream…" from a project's kebab — a SESSION-INDEPENDENT create path (operability
  // lens 1): a freshly registered folder with zero sessions still needs a way to spin up a
  // workstream and author its Definition of Done from the UI, not just via the API. We POST an
  // empty workstream (the registry accepts an empty/absent sessionIds), refetch so the new row
  // appears, then open the DoD drawer on it so the user lands straight in authoring. cwd defaults
  // to the project's first root so git/command criteria have a sensible base.
  async function newWorkstreamForProject(projectId: string) {
    const ctx = findProjectContext(projectId);
    const name = (window.prompt("Name the new workstream:", "") || "").trim();
    if (!name) return; // cancelled / empty → no-op (no fabricated default)
    let createdId: string | null = null;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workstreams`, {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ name }),
      });
      if (res.ok || res.status === 201) {
        const body = await res.json().catch(() => null) as { workstream?: { id?: string } } | null;
        createdId = body?.workstream?.id || null;
      }
    } catch {
      createdId = null;
    }
    if (!createdId) { showToast(`Couldn't create <b>${escText(name)}</b> — try again.`); return; }
    showToast(`Created <b>${escText(name)}</b> — set its Definition of Done to start tracking.`);
    await refetch();
    // Open the DoD drawer directly on the new (empty) workstream. No session backs it, so the
    // draft starts blank and saveDoD takes the non-synthetic PUT /dod path against this id.
    openDodDrawerForWorkstream(createdId, name, projectId, (ctx?.roots || [])[0] || "");
  }

  // Session-independent DoD-drawer open: used for an empty workstream that no session backs.
  // Mirrors openDodDrawer but seeds an empty draft, an empty sessionId (the session_idle auto
  // evaluator simply won't have a target — it stays an opt-in chip), and the project root as cwd
  // so command/git criteria default sensibly. saveDoD's non-synthetic branch PUTs /dod by id.
  async function openDodDrawerForWorkstream(workstreamId: string, wsName: string, projectId: string, cwd: string) {
    const defaultBranch = DEFAULT_MERGE_TARGET;
    drawer = {
      workstreamId,
      projectId,
      synthetic: false,
      wsName,
      cwd,
      sessionId: "",
      defaultBranch,
      draft: [],
    };
    renderDrawer();
  }

  // "Move to existing workstream" — attach the selected sessions to the picked workstream. The
  // PUT /api/workstreams/:id/sessions REPLACES the membership, so we UNION the target's current
  // sessionIds with the selection (else moving 1 session would detach the rest). Targets and
  // their current members come from the rollup view model (already loaded).
  function targetCurrentSessionIds(workstreamId: string): string[] {
    for (const p of view.data) {
      const w = [...(p.workstreams || []), ...(p.archivedWorkstreams || [])].find((x) => x.id === workstreamId);
      if (w) return w.sessions.map((s) => s.id);
    }
    return [];
  }
  async function moveSelectionToWorkstream(projectId: string) {
    const ids = selectionIds();
    if (!ids.length) { showToast("Select at least one session first."); return; }
    // Read the picker's chosen target from the live DOM (the <select> inside this project's bar).
    const wsEl = elements.dashboardWrap.querySelector<HTMLElement>(`.ws-unfiled[data-unfiled-project="${CSS.escape(projectId)}"]`);
    const sel = wsEl?.querySelector<HTMLSelectElement>("[data-mn-movesel]");
    const targetId = (sel?.value || "").trim();
    if (!targetId) { showToast("Pick a workstream to move the selection into."); return; }
    const union = Array.from(new Set([...targetCurrentSessionIds(targetId), ...ids]));
    const ctx = findWsContext(targetId);
    const targetName = ctx?.wsName || "workstream";
    try {
      const res = await fetch(`/api/workstreams/${encodeURIComponent(targetId)}/sessions`, {
        method: "PUT",
        headers: api.headers(),
        body: JSON.stringify({ sessionIds: union }),
      });
      if (res.ok) {
        clearSelection();
        showToast(`Moved ${ids.length} session${ids.length === 1 ? "" : "s"} into <b>${escText(targetName)}</b>.`);
        await refetch();
      } else {
        showToast(`Couldn't move into <b>${escText(targetName)}</b> — ${escText(await res.text())}`);
      }
    } catch (error) {
      showToast(`Couldn't move into <b>${escText(targetName)}</b> — ${escText(error instanceof Error ? error.message : String(error))}`);
    }
  }

  // One-click auto-group: the chip carries the suggested name + the clustered session ids, so
  // grouping is a single confirmed action (no name prompt — the heuristic already named it; the
  // user can rename later via the lifecycle menu). Pre-creates the workstream, then refetches.
  async function autoGroup(projectId: string, name: string, sessionIds: string[]) {
    const ids = sessionIds.filter((id) => view.SESS[id]); // guard against a stale chip
    if (ids.length < 2) { showToast("These sessions are no longer groupable."); return; }
    const ok = await createWorkstreamWithSessions(projectId, name, ids);
    if (ok) {
      clearSelection();
      showToast(`Grouped ${ids.length} sessions into <b>${escText(name)}</b> — moved out of Unfiled.`);
      await refetch();
    } else {
      showToast(`Couldn't group into <b>${escText(name)}</b> — try again.`);
    }
  }

  // ── per-workstream lifecycle (M3) ──────────────────────────────────────────
  // The full lifecycle is first-class and USER-driven from the kebab menu + the sign-off
  // strip's Cancel action: Mark done / Archive / Cancel (abandon) / Delete / Restore — each
  // wired to the REAL registry route. Destructive verbs (Cancel/Delete) confirm first;
  // Delete also offers an Undo that re-creates the workstream from a snapshot. After every
  // mutation we refetch /api/rollups (the server emits project_registry_changed too) so the
  // whole set re-shapes honestly — archived/abandoned workstreams move to the Archived
  // surface, out of the active gauge & counts.

  // The registry workstream id → its name (for toast copy) + owning project + a snapshot of
  // its current criteria/sessions, resolved from the SESS index (an archived workstream's
  // sessions are indexed too). Returns null if the workstream has no sessions indexed (a
  // zero-session workstream is unreachable via SESS — guarded at the call sites).
  function findWsContext(workstreamId: string): { wsName: string; projectId: string; itemStatus?: string } | null {
    for (const ref of Object.values(view.SESS)) {
      if (ref.w.id === workstreamId) {
        return { wsName: ref.w.name, projectId: ref.p.id, itemStatus: ref.w._itemStatus };
      }
    }
    // A zero-session workstream isn't in SESS; fall back to a scan of the rollup view model.
    for (const p of view.data) {
      const w = [...(p.workstreams || []), ...(p.archivedWorkstreams || [])].find((x) => x.id === workstreamId);
      if (w) return { wsName: w.name, projectId: p.id, itemStatus: w._itemStatus };
    }
    return null;
  }

  // Build the re-create payload for an Undo-after-delete: the workstream's name, its DoD
  // criteria (round-tripped from the rollup view model's `crit`), and its attached session
  // ids. A new id is minted server-side (delete is irreversible at the id level), but the
  // user's work — the criteria + membership — is restored intact.
  function snapshotWorkstream(workstreamId: string): { projectId: string; body: Record<string, unknown> } | null {
    for (const p of view.data) {
      const w = [...(p.workstreams || []), ...(p.archivedWorkstreams || [])].find((x) => x.id === workstreamId);
      if (!w) continue;
      const sessionIds = w.sessions.map((s) => s.id);
      // Reconstruct the DoD criteria from the first session that carries them (the DoD is
      // workstream-level, mirrored onto every session). Manual `met` is preserved.
      const critSrc = (w.sessions.find((s) => s.crit && s.crit.length)?.crit) || [];
      const criteria = critSrc.map((c) => {
        const kind = (c.src || "manual");
        let source: Record<string, unknown>;
        if (kind === "git_merged") source = { kind, into: c.into || "main" };
        else if (kind === "command") source = { kind, cwd: w.sessions[0]?.cwd || "", cmd: "npm test" };
        else if (kind === "session_idle") source = { kind, sessionId: sessionIds[0] || "" };
        else source = { kind };
        return {
          text: c.text || "",
          source,
          ...(c.gate ? { gate: true } : {}),
          ...(kind === "manual" ? { met: !!c.met } : {}),
          ...(c.weight != null ? { weight: c.weight } : {}),
        };
      });
      const body: Record<string, unknown> = { name: w.name, sessionIds };
      if (criteria.length) body.dod = { criteria };
      return { projectId: p.id, body };
    }
    return null;
  }

  // PATCH a workstream's fields (status / archived) then refetch. Returns ok.
  async function patchWorkstream(workstreamId: string, patch: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`/api/workstreams/${encodeURIComponent(workstreamId)}`, {
        method: "PATCH",
        headers: api.headers(),
        body: JSON.stringify(patch),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function markWsDone(workstreamId: string) {
    const ctx = findWsContext(workstreamId);
    const name = ctx?.wsName || "Workstream";
    const ok = await patchWorkstream(workstreamId, { status: "done" });
    if (ok) { showToast(`<b>${escText(name)}</b> marked done.`); await refetch(); }
    else showToast(`Couldn't mark <b>${escText(name)}</b> done — try again.`);
  }

  async function archiveWs(workstreamId: string) {
    const ctx = findWsContext(workstreamId);
    const name = ctx?.wsName || "Workstream";
    const ok = await patchWorkstream(workstreamId, { archived: true });
    if (ok) {
      showToast(`<b>${escText(name)}</b> archived — moved to Archived, out of active counts.`, () => {
        void patchWorkstream(workstreamId, { archived: false }).then((undone) => { if (undone) void refetch(); });
      });
      await refetch();
    } else showToast(`Couldn't archive <b>${escText(name)}</b> — try again.`);
  }

  // Cancel / Abandon — sets the workstream abandoned (PATCH status:"abandoned"). Confirmed
  // first (destructive lifecycle exit). Reachable from the kebab AND the sign-off strip's
  // "Cancel — no longer relevant" action. Offers Undo (back to in_progress).
  async function cancelWs(workstreamId: string) {
    const ctx = findWsContext(workstreamId);
    const name = ctx?.wsName || "this workstream";
    if (!window.confirm(`Cancel "${name}" as no longer relevant? It moves to Archived and drops out of active counts. You can re-open it later.`)) return;
    // Capture the PRIOR status so Undo restores it faithfully — a workstream cancelled while
    // `done` returns to `done` (not silently demoted to in_progress, which would lose its
    // place in the project ring's k-of-n-done numerator). Default to in_progress for anything
    // that wasn't already a terminal `done`.
    const priorStatus = ctx?.itemStatus === "done" ? "done" : "in_progress";
    const ok = await patchWorkstream(workstreamId, { status: "abandoned" });
    if (ok) {
      showToast(`<b>${escText(name)}</b> cancelled — no longer relevant. Moved to Archived.`, () => {
        void patchWorkstream(workstreamId, { status: priorStatus }).then((undone) => { if (undone) void refetch(); });
      });
      await refetch();
    } else showToast(`Couldn't cancel <b>${escText(name)}</b> — try again.`);
  }

  // Restore — bring an archived/abandoned workstream back into the active grid. We clear the
  // `archived` flag unconditionally, but only RE-SET the status to in_progress when the prior
  // status was `abandoned` (a cancelled workstream has no meaningful prior status to recover).
  // A done-then-archived workstream (mark-done → archive-to-declutter is an expected flow) must
  // keep its `done` status on restore, else it silently drops out of the project ring's
  // k-of-n-done numerator. Reachable from the Archived section + the kebab.
  async function restoreWs(workstreamId: string) {
    const ctx = findWsContext(workstreamId);
    const name = ctx?.wsName || "Workstream";
    const patch: Record<string, unknown> = { archived: false };
    if (ctx?.itemStatus === "abandoned") patch.status = "in_progress";
    const ok = await patchWorkstream(workstreamId, patch);
    if (ok) { showToast(`<b>${escText(name)}</b> restored to the active grid.`); await refetch(); }
    else showToast(`Couldn't restore <b>${escText(name)}</b> — try again.`);
  }

  // Delete — irreversible at the id level (the registry has no undelete), so we confirm,
  // snapshot the workstream's criteria + sessions BEFORE deleting, and offer an Undo that
  // re-creates it (new id, same work). DELETE /api/workstreams/:id.
  async function deleteWs(workstreamId: string) {
    const ctx = findWsContext(workstreamId);
    const name = ctx?.wsName || "this workstream";
    if (!window.confirm(`Delete "${name}"? This removes the workstream and its Definition of Done. Undo re-creates it from a snapshot (a new id).`)) return;
    const snap = snapshotWorkstream(workstreamId);
    let ok = false;
    try {
      const res = await fetch(`/api/workstreams/${encodeURIComponent(workstreamId)}`, { method: "DELETE", headers: api.headers() });
      ok = res.ok;
    } catch { ok = false; }
    if (!ok) { showToast(`Couldn't delete <b>${escText(name)}</b> — try again.`); return; }
    const undo = snap
      ? () => {
          void fetch(`/api/projects/${encodeURIComponent(snap.projectId)}/workstreams`, {
            method: "POST",
            headers: api.headers(),
            body: JSON.stringify(snap.body),
          }).then((r) => { if (r.ok || r.status === 201) void refetch(); else showToast(`Couldn't restore <b>${escText(name)}</b>.`); })
            .catch(() => showToast(`Couldn't restore <b>${escText(name)}</b>.`));
        }
      : undefined;
    showToast(`<b>${escText(name)}</b> deleted.`, undo);
    await refetch();
  }

  // Route a kebab/archived-row lifecycle action to its handler. Centralizes the verb→handler
  // map so both the menu (data-wsaction) and the sign-off Cancel (data-wscancel) reuse it.
  function runWsAction(action: string, workstreamId: string) {
    if (!workstreamId) return;
    closeWsMenus();
    switch (action) {
      case "done": void markWsDone(workstreamId); break;
      case "archive": void archiveWs(workstreamId); break;
      case "cancel": void cancelWs(workstreamId); break;
      case "restore": void restoreWs(workstreamId); break;
      case "delete": void deleteWs(workstreamId); break;
    }
  }

  // ── project-level lifecycle (operability lens) ─────────────────────────────
  // The project entity is fully USER-manageable from the populated grid, mirroring the
  // workstream kebab: a persistent "+ New project" affordance (so a SECOND project is
  // reachable without the empty-onboarding path) plus a per-row kebab (Rename / Archive /
  // Delete). Each verb hits the REAL PATCH/DELETE /api/projects/:id routes, then refetches.
  // Destructive Delete confirms first + offers an Undo that re-registers from a name+roots
  // snapshot taken from the raw rollups (a new id, same roots → its sessions re-roll up).

  // Resolve a project's display name + raw registry roots from the raw rollups (VProject.path
  // is the ~-shortened DISPLAY path; re-registration needs the absolute roots). Returns null
  // for an unknown id (guarded at every call site).
  function findProjectContext(projectId: string): { name: string; roots: string[]; description?: string } | null {
    for (const r of state.rollups) {
      if (r.project?.id === projectId) {
        return { name: r.project.name, roots: [...(r.project.roots || [])], description: r.project.description };
      }
    }
    return null;
  }

  // "+ New project" from the populated grid. Reuses refreshCandidates() to suggest a folder,
  // then prompts for a name — registerProject() does the POST + refetch. When there are no
  // unregistered candidates, the user can still type an absolute path by hand (the same
  // POST /api/projects {name, roots:[path]} contract the onboarding cards use).
  async function newProjectFromGrid() {
    closeProjMenus();
    await refreshCandidates();
    const cands = view.candidates || [];
    const suggestedRoot = cands[0]?.path || "";
    const root = (window.prompt(
      cands.length
        ? `Register a project folder (absolute path). pi found ${cands.length} unregistered folder${cands.length === 1 ? "" : "s"} with sessions — the busiest is pre-filled:`
        : "Register a project folder — paste its absolute path:",
      suggestedRoot,
    ) || "").trim();
    if (!root) return; // cancelled / empty → no-op (no fabricated default)
    const defaultName = cands.find((c) => c.path === root)?.name || basename(root) || "New project";
    const name = (window.prompt(`Name this project:`, defaultName) || "").trim();
    if (!name) return;
    await registerProject(name, root); // POSTs /api/projects, toasts, refetches
  }

  async function patchProject(projectId: string, patch: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: api.headers(),
        body: JSON.stringify(patch),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function renameProject(projectId: string) {
    const ctx = findProjectContext(projectId);
    const current = ctx?.name || "this project";
    const next = (window.prompt(`Rename project:`, ctx?.name || "") || "").trim();
    if (!next || next === ctx?.name) return; // cancelled / unchanged → no-op
    const ok = await patchProject(projectId, { name: next });
    if (ok) { showToast(`Renamed <b>${escText(current)}</b> → <b>${escText(next)}</b>.`); await refetch(); }
    else showToast(`Couldn't rename <b>${escText(current)}</b> — try again.`);
  }

  async function archiveProject(projectId: string) {
    const ctx = findProjectContext(projectId);
    const name = ctx?.name || "this project";
    if (!window.confirm(`Archive "${name}"? Its rollup drops out of the dashboard. You can un-archive it later via the API or by re-registering its folder.`)) return;
    const ok = await patchProject(projectId, { archived: true });
    if (ok) {
      showToast(`<b>${escText(name)}</b> archived — removed from the active dashboard.`, () => {
        void patchProject(projectId, { archived: false }).then((undone) => { if (undone) void refetch(); });
      });
      await refetch();
    } else showToast(`Couldn't archive <b>${escText(name)}</b> — try again.`);
  }

  async function deleteProject(projectId: string) {
    const ctx = findProjectContext(projectId);
    const name = ctx?.name || "this project";
    if (!window.confirm(`Delete "${name}"? This removes the project registration and its workstreams. Sessions are untouched (they revert to Unfiled). Undo re-registers it (a new id).`)) return;
    let ok = false;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", headers: api.headers() });
      ok = res.ok;
    } catch { ok = false; }
    if (!ok) { showToast(`Couldn't delete <b>${escText(name)}</b> — try again.`); return; }
    // Undo: re-register from the snapshot (name + roots). A new id is minted (delete is
    // irreversible at the id level), but the same roots re-roll up the project's sessions.
    const undo = ctx && ctx.roots.length
      ? () => {
          void fetch(`/api/projects`, {
            method: "POST",
            headers: api.headers(),
            body: JSON.stringify({ name: ctx.name, roots: ctx.roots, ...(ctx.description ? { description: ctx.description } : {}) }),
          }).then((r) => { if (r.ok || r.status === 201) void refetch(); else showToast(`Couldn't restore <b>${escText(name)}</b>.`); })
            .catch(() => showToast(`Couldn't restore <b>${escText(name)}</b>.`));
        }
      : undefined;
    showToast(`<b>${escText(name)}</b> deleted — its sessions revert to Unfiled.`, undo);
    await refetch();
  }

  function runProjAction(action: string, projectId: string) {
    if (!projectId) return;
    closeProjMenus();
    switch (action) {
      case "new": void newProjectFromGrid(); break;
      case "newws": void newWorkstreamForProject(projectId); break;
      case "rename": void renameProject(projectId); break;
      case "archive": void archiveProject(projectId); break;
      case "delete": void deleteProject(projectId); break;
    }
  }

  // Project kebab popups mirror the workstream menu: only one open at a time, dismissed by a
  // click elsewhere (the document/overlay listener in init calls both closers).
  function closeProjMenus() {
    elements.dashboardWrap.querySelectorAll<HTMLElement>(".projmenu-pop").forEach((pop) => { pop.hidden = true; });
    elements.dashboardWrap.querySelectorAll<HTMLElement>("[data-projmenu-toggle]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
  function toggleProjMenu(projectId: string) {
    const menu = elements.dashboardWrap.querySelector<HTMLElement>(`.projmenu[data-projmenu="${CSS.escape(projectId)}"]`);
    if (!menu) return;
    const pop = menu.querySelector<HTMLElement>(".projmenu-pop");
    const toggle = menu.querySelector<HTMLElement>("[data-projmenu-toggle]");
    const wasOpen = pop ? !pop.hidden : false;
    closeProjMenus();
    if (pop && !wasOpen) { pop.hidden = false; toggle?.setAttribute("aria-expanded", "true"); }
  }

  // Open/close the small kebab popup menus. Only one is open at a time; a click elsewhere
  // (handled by the document listener wired in init) closes them.
  function closeWsMenus() {
    elements.dashboardWrap.querySelectorAll<HTMLElement>(".wsmenu-pop").forEach((pop) => { pop.hidden = true; });
    elements.dashboardWrap.querySelectorAll<HTMLElement>("[data-wsmenu-toggle]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
  function toggleWsMenu(workstreamId: string) {
    const menu = elements.dashboardWrap.querySelector<HTMLElement>(`.wsmenu[data-wsmenu="${CSS.escape(workstreamId)}"]`);
    if (!menu) return;
    const pop = menu.querySelector<HTMLElement>(".wsmenu-pop");
    const toggle = menu.querySelector<HTMLElement>("[data-wsmenu-toggle]");
    const wasOpen = pop ? !pop.hidden : false;
    closeWsMenus();
    if (pop && !wasOpen) { pop.hidden = false; toggle?.setAttribute("aria-expanded", "true"); }
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

    // ── per-workstream lifecycle menu (M3) ── checked FIRST so the kebab + its menu items
    // never fall through to the row toggle / data-open beneath them.
    const kebab = target.closest<HTMLElement>("[data-wsmenu-toggle]");
    if (kebab) {
      event.preventDefault();
      event.stopPropagation();
      toggleWsMenu(kebab.getAttribute("data-wsmenu-toggle") || "");
      return;
    }
    const wsAction = target.closest<HTMLElement>("[data-wsaction]");
    if (wsAction) {
      event.preventDefault();
      event.stopPropagation();
      runWsAction(wsAction.getAttribute("data-wsaction") || "", wsAction.getAttribute("data-wsid") || "");
      return;
    }

    // ── project-level lifecycle (operability lens) ── kebab toggle + actions, checked before
    // the card/row toggle beneath them. "+ New project" carries data-projaction="new" with no id.
    const projKebab = target.closest<HTMLElement>("[data-projmenu-toggle]");
    if (projKebab) {
      event.preventDefault();
      event.stopPropagation();
      toggleProjMenu(projKebab.getAttribute("data-projmenu-toggle") || "");
      return;
    }
    const projAction = target.closest<HTMLElement>("[data-projaction]");
    if (projAction) {
      event.preventDefault();
      event.stopPropagation();
      runProjAction(projAction.getAttribute("data-projaction") || "", projAction.getAttribute("data-projid") || "");
      return;
    }

    // A click anywhere else inside the overlay (not on a menu) dismisses any open kebab menu
    // before the click's own handling proceeds.
    if (!target.closest(".wsmenu")) closeWsMenus();
    if (!target.closest(".projmenu")) closeProjMenus();
    // Sign-off strip "Cancel — no longer relevant" → abandon the owning workstream.
    const wsCancel = target.closest<HTMLElement>("[data-wscancel]");
    if (wsCancel) {
      event.preventDefault();
      event.stopPropagation();
      runWsAction("cancel", wsCancel.getAttribute("data-wscancel") || "");
      return;
    }

    // ── M4: Unfiled organize actions ── checked BEFORE data-open since they live inside the
    // bucket's sess-list (some, like the auto-group chip, sit above the rows; the bar buttons
    // are siblings of the rows, not inside a `data-open`, but the picker/clear must still
    // short-circuit). A click on the checkbox label itself is handled by the `change` listener.
    const autogroup = target.closest<HTMLElement>("[data-autogroup]");
    if (autogroup) {
      event.preventDefault();
      event.stopPropagation();
      const projectId = autogroup.getAttribute("data-project") || "";
      const label = autogroup.getAttribute("data-autogroup") || "";
      const ids = (autogroup.getAttribute("data-sessions") || "").split(",").filter(Boolean);
      // The chip's data-autogroup is the normalized key; prefer the human label from the button
      // text fallback — but the key is a safe, descriptive workstream name on its own.
      const name = label.split("-").map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ") || "Grouped sessions";
      if (projectId && ids.length) void autoGroup(projectId, name, ids);
      return;
    }
    const newWs = target.closest<HTMLElement>("[data-mn-newws]");
    if (newWs) {
      event.preventDefault();
      event.stopPropagation();
      void newWorkstreamFromSelection(newWs.getAttribute("data-mn-newws") || "");
      return;
    }
    const moveWs = target.closest<HTMLElement>("[data-mn-movews]");
    if (moveWs) {
      event.preventDefault();
      event.stopPropagation();
      void moveSelectionToWorkstream(moveWs.getAttribute("data-mn-movews") || "");
      return;
    }
    if (target.closest("[data-mn-clear]")) {
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
      return;
    }
    // A click on the checkbox / its label inside an Unfiled row must NOT open the session.
    if (target.closest(".mnselect")) { event.stopPropagation(); return; }
    // The move picker <select> is interactive — let it open without bubbling to data-open.
    if (target.closest("[data-mn-movesel]")) { event.stopPropagation(); return; }

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

    // Merge affordance → POST /api/prompt "merge <branch> into main" then open the session
    // (what the button's tooltip promises). Checked before data-open like the reply chip.
    const merge = target.closest<HTMLElement>("[data-merge]");
    if (merge) {
      event.preventDefault();
      event.stopPropagation();
      const id = merge.getAttribute("data-merge");
      const branch = merge.getAttribute("data-branch") || "";
      if (id) void mergeRequest(id, branch);
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
        // Exclude sessions inside archived/abandoned workstreams — shelved work is out of the
        // active surfaces, so "Triage all in focus" must not open it as the top need.
        .filter(({ w }) => !w._inactive)
        .map(({ s }) => s)
        // A hard need = fail, an elicited block, OR a git-conflict block (matches render.ts isHardNeedV).
        .filter((s) => s.status === "fail" || (s.status === "block" && (s.elicited || s.gitBlocked)))
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
      if (event.target === elements.dashboardView) { closeWsMenus(); closeProjMenus(); closeDashboard(); }
    });
    // ESC dismisses an open kebab menu first (before the app's ESC closes the overlay), so
    // the menu can be escaped without losing the whole dashboard.
    elements.dashboardView.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key !== "Escape") return;
      const anyOpen = !!elements.dashboardWrap.querySelector<HTMLElement>(".wsmenu-pop:not([hidden]), .projmenu-pop:not([hidden])");
      if (anyOpen) { event.stopPropagation(); closeWsMenus(); closeProjMenus(); }
    });
    // Delegated drill-in / continue / expand-collapse, scoped to the overlay.
    elements.dashboardWrap.addEventListener("click", handleClick);
    // M4 — Unfiled multi-select: a delegated `change` on the bucket checkboxes toggles the
    // selection set (the `change` event fires on the real toggle, separate from the click
    // delegation that opens sessions).
    elements.dashboardWrap.addEventListener("change", (event) => {
      const target = event.target as HTMLElement | null;
      const box = target?.closest<HTMLInputElement>("[data-mnselect]");
      if (box) {
        event.stopPropagation();
        toggleSelect(box.getAttribute("data-mnselect") || "", box.checked);
      }
    });
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
      const gate = target.closest<HTMLElement>("[data-critgate]");
      if (gate) { toggleDraftGate(Number.parseInt(gate.getAttribute("data-critgate") || "-1", 10)); return; }
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
    // git_merged target-branch input: update the draft model live without re-rendering (a
    // re-render would steal focus mid-type); saveDoD reads the final value.
    drawerHost.addEventListener("input", (event) => {
      const target = event.target as HTMLElement | null;
      const into = target?.closest<HTMLInputElement>("[data-critinto]");
      if (into) setDraftMergeTarget(Number.parseInt(into.getAttribute("data-critinto") || "-1", 10), into.value);
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
    reconcileFromUrl,
  };
}
