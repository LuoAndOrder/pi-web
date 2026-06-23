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
  }

  // Ported from the mockup click delegation (index.html L3166-3213), scoped to
  // #dashboardView. S6 wires: data-open (overridden → real session), data-jump
  // (scroll + auto-expand), and the data-toggle expand/collapse family. Quick-reply
  // chips, sign-off, recheck, batch sign-off and focus-triage land in S7 — until then
  // render.ts ships them as `disabled` affordances, so they never reach here as live no-ops.
  function handleClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target) return;

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
