// S2 — Project/Workstream CRUD routes + project_registry_changed realtime.
//
// Subprocess harness (mock mode, isolated PI_WEB_PROJECTS_FILE) mirroring
// tests/api.test.ts. A /ws collector drains realtime envelopes so we can assert
// that each mutation emits exactly one project_registry_changed. S3 extends this
// file with the /api/rollups join cases.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  openRealtime,
  startServer,
  type RealtimeCollector,
  type RollupServer,
} from "./helpers/rollupHarness.js";
import {
  checkout,
  checkoutNew,
  commitFile,
  initRepo,
  makeDirty,
  mergeNoFf,
  renameBranch,
} from "./helpers/gitRepo.js";

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

  it("M1: DELETE a workstream removes it + dereferences its id; PATCH round-trips status/archived", async () => {
    realtime.clear();
    const created = await server.api("POST", "/api/projects", { name: "M1", roots: [process.cwd()] });
    const projectId: string = created.body.project.id;

    const a = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "keep" });
    const b = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "drop" });
    const keepId: string = a.body.workstream.id;
    const dropId: string = b.body.workstream.id;

    // PATCH status -> done, then abandoned; PATCH archived -> true round-trips.
    const done = await server.api("PATCH", `/api/workstreams/${keepId}`, { status: "done" });
    expect(done.status).toBe(200);
    expect(done.body.workstream.status).toBe("done");
    const abandoned = await server.api("PATCH", `/api/workstreams/${keepId}`, { status: "abandoned" });
    expect(abandoned.body.workstream.status).toBe("abandoned");
    const archived = await server.api("PATCH", `/api/workstreams/${keepId}`, { archived: true });
    expect(archived.body.workstream.archived).toBe(true);

    // DELETE the other workstream -> gone + dereferenced from the project.
    const del = await server.api("DELETE", `/api/workstreams/${dropId}`);
    expect(del.status).toBe(200);
    // A repeat DELETE is now 404.
    expect((await server.api("DELETE", `/api/workstreams/${dropId}`)).status).toBe(404);

    const state = await server.api("GET", "/api/projects");
    const proj = state.body.registry.projects.find((p: any) => p.id === projectId);
    expect(proj.workstreamIds).toEqual([keepId]); // dropId dereferenced
    expect(state.body.registry.workstreams.map((w: any) => w.id)).toEqual([keepId]);
    // The archived workstream is still retrievable.
    expect(state.body.registry.workstreams[0].archived).toBe(true);

    // Each mutation emitted exactly one project_registry_changed: POST project,
    // POST keep, POST drop, PATCH done, PATCH abandoned, PATCH archived, DELETE drop
    // = 7 (the repeated 404 DELETE broadcasts nothing).
    await realtime.waitForType("project_registry_changed", 7);
    expect(realtime.typeCount("project_registry_changed")).toBe(7);

    // The archived workstream is excluded from the active gauge but kept retrievable.
    const rollupRes = await server.api("GET", `/api/rollups/${projectId}`);
    expect(rollupRes.status).toBe(200);
    const rolledWs = rollupRes.body.rollup.workstreams.find((w: any) => w.workstream.id === keepId);
    expect(rolledWs.inactive).toBe(true);

    await server.api("DELETE", `/api/projects/${projectId}`);
  }, 20_000);

  it("M1: PUT sessions into an archived/abandoned workstream is 409 (no silent move into the inactive bucket)", async () => {
    const created = await server.api("POST", "/api/projects", { name: "M1-guard", roots: [process.cwd()] });
    const projectId: string = created.body.project.id;
    const a = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "shelved" });
    const b = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "killed" });
    const archivedId: string = a.body.workstream.id;
    const cancelledId: string = b.body.workstream.id;
    await server.api("PATCH", `/api/workstreams/${archivedId}`, { archived: true });
    await server.api("PATCH", `/api/workstreams/${cancelledId}`, { status: "abandoned" });

    const intoArchived = await server.api("PUT", `/api/workstreams/${archivedId}/sessions`, { sessionIds: ["s1"] });
    expect(intoArchived.status).toBe(409);
    expect(intoArchived.body.ok).toBe(false);
    const intoCancelled = await server.api("PUT", `/api/workstreams/${cancelledId}/sessions`, { sessionIds: ["s2"] });
    expect(intoCancelled.status).toBe(409);

    // Membership stayed empty — the guard short-circuits before any write.
    const state = await server.api("GET", "/api/projects");
    const ws = state.body.registry.workstreams;
    expect(ws.find((w: any) => w.id === archivedId).sessionIds).toEqual([]);
    expect(ws.find((w: any) => w.id === cancelledId).sessionIds).toEqual([]);

    await server.api("DELETE", `/api/projects/${projectId}`);
  }, 20_000);

  it("M1: PATCH sessionIds into an archived/abandoned workstream is 409 (mirrors the PUT guard)", async () => {
    const created = await server.api("POST", "/api/projects", { name: "M1-patch-guard", roots: [process.cwd()] });
    const projectId: string = created.body.project.id;
    // An ACTIVE workstream seeded with a live session — PATCH sessionIds must work normally here.
    const live = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "live", sessionIds: ["s1"] });
    const liveId: string = live.body.workstream.id;
    const a = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "shelved" });
    const b = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "killed" });
    const archivedId: string = a.body.workstream.id;
    const cancelledId: string = b.body.workstream.id;
    await server.api("PATCH", `/api/workstreams/${archivedId}`, { archived: true });
    await server.api("PATCH", `/api/workstreams/${cancelledId}`, { status: "abandoned" });

    // PATCH that tries to re-tag live sessions into a shelved workstream is rejected — without
    // this the sessions would silently flip to `abandoned` in the rollup and leave the grid.
    const intoArchived = await server.api("PATCH", `/api/workstreams/${archivedId}`, { sessionIds: ["s1"] });
    expect(intoArchived.status).toBe(409);
    expect(intoArchived.body.ok).toBe(false);
    const intoCancelled = await server.api("PATCH", `/api/workstreams/${cancelledId}`, { sessionIds: ["s2"] });
    expect(intoCancelled.status).toBe(409);

    // Membership of BOTH the shelved targets stayed empty (no partial write).
    let state = await server.api("GET", "/api/projects");
    let ws = state.body.registry.workstreams;
    expect(ws.find((w: any) => w.id === archivedId).sessionIds).toEqual([]);
    expect(ws.find((w: any) => w.id === cancelledId).sessionIds).toEqual([]);

    // A non-sessionIds PATCH on a shelved workstream still applies (e.g. rename).
    const rename = await server.api("PATCH", `/api/workstreams/${archivedId}`, { name: "shelved-renamed" });
    expect(rename.status).toBe(200);
    expect(rename.body.workstream.name).toBe("shelved-renamed");

    // PATCH sessionIds on an ACTIVE workstream works (the guard is scoped to shelved targets).
    const active = await server.api("PATCH", `/api/workstreams/${liveId}`, { sessionIds: ["s1", "s9"] });
    expect(active.status).toBe(200);
    expect(active.body.workstream.sessionIds).toEqual(["s1", "s9"]);

    // Un-archiving AND attaching sessions in ONE patch is allowed — the guard reads the
    // RESULTING (no-longer-archived) state, not the pre-patch flag.
    const revive = await server.api("PATCH", `/api/workstreams/${archivedId}`, { archived: false, sessionIds: ["s3"] });
    expect(revive.status).toBe(200);
    expect(revive.body.workstream.archived).toBeUndefined();
    expect(revive.body.workstream.sessionIds).toEqual(["s3"]);

    await server.api("DELETE", `/api/projects/${projectId}`);
  }, 20_000);

  it("returns 404 for unknown project PATCH/DELETE and unknown workstream PATCH", async () => {
    const patch = await server.api("PATCH", "/api/projects/missing", { name: "x" });
    expect(patch.status).toBe(404);

    const del = await server.api("DELETE", "/api/projects/missing");
    expect(del.status).toBe(404);

    const ws = await server.api("PATCH", "/api/workstreams/missing", { name: "x" });
    expect(ws.status).toBe(404);

    const wsDelete = await server.api("DELETE", "/api/workstreams/missing");
    expect(wsDelete.status).toBe(404);

    const wsSessions = await server.api("PUT", "/api/workstreams/missing/sessions", { sessionIds: [] });
    expect(wsSessions.status).toBe(404);

    const wsDod = await server.api("PUT", "/api/workstreams/missing/dod", { criteria: [] });
    expect(wsDod.status).toBe(404);
  });

  it("a malformed percent-sequence in a routable :id decodes to 404, not a 500", async () => {
    // safeDecode falls back to the raw segment instead of letting decodeURIComponent
    // throw URIError (which the outer catch would surface as a bogus 500).
    const project = await server.api("PATCH", "/api/projects/%E0%A4%A", { name: "x" });
    expect(project.status).toBe(404);

    const workstream = await server.api("PATCH", "/api/workstreams/%", { name: "x" });
    expect(workstream.status).toBe(404);

    const criterion = await server.api("PATCH", "/api/dod/criterion/%ZZ", { met: true });
    expect(criterion.status).toBe(404);
  });
});

