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

    // The overlay renders real content (the hero always renders from the feed).
    await expect(view.locator(".hero")).toBeVisible();

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
});
