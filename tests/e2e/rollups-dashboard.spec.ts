import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Project Rollups dashboard — frontend gate spec (slices S4 / S5 / S6).
//
// The dashboard reads the REAL project registry (the server has no per-test
// PI_WEB_PROJECTS_FILE override), so every test seeds its OWN uniquely-named
// project through the real CRUD API and deletes it in afterEach — leaving the
// registry file exactly as it was found. Sessions come from the mock feed
// (PI_WEB_MOCK=1): `mock-current` / `mock-older`, both cwd = repo root.
//
// The seed shape is an "awaiting sign-off" workstream: one met non-gate manual
// criterion (counts toward the ring → 100%) plus one unmet manual GATE criterion
// (excluded from the percent, but promotes the session to uiStatus "sign"). That
// lands the project in the sign-off rail (`[data-testid="signoff"]`) with an
// honest 100% ring and a visible Review `[data-open]` button — a stable,
// grid-grouping-agnostic target for the render + drill-in assertions.

const SIGN_DOD = [
  { text: "Render core ported from the validated mockup", source: { kind: "manual" }, weight: 1, met: true },
  { text: "You review & sign off the rollups dashboard", source: { kind: "manual" }, gate: true, met: false },
];

const createdProjectIds: string[] = [];

async function createSignProject(request: APIRequestContext, name: string): Promise<{ projectId: string; workstreamId: string }> {
  const root = `/tmp/rollups-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pRes = await request.post("/api/projects", { data: { name, roots: [root] } });
  expect(pRes.status(), await pRes.text()).toBe(201);
  const projectId = (await pRes.json()).project.id as string;
  createdProjectIds.push(projectId);

  const wRes = await request.post(`/api/projects/${projectId}/workstreams`, { data: { name: "Sign-off workstream" } });
  expect(wRes.status(), await wRes.text()).toBe(201);
  const workstreamId = (await wRes.json()).workstream.id as string;

  const dodRes = await request.put(`/api/workstreams/${workstreamId}/dod`, { data: { criteria: SIGN_DOD } });
  expect(dodRes.status(), await dodRes.text()).toBe(200);

  const sessRes = await request.put(`/api/workstreams/${workstreamId}/sessions`, { data: { sessionIds: ["mock-current"] } });
  expect(sessRes.status(), await sessRes.text()).toBe(200);

  return { projectId, workstreamId };
}

// Seed an autonomous-loop workstream: PATCH the workstream to isLoop + a stored
// loopStartedAt (the registry's source of truth for elapsed, spec §5.4), attach the
// mock session. The loop badge's elapsed flows from THIS loopStartedAt — never from
// runtime — so it survives the 60s idle dispose.
async function createLoopProject(
  request: APIRequestContext,
  name: string,
  loopStartedAt: string,
): Promise<{ projectId: string; workstreamId: string }> {
  const root = `/tmp/rollups-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pRes = await request.post("/api/projects", { data: { name, roots: [root] } });
  expect(pRes.status(), await pRes.text()).toBe(201);
  const projectId = (await pRes.json()).project.id as string;
  createdProjectIds.push(projectId);

  const wRes = await request.post(`/api/projects/${projectId}/workstreams`, { data: { name: "Nightly loop" } });
  expect(wRes.status(), await wRes.text()).toBe(201);
  const workstreamId = (await wRes.json()).workstream.id as string;

  const patchRes = await request.patch(`/api/workstreams/${workstreamId}`, {
    data: { isLoop: true, loopStartedAt, budget: { maxMinutes: 120 } },
  });
  expect(patchRes.status(), await patchRes.text()).toBe(200);

  const sessRes = await request.put(`/api/workstreams/${workstreamId}/sessions`, { data: { sessionIds: ["mock-current"] } });
  expect(sessRes.status(), await sessRes.text()).toBe(200);

  return { projectId, workstreamId };
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
});

