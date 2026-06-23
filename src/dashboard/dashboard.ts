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

export function createDashboard(options: {
  elements: AppElements;
  api: ApiClient;
  sessions: SessionsController;
  addMessage: (role: "system", text: string, extraClass?: string) => HTMLDivElement;
}): DashboardController {
  const { elements, api, addMessage } = options;

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
    elements.dashboardBackdrop.hidden = false;
    elements.dashboardView.hidden = false;
  }

  function hide() {
    open = false;
    elements.dashboardView.hidden = true;
    elements.dashboardBackdrop.hidden = true;
  }

  function openDashboard() {
    if (open) return;
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

  function init() {
    elements.dashboardCloseButton.addEventListener("click", () => closeDashboard());
    elements.dashboardBackdrop.addEventListener("click", () => closeDashboard());
    // Click on the overlay scroll surface (outside the centered .wrap) closes.
    elements.dashboardView.addEventListener("click", (event) => {
      if (event.target === elements.dashboardView) closeDashboard();
    });
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
