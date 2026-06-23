// S11 — Loop "proposed" band + merge affordance (degraded-but-honest).
//
// Pure unit tests, no server, no DOM. They pin the three S11 invariants:
//   1. Loop elapsed is derived STRICTLY from the stored `loopStartedAt` ISO timestamp
//      (`elapsedMinFromLoopStart`), never from `runtime.startedAt` — so a loop's elapsed
//      SURVIVES the 60s idle dispose that resets runtime timestamps. `loopMinutes`/`fmtMin`
//      are the pure formatting formula the renderer + hero share.
//   2. The adapter pushes the WORKSTREAM-level loop (the registry's source of truth) down to
//      each of its sessions, so the per-row "∞ looping {elapsed}" badge + proposed band render;
//      and it NEVER surfaces a fabricated "iter N" / over-budget alarm from the server's
//      placeholder `iter:0`/`sparks:[]` — that telemetry stays in the muted "proposed" band only.
//   3. The merge affordance gates on a REAL git branch (`artifact.branch`, non-doc) — else
//      "Archive"; sign-off is never fused with merge.

import { describe, expect, it } from "vitest";

import { fmtMin, loopMinutes } from "../src/dashboard/render.js";
import { elapsedMinFromLoopStart, toViewModel } from "../src/dashboard/rollupAdapter.js";
import type {
  ProjectRollup,
  SessionRollup,
  WorkstreamRollup,
} from "../src/dashboard/types.js";

// ---- builders ----------------------------------------------------------------