test.afterEach(async ({ page }) => {
  while (createdProjectIds.length) {
    const id = createdProjectIds.pop()!;
    await page.request.delete(`/api/projects/${id}`).catch(() => undefined);
  }
});

test.describe("Project Rollups dashboard", () => {
  test("S4: statusBar button toggles the overlay and fires GET /api/rollups", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    const view = page.locator("#dashboardView");
    await expect(view).toBeHidden();

    const rollupsRequest = page.waitForResponse(
      (res) => res.url().includes("/api/rollups") && res.request().method() === "GET",
    );
    await page.locator("#dashboardButton").click();

    await expect(view).toBeVisible();
    const res = await rollupsRequest; // network proof
    expect(res.ok()).toBe(true);

    // The overlay renders real content from the feed: a populated registry shows the hero;
    // an empty one (the isolated playwright registry starts empty) shows the first-run
    // onboarding card. Either is an honest, non-blank render.
    await expect(view.locator(".hero, [data-testid='first-run']").first()).toBeVisible();

    // ESC closes and returns to the live conversation untouched.
    await page.keyboard.press("Escape");
    await expect(view).toBeHidden();
    await expect(page.locator("#prompt")).toBeVisible();

    // Regression: the existing git panel still opens after using the dashboard.
    await page.locator("#gitButton").click();
    await expect(page.locator("#gitPanel")).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test("S5: a seeded project renders in the sign-off rail with an honest 100% ring", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    const name = `E2E Sign-off ${Date.now()}`;
    const { projectId } = await createSignProject(page.request, name);

    // Honest-signal contract: the server ProgressSnapshot is what the ring renders.
    const apiRes = await page.request.get("/api/rollups");
    expect(apiRes.ok()).toBe(true);
    const rollups = (await apiRes.json()).rollups as Array<{ project: { id: string }; progress: { percent: number; allMet: boolean; total: number } }>;
    const mine = rollups.find((r) => r.project.id === projectId);
    expect(mine, "seeded project must appear in /api/rollups").toBeTruthy();
    expect(mine!.progress.allMet).toBe(true); // gate excluded, the one scorable criterion is met
    expect(mine!.progress.percent).toBe(100);

    await page.locator("#dashboardButton").click();
    await expect(page.locator("#dashboardView")).toBeVisible();

    // The sign-off rail is populated with the project (data-testid contract).
    const signoff = page.locator('[data-testid="signoff"]');
    await expect(signoff).toBeVisible();
    await expect(signoff.locator(".soff", { hasText: name })).toBeVisible();

    // Honest ring: the project card renders a [data-testid="ring"] whose
    // data-percent equals the server ProgressSnapshot.percent (100, gate excluded).
    const pcard = page.locator(`#dashboardView .pcard[data-project-id="${projectId}"]`);
    await expect(pcard).toBeVisible();
    const ring = pcard.locator('[data-testid="ring"][data-percent]').first();
    await expect(ring).toBeVisible();
    await expect(ring).toHaveAttribute("data-percent", "100");

    // Honest-signal invariant (DoD §6): EVERY rendered ring carries a numeric
    // data-percent in [0,100] — no fabricated percent without a backing eval.
    const percents = await page.locator('#dashboardView [data-testid="ring"][data-percent]').evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-percent")),
    );
    expect(percents.length).toBeGreaterThan(0);
    for (const p of percents) {
      const n = Number(p);
      expect(Number.isInteger(n) && n >= 0 && n <= 100).toBe(true);
    }

    expect(pageErrors).toEqual([]);
  });

  test("S6: drill-in Continue/Review lands in the REAL conversation", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    const name = `E2E Drill ${Date.now()}`;
    await createSignProject(page.request, name);

    await page.locator("#dashboardButton").click();
    const view = page.locator("#dashboardView");
    await expect(view).toBeVisible();

    // The sign-off rail's "Review" button is a [data-open] for the real session.
    const review = page.locator('[data-testid="signoff"] [data-open="mock-current"]').first();
    await expect(review).toBeVisible();
    await review.click();

    // The overlay hides and the REAL conversation loads: composer present, URL carries the session id.
    await expect(view).toBeHidden();
    await expect(page.locator("#prompt")).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("sessionId")).toBe("mock-current");

    expect(pageErrors).toEqual([]);
  });

  test("S11: a loop shows elapsed from loopStartedAt, never amber, with iteration telemetry only in the muted proposed band", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    const name = `E2E Loop ${Date.now()}`;
    // loopStartedAt 38 minutes ago — the badge must read elapsed grounded in THIS stored
    // timestamp (not the freshly-loaded runtime), proving it survives the 60s idle dispose.
    const loopStartedAt = new Date(Date.now() - 38 * 60_000).toISOString();
    const { projectId } = await createLoopProject(page.request, name, loopStartedAt);

    await page.locator("#dashboardButton").click();
    const view = page.locator("#dashboardView");
    await expect(view).toBeVisible();

    // The loop project renders as a normal active card (a loop session is "looping", NOT
    // "needs-setup", even with no terminal DoD). Expand it to reveal its workstream rows.
    const pcard = view.locator(`.pcard[data-project-id="${projectId}"]`);
    await expect(pcard).toBeVisible();
    await pcard.locator(".pcard-head").click();

    // The live loop badge renders "∞ looping {elapsed}" with elapsed grounded in the
    // stored loopStartedAt (~38m → "38m"), NOT a runtime-derived "just started" — proving
    // it survives the 60s idle dispose that resets runtime timestamps.
    const wsRow = pcard.locator(`.ws[data-ws-id]`).first();
    const loopBadge = wsRow.locator(`.loopBadge`).first();
    await expect(loopBadge).toBeVisible();
    await expect(loopBadge).toContainText("looping");
    await expect(loopBadge).toContainText("38m");

    // HONEST DEGRADATION: the loop badge NEVER goes amber from inference. The badge uses
    // the running hue, not any warn/amber/over-budget class (loopHealth was deleted).
    const badgeClass = (await loopBadge.getAttribute("class")) || "";
    expect(badgeClass).not.toMatch(/warn|amber|over|stall|alarm/i);

    // Expand the workstream to reveal its session rows + the per-session loop telemetry.
    await wsRow.locator(".ws-head").click();

    // Iteration/budget telemetry lives ONLY in the muted "proposed" band, never live —
    // and with no durable iteration log it reads "…not live yet", never a fabricated "iter N".
    const proposed = wsRow.locator(".proposed").first();
    await expect(proposed).toBeVisible();
    await expect(proposed).toContainText("proposed");
    await expect(proposed).toContainText("not live yet");
    await expect(proposed).not.toContainText("iter 0");

    expect(pageErrors).toEqual([]);
  });

  // M2 — deep-linkable route. The overlay is reachable via `?view=dashboard`, mirroring
  // how `?sessionId=` works: opening pushes the param, closing removes it, and reload
  // preserves the open state. These cases mutate nothing (no projects), so they ride the
  // shared playwright server safely.
  test.describe("M2: ?view=dashboard route", () => {
    test("deep-link opens the overlay on load", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      await page.goto("/?view=dashboard");
      await expect(page.locator("#connectionStatus")).toBeHidden();

      // The overlay is open straight from the URL — no click needed.
      await expect(page.locator("#dashboardView")).toBeVisible();
      // The deep-link uses `replace` on load, so the param is still present (reload-safe).
      expect(new URL(page.url()).searchParams.get("view")).toBe("dashboard");

      expect(pageErrors).toEqual([]);
    });

    test("opening via the button adds view=dashboard; closing removes it", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      const view = page.locator("#dashboardView");
      await expect(view).toBeHidden();
      expect(new URL(page.url()).searchParams.get("view")).toBeNull();

      // Opening via the statusBar button pushes the param into the URL.
      await page.locator("#dashboardButton").click();
      await expect(view).toBeVisible();
      await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("dashboard");

      // Closing (Escape) removes the param.
      await page.keyboard.press("Escape");
      await expect(view).toBeHidden();
      await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBeNull();

      // Back navigation restores the open overlay (the open was a pushState entry).
      await page.goBack();
      await expect(view).toBeVisible();
      await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("dashboard");

      expect(pageErrors).toEqual([]);
    });

    test("reload preserves the open overlay", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      await page.locator("#dashboardButton").click();
      await expect(page.locator("#dashboardView")).toBeVisible();
      await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("dashboard");

      await page.reload();
      await expect(page.locator("#connectionStatus")).toBeHidden();
      // Still open after reload — the route survives, not just the in-memory toggle.
      await expect(page.locator("#dashboardView")).toBeVisible();
      expect(new URL(page.url()).searchParams.get("view")).toBe("dashboard");

      expect(pageErrors).toEqual([]);
    });
  });

  // M3 — manual workstream lifecycle UI: the per-workstream kebab (⋯) menu (Mark done /
  // Archive / Cancel / Delete) + the sign-off strip's "Cancel — no longer relevant". Each
  // action persists via the REAL registry route and the UI re-shapes honestly (archived /
  // abandoned workstreams leave the active grid for the collapsed Archived surface). All
  // mutations ride the dedicated playwright server (its own PI_WEB_PROJECTS_FILE), never
  // the real registry.
  test.describe("M3: workstream lifecycle menu", () => {
    // Read a single project's rollup from the live feed (the persistence assertion).
    async function rollupFor(page: Page, projectId: string) {
      const res = await page.request.get("/api/rollups");
      expect(res.ok()).toBe(true);
      const rollups = (await res.json()).rollups as Array<{
        project: { id: string };
        workstreams: Array<{ workstream: { id: string; status: string; archived?: boolean }; inactive?: boolean }>;
      }>;
      return rollups.find((r) => r.project.id === projectId);
    }

    test("Mark done / Archive / Cancel / Delete each persist and re-shape the UI", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      const name = `E2E Lifecycle ${Date.now()}`;
      const { projectId, workstreamId } = await createSignProject(page.request, name);

      await page.locator("#dashboardButton").click();
      const view = page.locator("#dashboardView");
      await expect(view).toBeVisible();

      const pcard = view.locator(`.pcard[data-project-id="${projectId}"]`);
      await expect(pcard).toBeVisible();

      // The single-workstream card-header kebab + its menu (scoped to that one `.wsmenu` so
      // the duplicate `.ws`-row kebab for the same workstream doesn't ambiguate selectors).
      const cardMenu = pcard.locator(".pcard-head .wsmenu").first();
      const cardKebab = cardMenu.locator("[data-wsmenu-toggle]");
      const menuItem = (action: string) => cardMenu.locator(`[data-wsaction="${action}"]`);

      // ── Mark done ──
      await expect(cardKebab).toBeVisible();
      await cardKebab.click();
      await expect(menuItem("done")).toBeVisible();
      await menuItem("done").click();
      // Persisted: the workstream's WorkItemStatus is now "done".
      await expect.poll(async () => (await rollupFor(page, projectId))?.workstreams[0]?.workstream.status).toBe("done");

      // ── Archive ── re-open the menu (Mark done is now gone), archive the workstream.
      await cardKebab.click();
      await expect(menuItem("archive")).toBeVisible();
      await menuItem("archive").click();
      // Persisted as inactive (archived) → the Archived surface appears, the card leaves the grid.
      await expect.poll(async () => (await rollupFor(page, projectId))?.workstreams[0]?.inactive).toBe(true);
      const archived = view.locator('[data-testid="archived"]');
      await expect(archived).toBeVisible();
      // The Archived surface is collapsed by default (it never competes with live work) —
      // expand it to reveal the shelved row.
      await archived.locator(".done-head").click();
      await expect(archived.locator(`.archrow[data-ws-id="${workstreamId}"]`)).toBeVisible();
      // The archived workstream is OUT of the active grid (no active .ws row for it).
      await expect(pcard.locator(`.ws[data-ws-id="${workstreamId}"]`)).toHaveCount(0);

      // ── Restore then Cancel ── restore from the Archived row, then cancel (abandon) it.
      await archived.locator(`.archrow[data-ws-id="${workstreamId}"] [data-wsaction="restore"]`).click();
      await expect.poll(async () => (await rollupFor(page, projectId))?.workstreams[0]?.inactive ?? false).toBe(false);

      // Cancel confirms via window.confirm → accept it.
      page.once("dialog", (d) => d.accept());
      const cardMenu2 = pcard.locator(".pcard-head .wsmenu").first();
      await cardMenu2.locator("[data-wsmenu-toggle]").click();
      await cardMenu2.locator(`[data-wsaction="cancel"]`).click();
      // Persisted as abandoned → inactive again, surfaced as "Cancelled" in Archived.
      await expect.poll(async () => (await rollupFor(page, projectId))?.workstreams[0]?.workstream.status).toBe("abandoned");
      const archived2 = view.locator('[data-testid="archived"]');
      await expect(archived2).toBeVisible();
      await archived2.locator(".done-head").click(); // expand (re-rendered collapsed)
      await expect(archived2.locator(`.archrow[data-ws-id="${workstreamId}"]`)).toContainText("Cancelled");

      // ── Delete ── from the Archived row; confirm dialog accepted. The workstream is gone.
      page.once("dialog", (d) => d.accept());
      await archived2.locator(`.archrow[data-ws-id="${workstreamId}"] [data-wsaction="delete"]`).click();
      await expect.poll(async () => (await rollupFor(page, projectId))?.workstreams.length ?? 0).toBe(0);

      expect(pageErrors).toEqual([]);
    });

    test("Cancel is dismissable — declining the confirm leaves the workstream active", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      const name = `E2E Cancel-decline ${Date.now()}`;
      const { projectId, workstreamId } = await createSignProject(page.request, name);

      await page.locator("#dashboardButton").click();
      const view = page.locator("#dashboardView");
      await expect(view).toBeVisible();
      const pcard = view.locator(`.pcard[data-project-id="${projectId}"]`);
      await expect(pcard).toBeVisible();

      // Decline the confirm → no mutation.
      page.once("dialog", (d) => d.dismiss());
      const cardMenu = pcard.locator(".pcard-head .wsmenu").first();
      await cardMenu.locator("[data-wsmenu-toggle]").click();
      await cardMenu.locator(`[data-wsaction="cancel"]`).click();
      // Still active (not abandoned, not inactive).
      const r = await rollupFor(page, projectId);
      expect(r?.workstreams[0]?.workstream.status).not.toBe("abandoned");
      expect(r?.workstreams[0]?.inactive ?? false).toBe(false);

      expect(pageErrors).toEqual([]);
    });
  });

  // ── M4: create & assign workstreams from the Unfiled bucket ──────────────────
  // Register a project whose root IS the mock sessions' cwd (read off /api/sessions) so the
  // built-in mocks (mock-current / mock-older) fall into the project's synthetic Unfiled
  // bucket with no stored workstream. Then multi-select them and create a real workstream —
  // asserting they leave Unfiled and fold under the new .ws (the round-trip the M4 WORK
  // specifies). The dedicated playwright server has its OWN PI_WEB_PROJECTS_FILE, so this
  // never touches the real registry.
  test.describe("M4: organize Unfiled sessions", () => {
    // The cwd the mock sessions live in (PI_WEB_CWD = repo root on the playwright server).
    async function mockCwd(page: Page): Promise<string> {
      const res = await page.request.get("/api/sessions");
      expect(res.ok()).toBe(true);
      const sessions = (await res.json()).sessions as Array<{ id: string; cwd?: string }>;
      const cur = sessions.find((s) => s.id === "mock-current");
      expect(cur?.cwd, "mock-current must have a cwd").toBeTruthy();
      return cur!.cwd!;
    }
    async function unfiledRollup(page: Page, projectId: string) {
      const res = await page.request.get("/api/rollups");
      expect(res.ok()).toBe(true);
      const rollups = (await res.json()).rollups as Array<{
        project: { id: string };
        workstreams: Array<{ workstream: { id: string; name: string }; sessions: Array<{ id: string }> }>;
      }>;
      return rollups.find((r) => r.project.id === projectId);
    }

    test("multi-select two Unfiled sessions → New workstream moves them out of Unfiled", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      const root = await mockCwd(page);
      const name = `E2E Unfiled ${Date.now()}`;
      const pRes = await page.request.post("/api/projects", { data: { name, roots: [root] } });
      expect(pRes.status(), await pRes.text()).toBe(201);
      const projectId = (await pRes.json()).project.id as string;
      createdProjectIds.push(projectId);

      // Baseline: both mock sessions sit in the synthetic Unfiled bucket (no stored workstream).
      const before = await unfiledRollup(page, projectId);
      const unfiledBefore = before?.workstreams.find((w) => w.workstream.id.endsWith(":unfiled"));
      expect(unfiledBefore, "an Unfiled bucket must hold the matched mock sessions").toBeTruthy();
      expect(unfiledBefore!.sessions.map((s) => s.id).sort()).toEqual(["mock-current", "mock-older"]);

      await page.locator("#dashboardButton").click();
      const view = page.locator("#dashboardView");
      await expect(view).toBeVisible();

      // A no-DoD project with only unset sessions renders in the "Needs setup" group as a
      // compact .prow (not a full .pcard). Either container holds the same Unfiled bucket;
      // target by data-project-id, expand whichever chrome wraps it, then open the bucket.
      const card = view.locator(`[data-project-id="${projectId}"]`).first();
      await expect(card).toBeVisible();
      await card.click(); // expand the card / prow to reveal its workstreams
      const unfiledWs = view.locator(`.ws-unfiled[data-unfiled-project="${projectId}"]`);
      await expect(unfiledWs).toBeVisible();
      await unfiledWs.locator(".ws-head").click();

      // The assignment bar starts disabled (no selection); New workstream is disabled.
      const newBtn = unfiledWs.locator("[data-mn-newws]");
      await expect(newBtn).toBeDisabled();

      // Select both sessions via their checkboxes.
      await unfiledWs.locator('[data-mnselect="mock-current"]').check();
      await unfiledWs.locator('[data-mnselect="mock-older"]').check();
      await expect(unfiledWs.locator(".mn-count")).toContainText("2 selected");
      await expect(newBtn).toBeEnabled();

      // Name the new workstream via the prompt, then create it.
      const wsName = `Image attachments ${Date.now()}`;
      page.once("dialog", (d) => d.accept(wsName));
      await newBtn.click();

      // Persisted: a real workstream now carries both sessions, and the Unfiled bucket is gone.
      await expect.poll(async () => {
        const r = await unfiledRollup(page, projectId);
        const real = r?.workstreams.find((w) => !w.workstream.id.endsWith(":unfiled") && w.workstream.name === wsName);
        return real?.sessions.map((s) => s.id).sort().join(",");
      }).toBe("mock-current,mock-older");
      await expect.poll(async () => {
        const r = await unfiledRollup(page, projectId);
        return r?.workstreams.some((w) => w.workstream.id.endsWith(":unfiled")) ?? false;
      }).toBe(false);

      // The UI re-rendered: the new real workstream row is present in the grid (its row may be
      // collapsed inside the re-rendered card chrome), and no Unfiled bucket remains.
      await expect(view.locator(`.ws-unfiled[data-unfiled-project="${projectId}"]`)).toHaveCount(0);
      await expect(view.locator(`.ws[data-ws-id]`, { hasText: wsName })).toHaveCount(1);

      expect(pageErrors).toEqual([]);
    });
  });
});
