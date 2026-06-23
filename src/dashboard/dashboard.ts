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
  const view: RenderState = { data: [], SESS: {}, signed: {}, lastVisit: null, _pingId: null };
  const renderer = createRenderer({ wrap: elements.dashboardWrap, state: view });

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
  // empty registry renders the first-run onboarding; otherwise the full rollup grid.
  function renderWrap() {
    if (renderLoadingOrError()) return;
    renderer.renderAll(view.data.length === 0 ? { empty: true, candidates: 0 } : {});
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
      if (id) void openSessionFromCard(id);
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
