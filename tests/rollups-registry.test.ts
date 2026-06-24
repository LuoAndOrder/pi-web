import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyProjectRegistryPatch,
  createProjectRegistryStore,
  defaultProjectRegistry,
  normalizeProjectRegistry,
  RegistryError,
} from "../server/rollups/registry.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rollups-registry-"));
  file = join(dir, "pi-web-projects.json");
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("read fallback", () => {
  it("returns the default registry when the file is missing", async () => {
    const store = createProjectRegistryStore(file);
    const registry = await store.read();
    expect(registry).toEqual({ version: 1, projects: [], workstreams: [] });
    expect(registry).toEqual(defaultProjectRegistry);
  });

  it("falls back to default without throwing on malformed disk JSON", async () => {
    await writeFile(file, "{ this is not json", "utf-8");
    const store = createProjectRegistryStore(file);
    const registry = await store.read();
    expect(registry).toEqual(defaultProjectRegistry);
  });
});

describe("normalization", () => {
  it("dedupes projects/workstreams by id and drops garbage entries", () => {
    const registry = normalizeProjectRegistry({
      version: 99,
      projects: [
        { id: "p1", name: "First", roots: ["/tmp/a", "/tmp/a"] },
        { id: "p1", name: "Duplicate (dropped)", roots: [] },
        "garbage",
        null,
        42,
      ],
      workstreams: [
        { id: "w1", projectId: "p1", name: "ws", order: 0 },
        { id: "w1", projectId: "p1", name: "dup", order: 1 },
        { id: "w-orphan", projectId: "nope", name: "orphan" },
      ],
    });
    expect(registry.version).toBe(1);
    expect(registry.projects).toHaveLength(1);
    expect(registry.projects[0].name).toBe("First");
    // resolve() + de-dup leaves a single absolute root
    expect(registry.projects[0].roots).toEqual([join("/tmp/a")]);
    expect(registry.workstreams.map((w) => w.id)).toEqual(["w1"]);
  });

  it("prunes workstreams whose projectId has no matching project and re-derives workstreamIds", () => {
    const registry = normalizeProjectRegistry({
      projects: [{ id: "p1", name: "P", roots: [] }],
      workstreams: [
        { id: "w2", projectId: "p1", name: "second", order: 2 },
        { id: "w1", projectId: "p1", name: "first", order: 1 },
        { id: "w-orphan", projectId: "ghost", name: "orphan" },
      ],
    });
    expect(registry.workstreams.map((w) => w.id).sort()).toEqual(["w1", "w2"]);
    // re-derived order honors the stored `order` field
    expect(registry.projects[0].workstreamIds).toEqual(["w1", "w2"]);
  });

  it("drops a DoD authored on a PROJECT (projects have NO Definition of Done)", () => {
    const registry = normalizeProjectRegistry({
      projects: [
        {
          id: "p1",
          name: "P",
          roots: [],
          // A project-level dod must never survive — the DoD lives on workstreams only.
          dod: { criteria: [{ id: "m1", text: "x", source: { kind: "manual" }, met: true }] },
        },
      ],
      workstreams: [],
    });
    expect((registry.projects[0] as { dod?: unknown }).dod).toBeUndefined();
  });

  it("keeps a manual `met` boolean but never persists a computed met for git/command sources (workstream DoD)", () => {
    const registry = normalizeProjectRegistry({
      projects: [{ id: "p1", name: "P", roots: [] }],
      workstreams: [
        {
          id: "w1",
          projectId: "p1",
          name: "ws",
          order: 0,
          dod: {
            criteria: [
              { id: "m1", text: "approved", source: { kind: "manual" }, met: true },
              { id: "g1", text: "clean", source: { kind: "git_clean" }, met: true },
              { id: "c1", text: "tests", source: { kind: "command", cwd: "/tmp", cmd: "true" }, met: true },
            ],
          },
        },
      ],
    });
    const criteria = registry.workstreams[0].dod!.criteria;
    expect(criteria.find((c) => c.id === "m1")!.met).toBe(true);
    expect(criteria.find((c) => c.id === "g1")!.met).toBeUndefined();
    expect(criteria.find((c) => c.id === "c1")!.met).toBeUndefined();
  });

  it("drops criteria with an invalid/incomplete source (workstream DoD)", () => {
    const registry = normalizeProjectRegistry({
      projects: [{ id: "p1", name: "P", roots: [] }],
      workstreams: [
        {
          id: "w1",
          projectId: "p1",
          name: "ws",
          order: 0,
          dod: {
            criteria: [
              { id: "ok", text: "ok", source: { kind: "manual" } },
              { id: "bad-kind", text: "x", source: { kind: "made_up" } },
              { id: "merged-no-into", text: "x", source: { kind: "git_merged" } },
              { id: "cmd-no-cmd", text: "x", source: { kind: "command", cwd: "/tmp" } },
              { id: "no-source", text: "x" },
            ],
          },
        },
      ],
    });
    expect(registry.workstreams[0].dod!.criteria.map((c) => c.id)).toEqual(["ok"]);
  });

  it("clamps a negative weight to 0 and defaults a missing weight to 1 (workstream DoD)", () => {
    const registry = normalizeProjectRegistry({
      projects: [{ id: "p1", name: "P", roots: [] }],
      workstreams: [
        {
          id: "w1",
          projectId: "p1",
          name: "ws",
          order: 0,
          dod: {
            criteria: [
              { id: "a", text: "a", source: { kind: "manual" }, weight: -5 },
              { id: "b", text: "b", source: { kind: "manual" } },
              { id: "c", text: "c", source: { kind: "manual" }, weight: 3 },
            ],
          },
        },
      ],
    });
    const byId = Object.fromEntries(registry.workstreams[0].dod!.criteria.map((c) => [c.id, c.weight]));
    expect(byId).toEqual({ a: 0, b: 1, c: 3 });
  });
});

