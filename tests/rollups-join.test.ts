// Pure unit tests for the registry × sessions join (server/rollups/rollup.ts).
//
// Direct import, stub git (no server, no real repos). Pins the mapping +
// aggregation branches the DoD demands: nested-root → OWN project + lineage,
// explicit-sessionIds override, mixed-source → session gauge, counts sum,
// unmatched omitted, messy session never throws.

import { describe, expect, it } from "vitest";

import {
  assembleRollups,
  isCwdUnder,
  isMixed,
  mapSessionsToProjects,
  type AssembleContext,
  type RollupSessionInput,
} from "../server/rollups/rollup.js";
import type {
  CriterionEval,
  DoDCriterion,
  Project,
  ProjectRegistry,
  Workstream,
} from "../server/rollups/types.js";

let n = 0;
function project(over: Partial<Project> & { id: string; roots: string[] }): Project {
  return {
    name: over.name ?? over.id,
    workstreamIds: over.workstreamIds ?? [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function workstream(over: Partial<Workstream> & { id: string; projectId: string }): Workstream {
  return {
    name: over.name ?? over.id,
    status: over.status ?? "planned",
    sessionIds: over.sessionIds ?? [],
    order: over.order ?? 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function manual(text: string, met = false, gate = false): DoDCriterion {
  return { id: `m${++n}`, text, source: { kind: "manual" }, met, ...(gate ? { gate: true } : {}) };
}

function command(text: string): DoDCriterion {
  return { id: `c${++n}`, text, source: { kind: "command", cwd: "/repo", cmd: "exit 0" } };
}

function session(over: Partial<RollupSessionInput> & { id: string }): RollupSessionInput {
  return { messageCount: 1, modified: "2026-06-20T00:00:00.000Z", ...over };
}

const cleanStub: AssembleContext = {
  gitStatusFor: async (cwd) => ({
    ok: true,
    isRepo: true,
    root: cwd,
    branch: "feat/x",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
  }),
  isAncestor: async () => false,
  now: () => new Date("2026-06-22T00:00:00.000Z"),
};

describe("isCwdUnder", () => {
  it("matches a path at or under a parent, not a sibling/prefix-collision", () => {
    expect(isCwdUnder("/outer/inner", "/outer")).toBe(true);
    expect(isCwdUnder("/outer", "/outer")).toBe(true);
    expect(isCwdUnder("/outer-sibling", "/outer")).toBe(false);
    expect(isCwdUnder("/elsewhere", "/outer")).toBe(false);
  });
});

describe("mapSessionsToProjects", () => {
  it("explicit sessionIds override cwd-prefix matching", () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/a"] }), project({ id: "B", roots: ["/b"] })],
      workstreams: [workstream({ id: "wsA", projectId: "A", sessionIds: ["s1"] })],
    };
    // s1's cwd is under project B, but explicit membership in wsA (project A) wins.
    const { assignments } = mapSessionsToProjects(registry, [session({ id: "s1", cwd: "/b/work" })]);
    expect(assignments.get("s1")).toEqual({ projectId: "A", workstreamId: "wsA" });
  });

  it("longest matchCwd prefix wins over project root", () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/a"] })],
      workstreams: [
        workstream({ id: "wide", projectId: "A", matchCwd: "/a" }),
        workstream({ id: "narrow", projectId: "A", matchCwd: "/a/auth" }),
      ],
    };
    const { assignments } = mapSessionsToProjects(registry, [session({ id: "s1", cwd: "/a/auth/x" })]);
    expect(assignments.get("s1")).toEqual({ projectId: "A", workstreamId: "narrow" });
  });

  it("a nested root resolves to its OWN (innermost) project", () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/outer"] }), project({ id: "B", roots: ["/outer/inner"] })],
      workstreams: [],
    };
    const { assignments } = mapSessionsToProjects(registry, [session({ id: "s1", cwd: "/outer/inner/x" })]);
    expect(assignments.get("s1")).toEqual({ projectId: "B" });
  });

  it("an unmatched session lands in the unassigned bucket", () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/a"] })],
      workstreams: [],
    };
    const { assignments, unassigned } = mapSessionsToProjects(registry, [
      session({ id: "lost", cwd: "/elsewhere" }),
      session({ id: "noCwd" }),
    ]);
    expect(assignments.size).toBe(0);
    expect(unassigned.map((s) => s.id)).toEqual(["lost", "noCwd"]);
  });
});