describe("GET /api/rollups (the dashboard feed, S3)", () => {
  let server: RollupServer;
  let repo: string;
  let projectId: string;
  let gitWsId: string;
  let cmdWsId: string;

  // helpers to dig into the rollup feed
  const getRollups = async () => {
    const res = await server.api("GET", "/api/rollups");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    return res.body.rollups as any[];
  };
  const findProject = (rollups: any[]) => rollups.find((r) => r.project.id === projectId);
  const findWs = (project: any, id: string) =>
    project.workstreams.find((w: any) => w.workstream.id === id);
  const critOf = (progress: any, kind: string) =>
    (progress?.criteria || []).find((c: any) => c.sourceKind === kind);

  beforeAll(async () => {
    // A temp repo sitting on feat/x with main present (clean working tree).
    repo = await mkdtemp(join(tmpdir(), "rollups-feed-repo-"));
    await initRepo(repo);
    await commitFile(repo, "README.md", "base\n", "base");
    await renameBranch(repo, "main");
    await checkoutNew(repo, "feat/x");
    await commitFile(repo, "feature.txt", "feature\n", "feature work");

    // A 1ms TTL so each GET reads fresh git state (we mutate the repo between
    // GETs). "0" can't be used — the server's `Number(env) || 3000` treats it as
    // falsy and falls back to the 3s default. Two extra mock sessions sit INSIDE
    // the temp repo: the workstream ring aggregates its sessions' criteria
    // (DATA-MODEL §5.1), so each workstream needs a session in the repo for its
    // inherited git/command DoD to be evaluated against feat/x.
    server = await startServer({
      extraEnv: {
        PI_WEB_GIT_CACHE_TTL_MS: "1",
        PI_WEB_MOCK_EXTRA_SESSIONS: JSON.stringify([
          { id: "repo-git", cwd: repo },
          { id: "repo-cmd", cwd: repo },
        ]),
      },
    });

    const project = await server.api("POST", "/api/projects", { name: "Feed", roots: [repo] });
    expect(project.status).toBe(201);
    projectId = project.body.project.id;

    const gitWs = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "ship" });
    gitWsId = gitWs.body.workstream.id;
    // Homogeneous git DoD (+ a manual sign-off gate, which is excluded from the
    // family check so the ring stays a single proportional git ring).
    await server.api("PUT", `/api/workstreams/${gitWsId}/dod`, {
      criteria: [
        { text: "Working tree clean", source: { kind: "git_clean" } },
        { text: "feat/x merged into main", source: { kind: "git_merged", into: "main" } },
        { text: "Reviewer signs off", source: { kind: "manual" }, gate: true },
      ],
    });
    // Attach the in-repo session so the ring aggregates its (feat/x) git criteria.
    await server.api("PUT", `/api/workstreams/${gitWsId}/sessions`, { sessionIds: ["repo-git"] });

    const cmdWs = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "verify" });
    cmdWsId = cmdWs.body.workstream.id;
    await server.api("PUT", `/api/workstreams/${cmdWsId}/dod`, {
      criteria: [{ text: "tests pass", source: { kind: "command", cwd: repo, cmd: "exit 0" } }],
    });
    await server.api("PUT", `/api/workstreams/${cmdWsId}/sessions`, { sessionIds: ["repo-cmd"] });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("evaluates git criteria inline; clean tree met, unmerged branch unmet → percent 0", async () => {
    const project = findProject(await getRollups());
    expect(project).toBeTruthy();
    const ws = findWs(project, gitWsId);

    // git_clean is met (clean tree) but root-scoped OUT of the percent; the only
    // evaluable run criterion is git_merged, which is not yet an ancestor of main.
    expect(critOf(ws.progress, "git_clean").met).toBe(true);
    expect(critOf(ws.progress, "git_merged").met).toBe(false);
    expect(ws.progress.percent).toBe(0);
    expect(ws.progress.allMet).toBe(false);
  });

  it("never spawns a command on the render path — command criteria are unrun + excluded", async () => {
    const project = findProject(await getRollups());
    const ws = findWs(project, cmdWsId);
    const cmd = critOf(ws.progress, "command");
    expect(cmd.unrun).toBe(true);
    expect(cmd.met).toBe(false);
    expect(cmd.evidence).toMatch(/not yet run/i);
    expect(ws.progress.percent).toBe(0);
    expect(ws.progress.unrun).toBe(1);
  });

  it("git_merged flips true once feat/x is an ancestor of main → percent climbs to 100", async () => {
    await checkout(repo, "main");
    await mergeNoFf(repo, "feat/x");
    await checkout(repo, "feat/x"); // back on the feature branch; it is now merged

    const project = findProject(await getRollups());
    const ws = findWs(project, gitWsId);
    expect(critOf(ws.progress, "git_merged").met).toBe(true);
    expect(ws.progress.percent).toBe(100);
    expect(ws.progress.allMet).toBe(true); // gate excluded; no unrun/stale
  });

  it("git_clean flips false when the working tree is dirtied (fresh, uncached)", async () => {
    await makeDirty(repo, "scratch.txt");
    const project = findProject(await getRollups());
    const ws = findWs(project, gitWsId);
    expect(critOf(ws.progress, "git_clean").met).toBe(false);
    // git_merged is a permanent fact and stays met after the tree goes dirty.
    expect(critOf(ws.progress, "git_merged").met).toBe(true);
  });

  it("GET /api/rollups/:projectId returns a single rollup; unknown → 404", async () => {
    const one = await server.api("GET", `/api/rollups/${projectId}`);
    expect(one.status).toBe(200);
    expect(one.body.rollup.project.id).toBe(projectId);

    const missing = await server.api("GET", "/api/rollups/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.body.ok).toBe(false);
  });

  it("rolls up an explicitly-attached real session under its workstream", async () => {
    // The mock feed (mock-current) lives at piCwd, not the temp repo — explicit
    // membership maps it regardless of cwd.
    await server.api("PUT", `/api/workstreams/${gitWsId}/sessions`, { sessionIds: ["mock-current"] });
    const project = findProject(await getRollups());
    const ws = findWs(project, gitWsId);
    expect(ws.sessions.map((s: any) => s.id)).toContain("mock-current");
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

// ── S10: POST /api/dod/evaluate — sandboxed, opt-in command DoD ───────────────
describe("POST /api/dod/evaluate (command DoD, enabled)", () => {
  let server: RollupServer;
  let realtime: RealtimeCollector;
  let repo: string;
  let projectId: string;
  let wsId: string;
  // criterion ids by source kind (resolved after the DoD is set).
  const ids: Record<string, string> = {};

  const getWs = async () => {
    const res = await server.api("GET", "/api/rollups");
    const project = (res.body.rollups as any[]).find((r) => r.project.id === projectId);
    return project.workstreams.find((w: any) => w.workstream.id === wsId);
  };
  const critOf = (ws: any, kind: string) =>
    (ws.progress?.criteria || []).find((c: any) => c.sourceKind === kind);

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "rollups-eval-repo-"));
    await initRepo(repo);
    await commitFile(repo, "README.md", "base\n", "base");
    await renameBranch(repo, "main");
    await checkoutNew(repo, "feat/x");
    await commitFile(repo, "feature.txt", "feature\n", "feature work");
    await checkout(repo, "main");
    await mergeNoFf(repo, "feat/x");
    await checkout(repo, "feat/x"); // merged into main

    server = await startServer({
      extraEnv: {
        PI_WEB_ALLOW_DOD_COMMANDS: "1",
        PI_WEB_GIT_CACHE_TTL_MS: "1",
        // A short command timeout so `sleep 999` is killed in-test (no 60s hang).
        PI_WEB_DOD_COMMAND_TIMEOUT_MS: "400",
        // Sessions in the repo so each workstream ring aggregates its criteria.
        PI_WEB_MOCK_EXTRA_SESSIONS: JSON.stringify([{ id: "eval-sess", cwd: repo }, { id: "evict-sess", cwd: repo }]),
      },
    });
    realtime = await openRealtime(server);

    const project = await server.api("POST", "/api/projects", { name: "Verify", roots: [repo] });
    projectId = project.body.project.id;
    const ws = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "ci" });
    wsId = ws.body.workstream.id;

    // Two command criteria (one passing, one failing) + a git_merged (true) so the
    // ring is honest k-of-n once the commands run.
    const dod = await server.api("PUT", `/api/workstreams/${wsId}/dod`, {
      criteria: [
        { text: "tests pass", source: { kind: "command", cwd: repo, cmd: "exit 0" } },
        { text: "lint clean", source: { kind: "command", cwd: repo, cmd: "exit 1" } },
        { text: "merged into main", source: { kind: "git_merged", into: "main" } },
      ],
    });
    for (const c of dod.body.workstream.dod.criteria as any[]) {
      if (c.source.kind === "command") ids[c.source.cmd] = c.id;
      else ids[c.source.kind] = c.id;
    }
    await server.api("PUT", `/api/workstreams/${wsId}/sessions`, { sessionIds: ["eval-sess"] });
  }, 40_000);

  afterAll(async () => {
    realtime?.close();
    await server?.stop();
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("on the render path, command criteria are unrun (never spawned) before evaluate", async () => {
    const ws = await getWs();
    const pass = critOf(ws, "command");
    expect(pass.unrun).toBe(true);
    expect(pass.met).toBe(false);
  });

  it("cmd 'exit 0' → met, cmd 'exit 1' → not met, git_merged inline → met", async () => {
    const res = await server.api("POST", "/api/dod/evaluate", { workstreamId: wsId });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const evals = res.body.evals as any[];
    const byId = new Map(evals.map((e) => [e.id, e]));
    expect(byId.get(ids["exit 0"]).met).toBe(true);
    expect(byId.get(ids["exit 0"]).evidence).toMatch(/exit 0/);
    expect(byId.get(ids["exit 1"]).met).toBe(false);
    expect(byId.get(ids["exit 1"]).evidence).toMatch(/exit 1/);
    expect(byId.get(ids.git_merged).met).toBe(true);
  });

  it("a subsequent /api/rollups reflects the cached fresh command result + exactly one rollup_changed", async () => {
    realtime.clear();
    const res = await server.api("POST", "/api/dod/evaluate", { criterionId: ids["exit 0"] });
    expect(res.status).toBe(200);
    // One coalesced rollup_changed for the owning project within the debounce window.
    await realtime.waitForType("rollup_changed", 1);
    await new Promise((r) => setTimeout(r, 700)); // let any extra envelopes arrive
    expect(realtime.typeCount("rollup_changed")).toBe(1);

    const ws = await getWs();
    const pass = critOf(ws, "command");
    expect(pass.met).toBe(true);
    expect(pass.unrun).toBeUndefined();
    expect(pass.stale).toBeUndefined(); // fresh, not asterisked
  });

  it("cmd cwd outside a registered root → 400, runs nothing", async () => {
    // Author a fresh out-of-tree command (cwd /etc) to prove the allowlist rejects
    // a path that is not under any registered project root or known session cwd.
    const escapeWs = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "escape" });
    const escapeId = escapeWs.body.workstream.id;
    await server.api("PUT", `/api/workstreams/${escapeId}/dod`, {
      criteria: [{ text: "evil", source: { kind: "command", cwd: "/etc", cmd: "echo nope" } }],
    });
    const rejected = await server.api("POST", "/api/dod/evaluate", { workstreamId: escapeId });
    expect(rejected.status).toBe(400);
    expect(rejected.body.ok).toBe(false);
    expect(rejected.body.error).toMatch(/not under a registered/i);
  });

  it("'sleep 999' is killed at the timeout → not met, no hang", async () => {
    const slowWs = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "slow" });
    const slowId = slowWs.body.workstream.id;
    await server.api("PUT", `/api/workstreams/${slowId}/dod`, {
      criteria: [{ text: "slow check", source: { kind: "command", cwd: repo, cmd: "sleep 999" } }],
    });
    const started = Date.now();
    const res = await server.api("POST", "/api/dod/evaluate", { workstreamId: slowId });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    const slow = (res.body.evals as any[])[0];
    expect(slow.met).toBe(false);
    expect(slow.evidence).toMatch(/timed out/i);
    // The 400ms timeout must have fired well before the 999s sleep would finish.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it("replacing a DoD evicts the old command eval — a recreated criterion id is NOT stale", async () => {
    // Regression guard for the unbounded/orphaned commandEvalCache finding: evaluate a
    // passing command (caches its met=true under that criterion id), then REPLACE the
    // workstream DoD (PUT mints NEW criterion ids). A subsequent /api/rollups must show
    // the fresh criterion as `unrun` (the old cached met must not leak onto a new id) and
    // the orphaned cache entry must be gone.
    const evictWs = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "evict" });
    const evictId = evictWs.body.workstream.id;
    await server.api("PUT", `/api/workstreams/${evictId}/sessions`, { sessionIds: ["evict-sess"] });
    const first = await server.api("PUT", `/api/workstreams/${evictId}/dod`, {
      criteria: [{ text: "tests pass", source: { kind: "command", cwd: repo, cmd: "exit 0" } }],
    });
    const firstCritId = (first.body.workstream.dod.criteria as any[])[0].id;
    // Evaluate → caches met=true under firstCritId.
    const ev = await server.api("POST", "/api/dod/evaluate", { criterionId: firstCritId });
    expect((ev.body.evals as any[])[0].met).toBe(true);

    // Replace the DoD (new criterion id) — the old cached eval is now orphaned + evicted.
    const second = await server.api("PUT", `/api/workstreams/${evictId}/dod`, {
      criteria: [{ text: "tests pass", source: { kind: "command", cwd: repo, cmd: "exit 0" } }],
    });
    const secondCritId = (second.body.workstream.dod.criteria as any[])[0].id;
    expect(secondCritId).not.toBe(firstCritId); // normalizer minted a fresh id

    const rollups = await server.api("GET", "/api/rollups");
    const proj = (rollups.body.rollups as any[]).find((r) => r.project.id === projectId);
    const ws = proj.workstreams.find((w: any) => w.workstream.id === evictId);
    const crit = (ws.progress?.criteria || []).find((c: any) => c.sourceKind === "command");
    // The new criterion has never been evaluated → unrun, NOT the stale met=true.
    expect(crit.unrun).toBe(true);
    expect(crit.met).toBe(false);
  }, 20_000);
});

