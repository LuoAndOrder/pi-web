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

// Seed a MANUAL (no-DoD) workstream with a live mock session attached. The session derives
// uiStatus "unset" (no DoD), so the workstream renders the calm "in progress · Mark done"
// manual model — the R3 surface under test. Root is arbitrary (the session is attached
// explicitly via PUT sessions, so it rolls up regardless of cwd-prefix).
async function createManualProject(request: APIRequestContext, name: string): Promise<{ projectId: string; workstreamId: string }> {
  const root = `/tmp/rollups-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pRes = await request.post("/api/projects", { data: { name, roots: [root] } });
  expect(pRes.status(), await pRes.text()).toBe(201);
  const projectId = (await pRes.json()).project.id as string;
  createdProjectIds.push(projectId);

  const wRes = await request.post(`/api/projects/${projectId}/workstreams`, { data: { name: "Manual work" } });
  expect(wRes.status(), await wRes.text()).toBe(201);
  const workstreamId = (await wRes.json()).workstream.id as string;

  const sessRes = await request.put(`/api/workstreams/${workstreamId}/sessions`, { data: { sessionIds: ["mock-current"] } });
  expect(sessRes.status(), await sessRes.text()).toBe(200);

  return { projectId, workstreamId };
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

// Create/rename/destructive-confirm flows now use an IN-OVERLAY modal (#dashboardModal) styled
// on the dark pi-web theme — NOT native window.prompt/confirm — so these helpers drive that modal
// instead of page.on("dialog"). The modal is scoped under #dashboardView and resolves a Promise on
// confirm/submit (its click is awaited by the call site), so the assertions that poll the registry
// afterward stay race-free.
async function confirmModalAccept(page: Page): Promise<void> {
  const modal = page.locator("#dashboardModal");
  await expect(modal).toBeVisible();
  await modal.locator("[data-mnmodal-confirm]").click();
  await expect(modal).toBeHidden();
}
async function confirmModalDismiss(page: Page): Promise<void> {
  const modal = page.locator("#dashboardModal");
  await expect(modal).toBeVisible();
  // The cancel BUTTON (not the scrim, which shares the data attribute) declines the confirm.
  await modal.locator("button[data-mnmodal-cancel]").click();
  await expect(modal).toBeHidden();
}
async function promptModalSubmit(page: Page, value: string): Promise<void> {
  const modal = page.locator("#dashboardModal");
  await expect(modal).toBeVisible();
  await modal.locator("#dashboardModalInput").fill(value);
  await modal.locator("[data-mnmodal-submit]").click();
  await expect(modal).toBeHidden();
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

  // Regression for the sign-off-targets-wrong-row finding: a workstream- (or project-) level
  // DoD is INHERITED by every session under it, so all N sessions render the SAME gate criterion
  // id. The old click handler reverse-mapped that shared critId back to a session and always
  // resolved the FIRST match, so clicking the 2nd row signed off the 1st. The fix carries each
  // row's own session id in data-signoff-session; this test seeds TWO sessions sharing one
  // workstream DoD gate, clicks the SECOND row, and asserts the SECOND row (not the first)
  // optimistically flips to "✓ Signed off".
  test("sign-off targets the CLICKED row when sessions share a workstream-level DoD gate", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    // Both mock sessions live in the repo-root cwd; register a project there so they roll up.
    const sres = await page.request.get("/api/sessions");
    const sessions = (await sres.json()).sessions as Array<{ id: string; cwd?: string }>;
    const root = sessions.find((s) => s.id === "mock-current")?.cwd as string;
    expect(root, "mock-current must have a cwd").toBeTruthy();

    const name = `E2E SharedGate ${Date.now()}`;
    const pRes = await page.request.post("/api/projects", { data: { name, roots: [root] } });
    expect(pRes.status(), await pRes.text()).toBe(201);
    const projectId = (await pRes.json()).project.id as string;
    createdProjectIds.push(projectId);

    const wRes = await page.request.post(`/api/projects/${projectId}/workstreams`, { data: { name: "Shared-gate workstream" } });
    expect(wRes.status(), await wRes.text()).toBe(201);
    const workstreamId = (await wRes.json()).workstream.id as string;
    // One met scorable criterion (ring → 100%) + one unmet manual GATE → each attached session
    // inherits this DoD and rolls up to uiStatus "sign".
    await page.request.put(`/api/workstreams/${workstreamId}/dod`, { data: { criteria: SIGN_DOD } });
    // Attach BOTH mock sessions to this one workstream so they share the inherited gate.
    await page.request.put(`/api/workstreams/${workstreamId}/sessions`, { data: { sessionIds: ["mock-current", "mock-older"] } });

    await page.locator("#dashboardButton").click();
    const view = page.locator("#dashboardView");
    await expect(view).toBeVisible();

    // The fleet sign-off rail renders one row per session. Both rows carry the SAME data-signoff
    // (the inherited gate critId) but DISTINCT data-signoff-session.
    const signoff = view.locator('[data-testid="signoff"]');
    await expect(signoff).toBeVisible();
    const olderBtn = signoff.locator('.soff button[data-signoff-session="mock-older"]');
    const currentBtn = signoff.locator('.soff button[data-signoff-session="mock-current"]');
    await expect(olderBtn).toBeVisible();
    await expect(currentBtn).toBeVisible();
    // Sanity: both buttons share the same gate criterion id (the inherited DoD) — the exact
    // condition the old reverse-map mishandled.
    const olderCrit = await olderBtn.getAttribute("data-signoff");
    const currentCrit = await currentBtn.getAttribute("data-signoff");
    expect(olderCrit).toBeTruthy();
    expect(olderCrit).toBe(currentCrit);

    // Click the SECOND row (mock-older). After the optimistic flip + re-render its sign-off
    // button is GONE (replaced by "✓ Signed off") while mock-current's sign-off button REMAINS
    // actionable. The bug flipped the FIRST row, which would leave mock-older's button present
    // and mock-current's gone — so asserting exactly the inverse proves the clicked row won.
    await olderBtn.click();
    await expect(signoff.locator('button[data-signoff-session="mock-older"]')).toHaveCount(0);
    await expect(signoff.locator('button[data-signoff-session="mock-current"]')).toBeVisible();
    // And the signed-off row sits where mock-older's row was — exactly one "✓ Signed off" marker.
    await expect(signoff.locator('.soff', { hasText: "Signed off" })).toHaveCount(1);

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

    // The overlay hides and the REAL conversation loads: composer present, and the URL LEAVES
    // `/dashboard` to `/?sessionId=mock-current` (opening a session navigates off the route).
    await expect(view).toBeHidden();
    await expect(page.locator("#prompt")).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
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

  // R3 — manual-first lifecycle: a no-DoD workstream is a CALM "in progress · Mark done"
  // state, NOT a "needs setup" alarm. Mark done is the default primary action and flips the
  // project ring; "Add criteria to auto-track" is an OPTIONAL secondary that switches the
  // workstream to k-of-n auto-tracking. Sessions never offer "Define done".
  test.describe("R3: manual-first lifecycle", () => {
    async function rollupFor(page: Page, projectId: string) {
      const res = await page.request.get("/api/rollups");
      expect(res.ok()).toBe(true);
      const rollups = (await res.json()).rollups as Array<{
        project: { id: string };
        workstreams: Array<{ workstream: { id: string; status: string; dod?: { criteria: unknown[] } } }>;
      }>;
      return rollups.find((r) => r.project.id === projectId);
    }

    test("a no-DoD workstream shows Mark done (not needs-setup); Mark done flips the ring", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      const name = `E2E Manual ${Date.now()}`;
      const { projectId, workstreamId } = await createManualProject(page.request, name);

      await page.locator("#dashboardButton").click();
      const view = page.locator("#dashboardView");
      await expect(view).toBeVisible();

      // The manual project is a calm full card — NEVER a "needs setup" group, and no "Define
      // done" anywhere in the dashboard.
      await expect(view.locator('[data-testid="needs-setup"]')).toHaveCount(0);
      await expect(view.getByText("Define done", { exact: false })).toHaveCount(0);
      const pcard = view.locator(`.pcard[data-project-id="${projectId}"]`);
      await expect(pcard).toBeVisible();

      // The project gauge starts at 0% (0 of 1 workstreams done) — an honest k-of-n, not a "?".
      const gaugeRing = pcard.locator('.csum-ring [data-testid="ring"][data-percent]').first();
      await expect(gaugeRing).toHaveAttribute("data-percent", "0");

      // Expand → the workstream row shows the calm manual line + the OPTIONAL "Add criteria to
      // auto-track" affordance, and the session row's DEFAULT primary action is Mark done.
      await pcard.locator(".pcard-head").click();
      const wsRow = pcard.locator(`.ws[data-ws-id="${workstreamId}"]`);
      await expect(wsRow).toBeVisible();
      await expect(wsRow.locator(".ws-dod")).toContainText("tracked manually");
      await expect(wsRow.locator(`[data-wsaddcriteria="${workstreamId}"]`)).toBeVisible();
      await wsRow.locator(".ws-head").click();
      const markDone = wsRow.locator(`.sess [data-wsaction="done"][data-wsid="${workstreamId}"]`).first();
      await expect(markDone).toBeVisible();
      await expect(markDone).toContainText("Mark done");

      // Mark done → persists status "done" AND the project ring flips to 100% (1 of 1 done).
      await markDone.click();
      await expect.poll(async () => (await rollupFor(page, projectId))?.workstreams[0]?.workstream.status).toBe("done");
      await expect.poll(async () =>
        pcard.locator('.csum-ring [data-testid="ring"][data-percent]').first().getAttribute("data-percent"),
      ).toBe("100");

      expect(pageErrors).toEqual([]);
    });

    test("Add criteria to auto-track switches a manual workstream to honest k-of-n", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      const name = `E2E AddCriteria ${Date.now()}`;
      const { projectId, workstreamId } = await createManualProject(page.request, name);

      await page.locator("#dashboardButton").click();
      const view = page.locator("#dashboardView");
      await expect(view).toBeVisible();
      const pcard = view.locator(`.pcard[data-project-id="${projectId}"]`);
      await expect(pcard).toBeVisible();
      await pcard.locator(".pcard-head").click();

      // Open the OPTIONAL authoring drawer from the workstream's "Add criteria to auto-track".
      await pcard.locator(`[data-wsaddcriteria="${workstreamId}"]`).click();
      const drawer = view.locator("#dashboardDodDrawer");
      await expect(drawer).toBeVisible();

      // Add one manual boolean criterion the ring can score, then save.
      await drawer.locator('[data-critadd="manual"]').click();
      await drawer.locator("[data-critsave]").click();

      // Persisted: the workstream now carries a DoD (auto-tracking), so it's no longer no-DoD.
      await expect(drawer).toBeHidden();
      await expect.poll(async () => {
        const r = await rollupFor(page, projectId);
        return (r?.workstreams[0]?.workstream.dod?.criteria.length ?? 0) > 0;
      }).toBe(true);
      // Switched to auto-track: the optional manual "Add criteria to auto-track" affordance is
      // GONE for this workstream (it only renders for a no-DoD/manual workstream), confirming the
      // workstream now auto-tracks its k-of-n criteria instead of being marked done by hand.
      await expect(view.locator(`[data-wsaddcriteria="${workstreamId}"]`)).toHaveCount(0);

      expect(pageErrors).toEqual([]);
    });
  });

  // M2 — the dashboard is a REAL top-level route at `/dashboard` (NOT a `?view=` query param,
  // NOT a modal): a hard GET loads it as the page, reload preserves it, the statusBar button
  // navigates there (pushState), opening a session leaves to `/?sessionId=`, and an outside
  // (background) click does NOT dismiss it. These cases mutate nothing, so they ride the
  // shared playwright server safely.
  test.describe("M2: /dashboard route", () => {
    test("hard GET /dashboard loads the dashboard as the page; reload stays on /dashboard", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      await page.goto("/dashboard");
      await expect(page.locator("#connectionStatus")).toBeHidden();

      // The dashboard is the primary view straight from the URL — no click, no modal over a session.
      await expect(page.locator("#dashboardView")).toBeVisible();
      // It is a real route: the path stays `/dashboard`, with no `?view=` param and no rewrite to `/`.
      expect(new URL(page.url()).pathname).toBe("/dashboard");
      expect(new URL(page.url()).searchParams.get("view")).toBeNull();

      // Reload stays on `/dashboard` — the route survives a hard reload (server SPA fallback).
      await page.reload();
      await expect(page.locator("#connectionStatus")).toBeHidden();
      await expect(page.locator("#dashboardView")).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/dashboard");

      expect(pageErrors).toEqual([]);
    });

    test("the statusBar button navigates to /dashboard; ESC returns to the conversation; Back restores it", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      const view = page.locator("#dashboardView");
      await expect(view).toBeHidden();
      expect(new URL(page.url()).pathname).toBe("/");

      // Opening via the statusBar button navigates (pushState) to `/dashboard`.
      await page.locator("#dashboardButton").click();
      await expect(view).toBeVisible();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/dashboard");

      // ESC leaves the route back to the conversation at `/`.
      await page.keyboard.press("Escape");
      await expect(view).toBeHidden();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/");

      // Back navigation restores the dashboard route (the open was a pushState entry).
      await page.goBack();
      await expect(view).toBeVisible();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/dashboard");

      expect(pageErrors).toEqual([]);
    });

    test("clicking the background does NOT dismiss to a session (no outside-click dismiss)", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      await page.goto("/dashboard");
      await expect(page.locator("#connectionStatus")).toBeHidden();
      const view = page.locator("#dashboardView");
      await expect(view).toBeVisible();

      // Click the opaque background gutter (the #dashboardView itself, left of the centered .wrap).
      // The old modal behavior cut to the session on such a click; the route must stay put — the
      // dashboard stays visible and the URL stays `/dashboard` (no navigation off the route).
      await view.click({ position: { x: 4, y: 240 } });
      await expect(view).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/dashboard");

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
      // ...AND its `sign` session leaves the FLEET sign-off rail too. The adapter still indexes
      // archived sessions into SESS (so the Archived row's controls resolve), but the fleet
      // sign-off list must filter inactive workstreams out — otherwise a shelved session keeps
      // inflating "N to sign off" and the rail. (Regression guard for the render-side _inactive
      // filter; the session card already left the grid above.)
      await expect(view.locator('[data-testid="signoff"] [data-open="mock-current"]')).toHaveCount(0);

      // ── Restore then Cancel ── restore from the Archived row, then cancel (abandon) it.
      await archived.locator(`.archrow[data-ws-id="${workstreamId}"] [data-wsaction="restore"]`).click();
      await expect.poll(async () => (await rollupFor(page, projectId))?.workstreams[0]?.inactive ?? false).toBe(false);

      // Cancel confirms via the in-overlay modal → accept it.
      const cardMenu2 = pcard.locator(".pcard-head .wsmenu").first();
      await cardMenu2.locator("[data-wsmenu-toggle]").click();
      await cardMenu2.locator(`[data-wsaction="cancel"]`).click();
      await confirmModalAccept(page);
      // Persisted as abandoned → inactive again, surfaced as "Cancelled" in Archived.
      await expect.poll(async () => (await rollupFor(page, projectId))?.workstreams[0]?.workstream.status).toBe("abandoned");
      const archived2 = view.locator('[data-testid="archived"]');
      await expect(archived2).toBeVisible();
      await archived2.locator(".done-head").click(); // expand (re-rendered collapsed)
      await expect(archived2.locator(`.archrow[data-ws-id="${workstreamId}"]`)).toContainText("Cancelled");

      // ── Delete ── from the Archived row; confirm modal accepted. The workstream is gone.
      await archived2.locator(`.archrow[data-ws-id="${workstreamId}"] [data-wsaction="delete"]`).click();
      await confirmModalAccept(page);
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
      const cardMenu = pcard.locator(".pcard-head .wsmenu").first();
      await cardMenu.locator("[data-wsmenu-toggle]").click();
      await cardMenu.locator(`[data-wsaction="cancel"]`).click();
      await confirmModalDismiss(page);
      // Still active (not abandoned, not inactive).
      const r = await rollupFor(page, projectId);
      expect(r?.workstreams[0]?.workstream.status).not.toBe("abandoned");
      expect(r?.workstreams[0]?.inactive ?? false).toBe(false);

      expect(pageErrors).toEqual([]);
    });

    // Round-4 high finding: Delete → Undo must FAITHFULLY restore a `command` DoD criterion's
    // real command, not a hardcoded `npm test`. The pre-delete snapshot reads the RAW registry
    // (`GET /api/projects` → `dod.criteria` with intact `source.cmd`), so the Undo re-creates the
    // workstream with the exact stored command. This guards against the lossy view-model rebuild.
    test("Delete → Undo restores the exact command DoD (make lint), not a hardcoded npm test", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      const name = `E2E UndoCmdDoD ${Date.now()}`;
      // Seed the same "awaiting sign-off" shape the other lifecycle tests use (so the card
      // renders in a stable, locatable surface) — then ADD a distinctive command + git criterion
      // whose stored `source` is what Undo must faithfully restore.
      const { projectId, workstreamId } = await createSignProject(page.request, name);
      const root = `/tmp/rollups-e2e-cmd-${Date.now()}`;
      const COMMAND_DOD = [
        ...SIGN_DOD,
        { text: "make lint passes", source: { kind: "command", cwd: root, cmd: "make lint" }, weight: 1 },
        { text: "merged to release", source: { kind: "git_merged", into: "release" }, weight: 1 },
      ];
      await page.request.put(`/api/workstreams/${workstreamId}/dod`, { data: { criteria: COMMAND_DOD } });

      await page.locator("#dashboardButton").click();
      const view = page.locator("#dashboardView");
      await expect(view).toBeVisible();
      // A workstream whose DoD includes an as-yet-unevaluated command criterion sorts into the
      // collapsed "Healthy & dormant" section rather than the active grid (its ring reads quiet).
      // Expand that section and drill into the project row so its workstream kebab is reachable —
      // this is the real user path to lifecycle actions on a dormant project.
      const dormant = view.locator("#sec-healthy");
      await expect(dormant).toBeVisible();
      await dormant.locator('.grp-h[data-toggle="grp"]').click();
      await expect(dormant).toHaveClass(/open/);
      const prow = dormant.locator(`.prow[data-project-id="${projectId}"]`);
      await expect(prow).toBeVisible();
      await prow.click(); // drill in → expands the prow body with the workstream rows + kebab
      const wsMenu = view.locator(`.wsmenu[data-wsmenu="${workstreamId}"]`).first();
      await expect(wsMenu).toBeVisible();

      // Delete via the workstream kebab; accept the confirm modal.
      await wsMenu.locator("[data-wsmenu-toggle]").click();
      await wsMenu.locator(`[data-wsaction="delete"]`).click();
      await confirmModalAccept(page);
      // The original workstream is gone.
      await expect.poll(async () => (await rollupFor(page, projectId))?.workstreams.length ?? 0).toBe(0);

      // Click the Undo toast → re-creates the workstream (a new id) from the snapshot.
      const undo = page.locator("#dashboardToastUndo");
      await expect(undo).toBeVisible();
      await undo.click();
      await expect.poll(async () => (await rollupFor(page, projectId))?.workstreams.length ?? 0).toBe(1);

      // Assert the restored command criterion preserves `make lint` (NOT npm test) and the git
      // criterion preserves `into: release` (NOT main) — read from the raw registry.
      const reg = await (await page.request.get("/api/projects")).json();
      const restored = reg.registry.workstreams.find((w: { projectId: string }) => w.projectId === projectId);
      expect(restored, "re-created workstream present in registry").toBeTruthy();
      const sources = (restored.dod?.criteria ?? []).map((c: { source: Record<string, unknown> }) => c.source);
      const cmd = sources.find((s: { kind?: string }) => s.kind === "command");
      expect(cmd?.cmd).toBe("make lint");
      expect(cmd?.cmd).not.toBe("npm test");
      const git = sources.find((s: { kind?: string }) => s.kind === "git_merged");
      expect(git?.into).toBe("release");

      expect(pageErrors).toEqual([]);
    });

    // Full PROJECT lifecycle round-trip in the UI: archive a project from its kebab → it leaves
    // the active grid and lands in the collapsed "Archived projects" surface → Restore from there
    // brings it back. Guards the MED finding (archived projects were UI-unreachable). Also exercises
    // the project kebab POPOVER escaping the card's overflow:hidden clip (HIGH finding) — the
    // archive item must be clickable, not sliced off at the card edge.
    test("Archive a project → it moves to the Archived projects surface → Restore brings it back", async ({ page }) => {
      const pageErrors = trackPageErrors(page);
      const name = `E2E ProjLifecycle ${Date.now()}`;
      const { projectId } = await createSignProject(page.request, name);

      await page.locator("#dashboardButton").click();
      const view = page.locator("#dashboardView");
      await expect(view).toBeVisible();
      const pcard = view.locator(`.pcard[data-project-id="${projectId}"]`);
      await expect(pcard).toBeVisible();

      // ── Archive ── open the project kebab; its popover must be fully visible (position:fixed,
      // escaping the card clip) so the Archive item is clickable. Accept the confirm modal.
      const projMenu = pcard.locator(".pcard-head .projmenu").first();
      await projMenu.locator("[data-projmenu-toggle]").click();
      const projPop = projMenu.locator(".projmenu-pop");
      await expect(projPop).toBeVisible();
      // The popover is promoted to position:fixed so it can't be clipped by .pcard{overflow:hidden}.
      await expect(projPop).toHaveClass(/pop-fixed/);
      const archiveItem = projMenu.locator('[data-projaction="archive"]');
      await expect(archiveItem).toBeVisible();
      await archiveItem.click();
      await confirmModalAccept(page);

      // The project leaves the active grid and the feed's rollups[] (archivedProjects[] carries it).
      await expect.poll(async () => {
        const res = await page.request.get("/api/rollups");
        const body = await res.json();
        return (body.rollups as Array<{ project: { id: string } }>).some((r) => r.project.id === projectId);
      }).toBe(false);
      await expect(pcard).toHaveCount(0);

      // ── Archived projects surface ── collapsed by default; expand and assert the row is there.
      const archProj = view.locator('[data-testid="archived-projects"]');
      await expect(archProj).toBeVisible();
      await archProj.locator(".done-head").click();
      const archRow = archProj.locator(`.archrow[data-archived-project-id="${projectId}"]`);
      await expect(archRow).toBeVisible();
      await expect(archRow).toContainText(name);

      // ── Restore ── from the archived-projects row → project rejoins the active grid.
      await archRow.locator('[data-projaction="restore"]').click();
      await expect.poll(async () => {
        const res = await page.request.get("/api/rollups");
        const body = await res.json();
        return (body.rollups as Array<{ project: { id: string } }>).some((r) => r.project.id === projectId);
      }).toBe(true);
      await expect(view.locator(`.pcard[data-project-id="${projectId}"]`)).toBeVisible();

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

      // A no-DoD project with only loose Unfiled sessions renders as a calm "manual" full
      // .pcard (NOT a "Needs setup" alarm group — that framing is gone). R4: the all-loose card
      // AUTO-OPENS and surfaces a prominent "Organize N unfiled sessions" CTA, and its Unfiled
      // bucket is open by default, so the organize tools are reachable WITHOUT any expand clicks.
      await expect(view.locator('[data-testid="needs-setup"]')).toHaveCount(0);
      const card = view.locator(`.pcard[data-project-id="${projectId}"]`);
      await expect(card).toBeVisible();
      await expect(card).toHaveClass(/\bopen\b/); // auto-open (no head click needed)
      await expect(card).toContainText("Organize 2 unfiled sessions");
      const unfiledWs = view.locator(`.ws-unfiled[data-unfiled-project="${projectId}"]`);
      await expect(unfiledWs).toBeVisible();
      await expect(unfiledWs).toHaveClass(/\bopen\b/); // bucket open by default — tools visible

      // The organize tools (assignment bar + New workstream) are present and visible WITHOUT
      // expanding anything. The assignment bar starts disabled (no selection).
      const newBtn = unfiledWs.locator("[data-mn-newws]");
      await expect(newBtn).toBeVisible();
      await expect(newBtn).toBeDisabled();

      // Select both sessions via their (already-visible) checkboxes.
      await unfiledWs.locator('[data-mnselect="mock-current"]').check();
      await unfiledWs.locator('[data-mnselect="mock-older"]').check();
      await expect(unfiledWs.locator(".mn-count")).toContainText("2 selected");
      await expect(newBtn).toBeEnabled();

      // Name the new workstream via the in-overlay prompt modal, then create it.
      const wsName = `Image attachments ${Date.now()}`;
      await newBtn.click();
      await promptModalSubmit(page, wsName);

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