describe("assembleRollups", () => {
  it("nested root → own project + a lineage badge; the outer project excludes it", async () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", name: "Outer", roots: ["/outer"] }), project({ id: "B", name: "Inner", roots: ["/outer/inner"] })],
      workstreams: [],
    };
    const rollups = await assembleRollups(registry, [session({ id: "s1", cwd: "/outer/inner/x" })], cleanStub);
    const A = rollups.find((r) => r.project.id === "A")!;
    const B = rollups.find((r) => r.project.id === "B")!;
    expect(B.lineage?.parentProjectName).toBe("Outer");
    expect(A.lineage).toBeUndefined();
    // The session counts under B (its own project), not A.
    expect(B.workstreams.flatMap((w) => w.sessions).map((s) => s.id)).toEqual(["s1"]);
    expect(A.workstreams.flatMap((w) => w.sessions)).toHaveLength(0);
  });

  it("project counts sum the workstream counts", async () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/a"], workstreamIds: ["w1", "w2"] })],
      workstreams: [
        workstream({ id: "w1", projectId: "A", sessionIds: ["s1"] }),
        workstream({ id: "w2", projectId: "A", sessionIds: ["s2"] }),
      ],
    };
    const rollups = await assembleRollups(
      registry,
      [
        session({ id: "s1", cwd: "/a", runtime: { isRunning: true, isStreaming: true } }),
        session({ id: "s2", cwd: "/a" }),
      ],
      cleanStub,
    );
    const A = rollups[0];
    const summed = A.workstreams.reduce(
      (acc, w) => {
        for (const k of Object.keys(acc) as Array<keyof typeof acc>) acc[k] += w.counts[k];
        return acc;
      },
      { planned: 0, in_progress: 0, blocked: 0, done: 0, abandoned: 0 },
    );
    expect(A.counts).toEqual(summed);
    expect(A.counts.in_progress).toBe(1); // s1 is running
    expect(A.activeSessionCount).toBe(1);
  });

  it("a mixed-source workstream DoD → progress null + a session gauge", async () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/a"], workstreamIds: ["w1"] })],
      workstreams: [
        workstream({
          id: "w1",
          projectId: "A",
          sessionIds: ["s1"],
          dod: { criteria: [manual("reviewed"), command("tests pass")] },
        }),
      ],
    };
    const rollups = await assembleRollups(registry, [session({ id: "s1", cwd: "/a" })], cleanStub);
    const ws = rollups[0].workstreams.find((w) => w.workstream.id === "w1")!;
    expect(ws.mixed).toBe(true);
    expect(ws.progress).toBeNull();
    expect(ws.sessionGauge).toMatchObject({ total: 1 });
  });

  it("a homogeneous git workstream DoD → an honest k-of-n ring (clean tree = 100%)", async () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/a"], workstreamIds: ["w1"] })],
      workstreams: [
        workstream({
          id: "w1",
          projectId: "A",
          dod: { criteria: [{ id: "g", text: "in sync", source: { kind: "git_ahead_zero" } }] },
        }),
      ],
    };
    const rollups = await assembleRollups(registry, [], cleanStub);
    const ws = rollups[0].workstreams.find((w) => w.workstream.id === "w1")!;
    expect(ws.mixed).toBeFalsy();
    expect(ws.progress?.percent).toBe(100); // ahead 0 + upstream tracked
    expect(ws.progress?.allMet).toBe(true);
  });

  it("unmatched sessions are omitted from the rollup feed", async () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/a"] })],
      workstreams: [],
    };
    const rollups = await assembleRollups(registry, [session({ id: "lost", cwd: "/elsewhere" })], cleanStub);
    const allSessionIds = rollups.flatMap((r) => r.workstreams.flatMap((w) => w.sessions.map((s) => s.id)));
    expect(allSessionIds).not.toContain("lost");
  });

  it("an archived project is skipped", async () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/a"], archived: true })],
      workstreams: [],
    };
    expect(await assembleRollups(registry, [], cleanStub)).toHaveLength(0);
  });

  it("a git_merged whose `into` ref is missing degrades to not-met — the feed never 500s", async () => {
    // gitIsAncestor RETHROWS on a non-1 exit (exit 128 when `into` does not
    // resolve). The render path must degrade, not propagate, or the WHOLE
    // multi-project feed returns 500 (S3: never throw on a messy session).
    const throwingStub: AssembleContext = {
      ...cleanStub,
      isAncestor: async () => {
        throw Object.assign(new Error("fatal: bad revision 'main'"), { code: 128 });
      },
    };
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/a"], workstreamIds: ["w1"] })],
      workstreams: [
        workstream({
          id: "w1",
          projectId: "A",
          dod: { criteria: [{ id: "g", text: "merged", source: { kind: "git_merged", into: "main" } }] },
        }),
      ],
    };
    const rollups = await assembleRollups(registry, [], throwingStub);
    const ws = rollups[0].workstreams.find((w) => w.workstream.id === "w1")!;
    const merged = ws.progress?.criteria.find((c) => c.sourceKind === "git_merged")!;
    expect(merged.met).toBe(false);
    expect(merged.evidence).toMatch(/could not verify|unavailable/i);
  });

  it("never throws on a messy session — every optional field defaults", async () => {
    const registry: ProjectRegistry = {
      version: 1,
      projects: [project({ id: "A", roots: ["/a"], workstreamIds: ["w1"] })],
      workstreams: [workstream({ id: "w1", projectId: "A", sessionIds: ["messy"] })],
    };
    const messy = { id: "messy" } as RollupSessionInput; // no cwd, no runtime, no modified
    const rollups = await assembleRollups(registry, [messy], cleanStub);
    const s = rollups[0].workstreams.flatMap((w) => w.sessions).find((x) => x.id === "messy")!;
    expect(s.runtime.isRunning).toBe(false);
    expect(s.messageCount).toBe(0);
    expect(s.modified).toBe("");
  });
});

describe("isMixed", () => {
  it("spans >1 evaluator family (excluding gates)", () => {
    const evals: CriterionEval[] = [
      { id: "1", met: true, evaluatedAt: "x", sourceKind: "manual" },
      { id: "2", met: true, evaluatedAt: "x", sourceKind: "git_clean" },
    ];
    expect(isMixed(evals)).toBe(true);
    expect(isMixed([{ id: "1", met: true, evaluatedAt: "x", sourceKind: "git_merged" }, { id: "2", met: true, evaluatedAt: "x", sourceKind: "git_clean" }])).toBe(false);
  });
});
