// S2 — Project/Workstream CRUD routes + project_registry_changed realtime.
//
// Subprocess harness (mock mode, isolated PI_WEB_PROJECTS_FILE) mirroring
// tests/api.test.ts. A /ws collector drains realtime envelopes so we can assert
// that each mutation emits exactly one project_registry_changed. S3 extends this
// file with the /api/rollups join cases.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAbsolute } from "node:path";

import {
  openRealtime,
  startServer,
  type RealtimeCollector,
  type RollupServer,
} from "./helpers/rollupHarness.js";

describe("rollups registry CRUD routes", () => {
  let server: RollupServer;
  let realtime: RealtimeCollector;

  beforeAll(async () => {
    server = await startServer();
    realtime = await openRealtime(server);
  }, 20_000);

  afterAll(async () => {
    realtime?.close();
    await server?.stop();
  });

  it("GET /api/projects returns the empty default registry", async () => {
    const res = await server.api("GET", "/api/projects");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.registry).toEqual({ version: 1, projects: [], workstreams: [] });
  });

  it("rejects a project with no name or no roots (400, not 500)", async () => {
    const noName = await server.api("POST", "/api/projects", { roots: ["/tmp/x"] });
    expect(noName.status).toBe(400);
    expect(noName.body.ok).toBe(false);

    const noRoots = await server.api("POST", "/api/projects", { name: "x", roots: [] });
    expect(noRoots.status).toBe(400);
    expect(noRoots.body.ok).toBe(false);
  });

  it("rejects a malformed JSON body with 400 (readBody throws are caught)", async () => {
    const res = await server.api("POST", "/api/projects", "{ not valid json");
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("runs the full create -> dod -> toggle -> attach -> delete lifecycle, one envelope per mutation", async () => {
    realtime.clear();
    let mutations = 0;
    const expectOneMoreEnvelope = async () => {
      mutations += 1;
      await realtime.waitForType("project_registry_changed", mutations);
      expect(realtime.typeCount("project_registry_changed")).toBe(mutations);
    };

    // 1. Create a project (roots resolved to absolute).
    const created = await server.api("POST", "/api/projects", {
      name: "Rollups",
      roots: ["./relative-root", "/tmp/rollups-abs"],
    });
    expect(created.status).toBe(201);
    expect(created.body.project.name).toBe("Rollups");
    expect(created.body.project.roots.every((root: string) => isAbsolute(root))).toBe(true);
    const projectId: string = created.body.project.id;
    await expectOneMoreEnvelope();

    // 2. Create a workstream under it.
    const ws = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "auth" });
    expect(ws.status).toBe(201);
    expect(ws.body.workstream.projectId).toBe(projectId);
    const workstreamId: string = ws.body.workstream.id;
    await expectOneMoreEnvelope();

    // Creating a workstream under an unknown project -> 404.
    const orphan = await server.api("POST", "/api/projects/does-not-exist/workstreams", { name: "x" });
    expect(orphan.status).toBe(404);

    // 3. Set a DoD: one manual sign-off gate + one git_clean.
    const dod = await server.api("PUT", `/api/workstreams/${workstreamId}/dod`, {
      criteria: [
        { text: "Reviewer signs off", source: { kind: "manual" }, gate: true },
        { text: "Working tree clean", source: { kind: "git_clean" } },
      ],
    });
    expect(dod.status).toBe(200);
    const criteria = dod.body.workstream.dod.criteria as Array<{ id: string; source: { kind: string }; met?: boolean }>;
    expect(criteria).toHaveLength(2);
    const manual = criteria.find((c) => c.source.kind === "manual")!;
    const gitClean = criteria.find((c) => c.source.kind === "git_clean")!;
    expect(manual.met).toBe(false); // manual booleans persist
    expect("met" in gitClean).toBe(false); // computed sources never persist a met
    await expectOneMoreEnvelope();

    // 4. Toggle the manual criterion -> 200, persists.
    const toggleManual = await server.api("PATCH", `/api/dod/criterion/${manual.id}`, { met: true });
    expect(toggleManual.status).toBe(200);
    expect(toggleManual.body.criterion.met).toBe(true);
    await expectOneMoreEnvelope();

    // 5. Toggle a non-manual (git_clean) criterion -> 400, no broadcast, registry unchanged.
    const beforeToggle = realtime.typeCount("project_registry_changed");
    const toggleGit = await server.api("PATCH", `/api/dod/criterion/${gitClean.id}`, { met: true });
    expect(toggleGit.status).toBe(400);
    expect(toggleGit.body.ok).toBe(false);
    // No envelope should have been emitted for the rejected toggle.
    expect(realtime.typeCount("project_registry_changed")).toBe(beforeToggle);

    // Unknown criterion id -> 404.
    const unknownCriterion = await server.api("PATCH", "/api/dod/criterion/nope", { met: true });
    expect(unknownCriterion.status).toBe(404);

    // 6. Attach sessions (mock feed has mock-current / mock-older).
    const attach = await server.api("PUT", `/api/workstreams/${workstreamId}/sessions`, {
      sessionIds: ["mock-current"],
    });
    expect(attach.status).toBe(200);
    expect(attach.body.workstream.sessionIds).toEqual(["mock-current"]);
    await expectOneMoreEnvelope();

    // Persisted manual truth survives a fresh read; git criterion stays computed-only.
    const afterToggle = await server.api("GET", "/api/projects");
    const persistedWs = afterToggle.body.registry.workstreams.find((w: any) => w.id === workstreamId);
    const persistedManual = persistedWs.dod.criteria.find((c: any) => c.id === manual.id);
    expect(persistedManual.met).toBe(true);

    // 7. PATCH the project name.
    const patched = await server.api("PATCH", `/api/projects/${projectId}`, { name: "Rollups v2" });
    expect(patched.status).toBe(200);
    expect(patched.body.project.name).toBe("Rollups v2");
    await expectOneMoreEnvelope();

    // 8. Delete the project -> its workstreams are dropped too.
    const del = await server.api("DELETE", `/api/projects/${projectId}`);
    expect(del.status).toBe(200);
    await expectOneMoreEnvelope();

    const finalState = await server.api("GET", "/api/projects");
    expect(finalState.body.registry.projects).toHaveLength(0);
    expect(finalState.body.registry.workstreams).toHaveLength(0);
  }, 20_000);

  it("returns 404 for unknown project PATCH/DELETE and unknown workstream PATCH", async () => {
    const patch = await server.api("PATCH", "/api/projects/missing", { name: "x" });
    expect(patch.status).toBe(404);

    const del = await server.api("DELETE", "/api/projects/missing");
    expect(del.status).toBe(404);

    const ws = await server.api("PATCH", "/api/workstreams/missing", { name: "x" });
    expect(ws.status).toBe(404);

    const wsSessions = await server.api("PUT", "/api/workstreams/missing/sessions", { sessionIds: [] });
    expect(wsSessions.status).toBe(404);

    const wsDod = await server.api("PUT", "/api/workstreams/missing/dod", { criteria: [] });
    expect(wsDod.status).toBe(404);
  });
});

describe("rollups registry CRUD auth", () => {
  let server: RollupServer;

  beforeAll(async () => {
    server = await startServer({ token: "secret" });
  }, 20_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("rejects unauthenticated requests with 401 and accepts the token", async () => {
    const unauth = await server.apiNoAuth("GET", "/api/projects");
    expect(unauth.status).toBe(401);

    const unauthPost = await server.apiNoAuth("POST", "/api/projects", { name: "x", roots: ["/tmp/x"] });
    expect(unauthPost.status).toBe(401);

    const authed = await server.api("GET", "/api/projects");
    expect(authed.status).toBe(200);
    expect(authed.body.ok).toBe(true);
  });
});