describe("POST /api/dod/evaluate (command DoD, disabled by default)", () => {
  let server: RollupServer;
  let repo: string;
  let projectId: string;
  let wsId: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "rollups-eval-off-"));
    await initRepo(repo);
    await commitFile(repo, "README.md", "base\n", "base");
    // No PI_WEB_ALLOW_DOD_COMMANDS — default off.
    server = await startServer({
      extraEnv: { PI_WEB_MOCK_EXTRA_SESSIONS: JSON.stringify([{ id: "off-sess", cwd: repo }]) },
    });
    const project = await server.api("POST", "/api/projects", { name: "Off", roots: [repo] });
    projectId = project.body.project.id;
    const ws = await server.api("POST", `/api/projects/${projectId}/workstreams`, { name: "ci" });
    wsId = ws.body.workstream.id;
    await server.api("PUT", `/api/workstreams/${wsId}/dod`, {
      criteria: [{ text: "tests pass", source: { kind: "command", cwd: repo, cmd: "exit 0" } }],
    });
    await server.api("PUT", `/api/workstreams/${wsId}/sessions`, { sessionIds: ["off-sess"] });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("with the env unset, evaluate returns unrun (runs nothing) and the ring never reaches allMet", async () => {
    // A command that WOULD pass if it ran ("exit 0"), but the runner is disabled.
    const res = await server.api("POST", "/api/dod/evaluate", { workstreamId: wsId });
    expect(res.status).toBe(200);
    const evaluated = (res.body.evals as any[])[0];
    expect(evaluated.unrun).toBe(true);
    expect(evaluated.met).toBe(false);
    expect(evaluated.evidence).toMatch(/disabled/i);

    // The cache was NOT populated → a subsequent /api/rollups still shows unrun, and
    // the un-run command keeps allMet false (it can never back a 100%).
    const rollups = await server.api("GET", "/api/rollups");
    const project = (rollups.body.rollups as any[]).find((r) => r.project.id === projectId);
    const ws = project.workstreams.find((w: any) => w.workstream.id === wsId);
    const cmd = (ws.progress.criteria as any[]).find((c) => c.sourceKind === "command");
    expect(cmd.unrun).toBe(true);
    expect(ws.progress.allMet).toBe(false);
  });
});