function session(over: Partial<SessionRollup> & { id: string }): SessionRollup {
  return {
    modified: "2026-06-20T00:00:00.000Z",
    messageCount: 1,
    runtime: { loaded: false, isRunning: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
    status: "in_progress",
    uiStatus: "run",
    ...over,
  } as SessionRollup;
}

function workstream(over: Partial<WorkstreamRollup> & { sessions: SessionRollup[] }): WorkstreamRollup {
  return {
    workstream: {
      id: "w1", projectId: "p1", name: "Nightly loop", status: "in_progress",
      sessionIds: [], order: 0, createdAt: "", updatedAt: "",
    },
    progress: null,
    counts: { planned: 0, in_progress: 1, blocked: 0, done: 0, abandoned: 0 },
    ...over,
  } as WorkstreamRollup;
}

function project(workstreams: WorkstreamRollup[]): ProjectRollup {
  return {
    project: { id: "p1", name: "Proj", roots: ["/tmp/p"], workstreamIds: ["w1"], createdAt: "", updatedAt: "" },
    workstreams,
    progress: { met: 0, total: 0, metWeight: 0, totalWeight: 0, percent: 0, allMet: false, unrun: 0, stale: 0, derivedStatus: "in_progress", criteria: [] },
    counts: { planned: 0, in_progress: 1, blocked: 0, done: 0, abandoned: 0 },
    activeSessionCount: 1,
  };
}

// ---- 1. pure loop elapsed formula -------------------------------------------

describe("loopMinutes / fmtMin (pure)", () => {
  it("loopMinutes reads the pre-derived elapsedMin (from loopStartedAt), 0 when un-grounded", () => {
    expect(loopMinutes({ elapsedMin: 38 })).toBe(38);
    expect(loopMinutes({ elapsedMin: 0 })).toBe(0);
    expect(loopMinutes({})).toBe(0); // un-grounded loop → 0, never a parsed/inferred value
  });

  it("fmtMin formats minutes/hours/days with rollover", () => {
    expect(fmtMin(5)).toBe("5m");
    expect(fmtMin(59)).toBe("59m");
    expect(fmtMin(60)).toBe("1h");
    expect(fmtMin(95)).toBe("1h 35m");
    expect(fmtMin(1440)).toBe("1d");
    expect(fmtMin(1440 + 120)).toBe("1d 2h"); // multi-day reads "1d 2h", not "26h"
  });
});

describe("elapsedMinFromLoopStart — grounded in loopStartedAt, NOT runtime", () => {
  it("computes elapsed from the stored loopStartedAt timestamp", () => {
    const now = Date.parse("2026-06-22T13:00:00.000Z");
    const startedAt = "2026-06-22T12:22:00.000Z"; // 38 min earlier
    expect(elapsedMinFromLoopStart(startedAt, now)).toBe(38);
  });

  it("returns undefined (no fabricated duration) for missing/garbage timestamps", () => {
    expect(elapsedMinFromLoopStart(undefined)).toBeUndefined();
    expect(elapsedMinFromLoopStart("")).toBeUndefined();
    expect(elapsedMinFromLoopStart("not-a-date")).toBeUndefined();
  });

  it("clamps to >= 0 for a future timestamp", () => {
    const now = Date.parse("2026-06-22T12:00:00.000Z");
    expect(elapsedMinFromLoopStart("2026-06-22T12:30:00.000Z", now)).toBe(0);
  });
});

// ---- 2. adapter propagates the workstream loop to sessions ------------------

describe("rollupAdapter loop propagation (S11)", () => {
  const startedAt = new Date(Date.now() - 38 * 60_000).toISOString();

  it("a loop workstream pushes its loop badge + elapsed (from loopStartedAt) down to each session", () => {
    const wr = workstream({
      workstream: { id: "w1", projectId: "p1", name: "Nightly loop", status: "in_progress", sessionIds: [], order: 0, createdAt: "", updatedAt: "", isLoop: true, loopStartedAt: startedAt },
      loop: { iter: 0, sparks: [], startedAt },
      sessions: [session({ id: "s-loop", uiStatus: "loop", status: "in_progress" })],
    });
    const { SESS } = toViewModel([project([wr])]);
    const s = SESS["s-loop"].s;
    expect(s.loop).toBe(true);
    // elapsed is grounded in loopStartedAt (~38m), within a minute of wall-clock.
    expect(s.elapsedMin).toBeGreaterThanOrEqual(37);
    expect(s.elapsedMin).toBeLessThanOrEqual(39);
  });

  it("elapsed SURVIVES a 60s dispose: runtime.startedAt is unset/reset but loopStartedAt drives elapsed", () => {
    const wr = workstream({
      workstream: { id: "w1", projectId: "p1", name: "loop", status: "in_progress", sessionIds: [], order: 0, createdAt: "", updatedAt: "", isLoop: true, loopStartedAt: startedAt },
      loop: { iter: 0, sparks: [], startedAt },
      // The live session was disposed: runtime is unloaded, startedAt gone — exactly the
      // 60s-dispose state that makes a runtime-derived elapsed read as "just started".
      sessions: [session({ id: "s-disposed", uiStatus: "loop", runtime: { loaded: false, isRunning: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0 } })],
    });
    const { SESS } = toViewModel([project([wr])]);
    const s = SESS["s-disposed"].s;
    expect(s.loop).toBe(true);
    expect(s.elapsedMin).toBeGreaterThanOrEqual(37); // still ~38m, NOT 0 — grounded in loopStartedAt
  });

  it("never asserts a fabricated 'iter N' from the server placeholder iter:0 / empty sparks", () => {
    const wr = workstream({
      workstream: { id: "w1", projectId: "p1", name: "loop", status: "in_progress", sessionIds: [], order: 0, createdAt: "", updatedAt: "", isLoop: true, loopStartedAt: startedAt },
      loop: { iter: 0, sparks: [], startedAt }, // server placeholder — no durable iteration log
      sessions: [session({ id: "s", uiStatus: "loop" })],
    });
    const s = toViewModel([project([wr])]).SESS["s"].s;
    expect(s.iter).toBeUndefined();      // not 0 → proposed band shows "…not live yet", not "iter 0"
    expect(s.iterspark).toBeUndefined();
  });

  it("surfaces iter/sparks ONLY when a real positive iteration / rhythm is present (future durable log)", () => {
    const wr = workstream({
      workstream: { id: "w1", projectId: "p1", name: "loop", status: "in_progress", sessionIds: [], order: 0, createdAt: "", updatedAt: "", isLoop: true, loopStartedAt: startedAt },
      loop: { iter: 7, sparks: [3, 5, 2], startedAt },
      sessions: [session({ id: "s", uiStatus: "loop" })],
    });
    const s = toViewModel([project([wr])]).SESS["s"].s;
    expect(s.iter).toBe(7);
    expect(s.iterspark).toEqual([3, 5, 2]);
  });

  it("a non-loop workstream's sessions carry no loop badge / elapsed", () => {
    const wr = workstream({ sessions: [session({ id: "s-plain", uiStatus: "run" })] });
    const s = toViewModel([project([wr])]).SESS["s-plain"].s;
    expect(s.loop).toBe(false);
    expect(s.elapsedMin).toBeUndefined();
  });
});

// ---- 3. merge affordance gates on a REAL branch -----------------------------

describe("merge affordance gating (S11) — surfaced via the session artifact", () => {
  it("a sign-off session WITH a real git branch carries the branch the merge prompt targets", () => {
    const wr = workstream({
      sessions: [session({
        id: "s-merge", uiStatus: "sign", status: "done",
        artifact: { kind: "diff", branch: "feat/x", sha: "abc123", add: 10, del: 2 },
      })],
    });
    const s = toViewModel([project([wr])]).SESS["s-merge"].s;
    // hasGitBranch(s) in render.ts is true ⇒ "Ask pi to merge feat/x → main"; else "Archive".
    expect(!!(s.artifact && s.artifact.branch && s.artifact.kind !== "doc")).toBe(true);
    expect(s.artifact?.branch).toBe("feat/x");
  });

  it("a doc-artifact session has NO branch ⇒ renders 'Archive', never a merge prompt", () => {
    const wr = workstream({
      sessions: [session({
        id: "s-doc", uiStatus: "sign", status: "done",
        artifact: { kind: "doc", note: "design notes", files: 3 },
      })],
    });
    const s = toViewModel([project([wr])]).SESS["s-doc"].s;
    expect(!!(s.artifact && s.artifact.branch && s.artifact.kind !== "doc")).toBe(false);
  });
});