describe("patch", () => {
  it("normalizes and dedupes through a patch round-trip", async () => {
    const store = createProjectRegistryStore(file);
    const registry = await store.patch({
      projects: [
        { id: "p1", name: "One", roots: ["/tmp/x"] },
        { id: "p1", name: "dup", roots: [] },
        "junk",
      ],
      workstreams: [{ id: "w1", projectId: "missing", name: "orphan" }],
    });
    expect(registry.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(registry.workstreams).toHaveLength(0); // orphan pruned
  });

  it("applyProjectRegistryPatch leaves current untouched when patch is not a record", () => {
    const current = normalizeProjectRegistry({ projects: [{ id: "p1", name: "P", roots: [] }] });
    expect(applyProjectRegistryPatch(current, null)).toEqual(current);
    expect(applyProjectRegistryPatch(current, "nope")).toEqual(current);
  });
});

describe("atomic + serialized writes", () => {
  it("leaves no .tmp file behind after a write", async () => {
    const store = createProjectRegistryStore(file);
    await store.createProject({ name: "P", roots: [dir] });
    const entries = await readdir(dir);
    expect(entries).toEqual(["pi-web-projects.json"]);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("survives 50 concurrent patches with valid JSON and a coherent final read", async () => {
    const store = createProjectRegistryStore(file);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.patch({ projects: [{ id: `p${i}`, name: `P${i}`, roots: [] }] }),
      ),
    );
    // Each patch replaced the projects array, so the last write wins; the file
    // must still parse and the in-memory read must match.
    const raw = await readFile(file, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const onDisk = JSON.parse(raw);
    expect(onDisk.version).toBe(1);
    expect(Array.isArray(onDisk.projects)).toBe(true);
    const registry = await store.read();
    expect(registry).toEqual(normalizeProjectRegistry(onDisk));
    // no torn temp files
    expect((await readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

describe("domain mutators", () => {
  it("creates a project with resolved roots and a generated id", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: ["./rel", dir] });
    expect(project.id).toBeTruthy();
    expect(project.name).toBe("Alpha");
    expect(project.roots).toContain(join(process.cwd(), "rel"));
    expect(project.roots).toContain(dir);
    expect(project.createdAt).toBe(project.updatedAt);
  });

  it("updates a project and returns undefined for an unknown id", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const updated = await store.updateProject(project.id, { name: "Renamed", archived: true });
    expect(updated?.project.name).toBe("Renamed");
    expect(updated?.project.archived).toBe(true);
    expect(updated?.project.updatedAt >= project.updatedAt).toBe(true);
    expect(await store.updateProject("ghost", { name: "x" })).toBeUndefined();
  });

  it("ignores a `dod` in an updateProject patch — projects have no Definition of Done", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const updated = await store.updateProject(project.id, {
      dod: { criteria: [{ id: "m1", text: "x", source: { kind: "manual" }, met: true }] },
    });
    expect((updated?.project as { dod?: unknown }).dod).toBeUndefined();
  });

  it("deletes a project and drops its workstreams", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    await store.createWorkstream(project.id, { name: "auth" });
    let registry = await store.read();
    expect(registry.workstreams).toHaveLength(1);

    const result = await store.deleteProject(project.id);
    expect(result).toBeDefined();
    registry = result!.registry;
    expect(registry.projects).toHaveLength(0);
    expect(registry.workstreams).toHaveLength(0);
    expect(await store.deleteProject("ghost")).toBeUndefined();
  });

  it("deletes a workstream, dereferences its id from the project, and 404s an unknown id", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const a = (await store.createWorkstream(project.id, { name: "auth" }))!.workstream;
    const b = (await store.createWorkstream(project.id, { name: "billing" }))!.workstream;

    let registry = await store.read();
    expect(registry.projects[0].workstreamIds).toEqual([a.id, b.id]);

    const result = await store.deleteWorkstream(a.id);
    expect(result).toBeDefined();
    expect(result!.projectId).toBe(project.id);
    registry = result!.registry;
    // The workstream is gone AND its id is dereferenced from the project.
    expect(registry.workstreams.map((w) => w.id)).toEqual([b.id]);
    expect(registry.projects[0].workstreamIds).toEqual([b.id]);

    // Unknown id → undefined (route maps to 404), registry untouched.
    const before = await store.read();
    expect(await store.deleteWorkstream("ghost")).toBeUndefined();
    expect(await store.read()).toEqual(before);
  });

  it("archives a workstream via update, keeps it retrievable, and clears the flag", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const ws = (await store.createWorkstream(project.id, { name: "auth" }))!.workstream;
    expect(ws.archived).toBeUndefined();

    const archived = (await store.updateWorkstream(ws.id, { archived: true }))!.workstream;
    expect(archived.archived).toBe(true);

    // Still in the registry (retrievable) after a fresh open from disk.
    const reopened = createProjectRegistryStore(file);
    const persisted = (await reopened.read()).workstreams.find((w) => w.id === ws.id);
    expect(persisted?.archived).toBe(true);

    // Clearing the flag drops it (never persisted as archived:false).
    const cleared = (await store.updateWorkstream(ws.id, { archived: false }))!.workstream;
    expect(cleared.archived).toBeUndefined();
  });

  it("round-trips a status transition to done / abandoned via update", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const ws = (await store.createWorkstream(project.id, { name: "auth" }))!.workstream;
    expect(ws.status).toBe("planned");

    expect((await store.updateWorkstream(ws.id, { status: "done" }))!.workstream.status).toBe("done");
    expect((await store.updateWorkstream(ws.id, { status: "abandoned" }))!.workstream.status).toBe("abandoned");

    const persisted = (await createProjectRegistryStore(file).read()).workstreams[0];
    expect(persisted.status).toBe("abandoned");
  });

  it("creates workstreams, links them to the project, and assigns sequential order", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const a = await store.createWorkstream(project.id, { name: "auth" });
    const b = await store.createWorkstream(project.id, { name: "billing" });
    expect(a?.workstream.order).toBe(0);
    expect(b?.workstream.order).toBe(1);
    const registry = await store.read();
    expect(registry.projects[0].workstreamIds).toEqual([a!.workstream.id, b!.workstream.id]);
    expect(await store.createWorkstream("ghost", { name: "x" })).toBeUndefined();
  });

  it("stamps loopStartedAt when a workstream is created as a loop (so S11 elapsed has its field)", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });

    // A loop created with no explicit start → loopStartedAt defaulted to now().
    const loop = (await store.createWorkstream(project.id, { name: "nightly", isLoop: true }))!.workstream;
    expect(loop.isLoop).toBe(true);
    expect(typeof loop.loopStartedAt).toBe("string");
    expect(Number.isNaN(Date.parse(loop.loopStartedAt!))).toBe(false);

    // A non-loop workstream gets no stamp.
    const plain = (await store.createWorkstream(project.id, { name: "auth" }))!.workstream;
    expect(plain.loopStartedAt).toBeUndefined();

    // An explicit loopStartedAt is honored, not overwritten.
    const explicit = (await store.createWorkstream(project.id, { name: "explicit", isLoop: true, loopStartedAt: "2020-01-01T00:00:00.000Z" }))!.workstream;
    expect(explicit.loopStartedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("stamps loopStartedAt when isLoop flips true via update, and drops it when isLoop is cleared", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const ws = (await store.createWorkstream(project.id, { name: "auth" }))!.workstream;
    expect(ws.loopStartedAt).toBeUndefined();

    // isLoop flips true with no explicit start → stamped now().
    const looped = (await store.updateWorkstream(ws.id, { isLoop: true }))!.workstream;
    expect(looped.isLoop).toBe(true);
    expect(typeof looped.loopStartedAt).toBe("string");
    expect(Number.isNaN(Date.parse(looped.loopStartedAt!))).toBe(false);

    // An unrelated update keeps the existing stamp (not re-stamped).
    const renamed = (await store.updateWorkstream(ws.id, { name: "auth2" }))!.workstream;
    expect(renamed.loopStartedAt).toBe(looped.loopStartedAt);

    // Clearing isLoop drops the stamp.
    const cleared = (await store.updateWorkstream(ws.id, { isLoop: false }))!.workstream;
    expect(cleared.isLoop).toBeUndefined();
    expect(cleared.loopStartedAt).toBeUndefined();
  });

  it("attaches sessions and sets a workstream DoD (stripping non-manual met)", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const ws = (await store.createWorkstream(project.id, { name: "auth" }))!.workstream;

    const attached = await store.setWorkstreamSessions(ws.id, ["s1", "s2", "s2", " "]);
    expect(attached && "workstream" in attached && attached.workstream.sessionIds).toEqual(["s1", "s2"]);

    const withDod = await store.setWorkstreamDoD(ws.id, [
      { id: "m1", text: "approved", source: { kind: "manual" }, gate: true },
      { id: "g1", text: "merged", source: { kind: "git_merged", into: "main" }, met: true },
    ]);
    const criteria = withDod!.workstream.dod!.criteria;
    expect(criteria.find((c) => c.id === "m1")!.met).toBe(false);
    expect(criteria.find((c) => c.id === "g1")!.met).toBeUndefined();
    expect(await store.setWorkstreamSessions("ghost", [])).toBeUndefined();
  });

  it("refuses to attach sessions to an archived or abandoned workstream (no silent data-visibility loss)", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const archived = (await store.createWorkstream(project.id, { name: "old" }))!.workstream;
    const cancelled = (await store.createWorkstream(project.id, { name: "dead" }))!.workstream;
    await store.updateWorkstream(archived.id, { archived: true });
    await store.updateWorkstream(cancelled.id, { status: "abandoned" });

    const a = await store.setWorkstreamSessions(archived.id, ["s1"]);
    const b = await store.setWorkstreamSessions(cancelled.id, ["s2"]);
    expect(a).toEqual({ inactive: true });
    expect(b).toEqual({ inactive: true });

    // The membership must be untouched (still empty) — the guard short-circuits before any write.
    const reg = await store.read();
    expect(reg.workstreams.find((w) => w.id === archived.id)!.sessionIds).toEqual([]);
    expect(reg.workstreams.find((w) => w.id === cancelled.id)!.sessionIds).toEqual([]);
  });

  it("toggles a manual criterion and persists across a fresh store instance", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const ws = (await store.createWorkstream(project.id, { name: "auth" }))!.workstream;
    await store.setWorkstreamDoD(ws.id, [
      { id: "m1", text: "approved", source: { kind: "manual" } },
    ]);

    const toggled = await store.toggleManualCriterion("m1", true);
    expect(toggled.criterion.met).toBe(true);

    // Re-open from disk: the manual boolean survives the round-trip.
    const reopened = createProjectRegistryStore(file);
    const registry = await reopened.read();
    const persisted = registry.workstreams[0].dod!.criteria.find((c) => c.id === "m1");
    expect(persisted!.met).toBe(true);
  });

  it("rejects toggling a non-manual criterion and leaves the registry unchanged", async () => {
    const store = createProjectRegistryStore(file);
    const { project } = await store.createProject({ name: "Alpha", roots: [dir] });
    const ws = (await store.createWorkstream(project.id, { name: "auth" }))!.workstream;
    await store.setWorkstreamDoD(ws.id, [
      { id: "g1", text: "merged", source: { kind: "git_merged", into: "main" } },
    ]);
    const before = await store.read();

    await expect(store.toggleManualCriterion("g1", true)).rejects.toBeInstanceOf(RegistryError);
    await expect(store.toggleManualCriterion("g1", true)).rejects.toMatchObject({ code: "not_manual" });
    await expect(store.toggleManualCriterion("missing", true)).rejects.toMatchObject({ code: "not_found" });

    const after = await store.read();
    expect(after).toEqual(before);
  });
});
