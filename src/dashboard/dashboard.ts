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

  function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (char) =>
      char === "&" ? "&amp;"
        : char === "<" ? "&lt;"
        : char === ">" ? "&gt;"
        : char === '"' ? "&quot;"
        : "&#39;",
    );
  }

  // S4 placeholder render. S5 replaces this body with the ported render core
  // (rollupAdapter.toViewModel + render.renderAll) driven by `state.rollups`.
  function renderWrap() {
    if (state.loading && state.rollups.length === 0) {
      elements.dashboardWrap.innerHTML = `
        <div class="hero">
          <div class="eyebrow">Project Rollups</div>
          <h1 class="headline">Loading your projects…</h1>
          <div class="subline">Aggregating live pi sessions into project rollups.</div>
        </div>`;
      return;
    }
    if (state.error) {
      elements.dashboardWrap.innerHTML = `
        <div class="hero">
          <div class="eyebrow">Project Rollups</div>
          <h1 class="headline">Couldn't load rollups</h1>
          <div class="subline">${escapeHtml(state.error)}</div>
        </div>`;
      return;
    }
    if (state.rollups.length === 0) {
      elements.dashboardWrap.innerHTML = `
        <div class="hero">
          <div class="eyebrow">Project Rollups</div>
          <h1 class="headline">No projects yet</h1>
          <div class="subline">Register a project to start tracking its sessions against a Definition of Done.</div>
        </div>`;
      return;
    }
    const workstreamCount = state.rollups.reduce((sum, rollup) => sum + rollup.workstreams.length, 0);
    const activeCount = state.rollups.reduce((sum, rollup) => sum + (rollup.activeSessionCount || 0), 0);
    const rail = state.rollups
      .map((rollup) => {
        const name = escapeHtml(rollup.project?.name || "Untitled project");
        const sessions = rollup.workstreams.reduce((sum, ws) => sum + ws.sessions.length, 0);
        return `<span class="pill" data-project-id="${escapeHtml(rollup.project?.id || "")}">`
          + `${name}<span class="n">${sessions}</span></span>`;
      })
      .join("");
    elements.dashboardWrap.innerHTML = `
      <div class="hero">
        <div class="eyebrow">Project Rollups</div>
        <h1 class="headline">${state.rollups.length} project${state.rollups.length === 1 ? "" : "s"} in view</h1>
        <div class="subline">
          <b>${workstreamCount}</b> workstream${workstreamCount === 1 ? "" : "s"}
          · <b>${activeCount}</b> active session${activeCount === 1 ? "" : "s"}.
          Full rollup view (rings, needs-you, sign-off) lands in the next slice.
        </div>
        <div class="rail">${rail}</div>
      </div>`;
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
