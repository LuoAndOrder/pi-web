// Pure unit tests for status derivation (server/rollups/status.ts).
//
// Direct import, no server. Pins the §5.3 status table + the block-honesty rules
// (a non-elicited stop is NEVER a hard need; fail/elicited-block are).

import { describe, expect, it } from "vitest";

import {
  deriveStatus,
  deriveUiStatus,
  isHardNeed,
  isSoftWait,
  signPending,
  toWorkItemStatus,
} from "../server/rollups/status.js";
import type { ProgressSnapshot, SessionGitInfo, SessionRuntime } from "../server/rollups/types.js";

function runtime(over: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    loaded: true,
    isRunning: false,
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    ...over,
  };
}

function git(over: Partial<SessionGitInfo> = {}): SessionGitInfo {
  return { branch: "main", ahead: 0, behind: 0, dirtyCount: 0, blocked: false, ...over };
}

const allMet: ProgressSnapshot = {
  met: 1,
  total: 1,
  metWeight: 1,
  totalWeight: 1,
  percent: 100,
  allMet: true,
  unrun: 0,
  stale: 0,
  derivedStatus: "done",
  criteria: [],
};

const partial: ProgressSnapshot = { ...allMet, met: 0, metWeight: 0, percent: 0, allMet: false, derivedStatus: "in_progress" };

describe("deriveUiStatus (§5.3 table)", () => {
  it("a running session → run (in_progress)", () => {
    const ui = deriveUiStatus({ runtime: runtime({ isRunning: true, isStreaming: true }), hasDoD: true });
    expect(ui).toBe("run");
    expect(toWorkItemStatus(ui)).toBe("in_progress");
  });

  it("a running loop → loop", () => {
    expect(deriveUiStatus({ runtime: runtime({ isRunning: true }), isLoop: true })).toBe("loop");
  });

  it("git conflicted → block (running is outranked by a real blocker)", () => {
    const ui = deriveUiStatus({ runtime: runtime({ isRunning: true }), git: git({ blocked: true }) });
    expect(ui).toBe("block");
    expect(toWorkItemStatus(ui)).toBe("blocked");
  });

  it("a structured elicitation → block", () => {
    expect(deriveUiStatus({ runtime: runtime(), elicitation: true })).toBe("block");
  });

  it("a tool error / abnormal end → fail (outranks everything)", () => {
    const ui = deriveUiStatus({ runtime: runtime({ isRunning: true }), git: git({ blocked: true }), fail: true });
    expect(ui).toBe("fail");
    expect(toWorkItemStatus(ui)).toBe("blocked");
  });

  it("evaluable 100% + pending gate → sign (done)", () => {
    const ui = deriveUiStatus({ runtime: runtime(), progress: allMet, pendingGate: true, hasDoD: true });
    expect(ui).toBe("sign");
    expect(toWorkItemStatus(ui)).toBe("done");
  });

  it("evaluable 100% + no gate → merge (done)", () => {
    const ui = deriveUiStatus({ runtime: runtime(), progress: allMet, pendingGate: false, hasDoD: true });
    expect(ui).toBe("merge");
    expect(toWorkItemStatus(ui)).toBe("done");
  });

  it("no DoD at all → unset (needs setup)", () => {
    const ui = deriveUiStatus({ runtime: runtime(), hasDoD: false });
    expect(ui).toBe("unset");
    expect(toWorkItemStatus(ui)).toBe("planned");
  });

  it("partial progress, idle → queued; zero progress → planned", () => {
    expect(deriveUiStatus({ runtime: runtime(), progress: { ...partial, metWeight: 1 }, hasDoD: true })).toBe("queued");
    expect(deriveUiStatus({ runtime: runtime(), progress: partial, hasDoD: true })).toBe("planned");
  });

  it("a non-elicited idle stop → block render-state but a SOFT wait, never a hard need", () => {
    const ui = deriveUiStatus({ runtime: runtime(), softWait: true, hasDoD: true });
    expect(ui).toBe("block");
    expect(isSoftWait(ui, false)).toBe(true);
    expect(isHardNeed(ui, false)).toBe(false);
  });
});

describe("need vs soft-wait split (block honesty)", () => {
  it("fail is always a hard need", () => {
    expect(isHardNeed("fail")).toBe(true);
    expect(isSoftWait("fail")).toBe(false);
  });

  it("an elicited block is a hard need; a non-elicited block is a soft wait", () => {
    expect(isHardNeed("block", true)).toBe(true);
    expect(isSoftWait("block", true)).toBe(false);
    expect(isHardNeed("block", false)).toBe(false);
    expect(isSoftWait("block", false)).toBe(true);
  });

  it("a git-conflict block is a hard need, not a soft wait (§5.3 hard blocker)", () => {
    // git conflict + no elicitation: still a real obligation, must enter Needs-you.
    expect(isHardNeed("block", false, true)).toBe(true);
    expect(isSoftWait("block", false, true)).toBe(false);
    // an elicited git-conflict block is likewise a hard need.
    expect(isHardNeed("block", true, true)).toBe(true);
    expect(isSoftWait("block", true, true)).toBe(false);
  });
});

describe("deriveStatus + signPending", () => {
  it("deriveStatus collapses straight to the 5-value canonical", () => {
    expect(deriveStatus({ runtime: runtime({ isRunning: true }) })).toBe("in_progress");
    expect(deriveStatus({ runtime: runtime(), progress: allMet, hasDoD: true })).toBe("done");
  });

  it("signPending flags a sign resting on unrun/stale evidence", () => {
    expect(signPending("sign", { ...allMet, unrun: 1 })).toBe(true);
    expect(signPending("sign", { ...allMet, stale: 1 })).toBe(true);
    expect(signPending("sign", allMet)).toBe(false);
    expect(signPending("merge", { ...allMet, unrun: 1 })).toBe(false);
  });
});
