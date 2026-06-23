// Pure unit tests for the progress formula (server/rollups/progress.ts).
//
// Table-driven, direct import, no server. Each case names the §5.2 branch it
// pins: gate-exclusion, never-run exclusion, stale-blocks-allMet, git_clean
// root-scoping, git_merged-permanent, weights-honored.

import { describe, expect, it } from "vitest";

import {
  computeProgress,
  critGit,
  critStale,
  critUnrun,
  pendingGate,
  rootScoped,
  weightOf,
} from "../server/rollups/progress.js";
import type { CriterionEval, DoDSourceKind } from "../server/rollups/types.js";

let seq = 0;
function ce(partial: Partial<CriterionEval> & { sourceKind?: DoDSourceKind }): CriterionEval {
  return {
    id: partial.id ?? `c${++seq}`,
    met: partial.met ?? false,
    evaluatedAt: partial.evaluatedAt ?? "2026-06-22T00:00:00.000Z",
    sourceKind: partial.sourceKind ?? "manual",
    ...partial,
  };
}

describe("computeProgress (§5.2 exact formula)", () => {
  it("returns null for an empty / missing criteria list", () => {
    expect(computeProgress(null)).toBeNull();
    expect(computeProgress([])).toBeNull();
  });

  it("one met manual → 100%, allMet true", () => {
    const p = computeProgress([ce({ met: true })])!;
    expect(p).toMatchObject({ met: 1, total: 1, percent: 100, allMet: true, unrun: 0, stale: 0 });
    expect(p.derivedStatus).toBe("done");
  });

  it("one unmet manual → 0%, allMet false, in_progress only once weight is met", () => {
    const p = computeProgress([ce({ met: false })])!;
    expect(p).toMatchObject({ met: 0, total: 1, percent: 0, allMet: false });
    expect(p.derivedStatus).toBe("planned");
  });

  it("a gate is EXCLUDED from the percent but does NOT block allMet", () => {
    const p = computeProgress([
      ce({ met: true }), // evaluable, met
      ce({ met: false, gate: true, sourceKind: "manual" }), // sign-off gate, unmet
    ])!;
    expect(p.percent).toBe(100);
    expect(p.total).toBe(1); // gate not counted
    expect(p.allMet).toBe(true); // gate exclusion lets allMet promote to sign
  });

  it("a gate-only DoD → zeroed snapshot (no evaluable criteria), allMet false", () => {
    const p = computeProgress([ce({ met: true, gate: true })])!;
    expect(p).toMatchObject({ met: 0, total: 0, percent: 0, allMet: false });
    expect(p.criteria).toHaveLength(1); // full list still carried for render
  });

  it("a never-run command is EXCLUDED from the denominator and blocks allMet", () => {
    const p = computeProgress([
      ce({ met: true, sourceKind: "command" }),
      ce({ met: false, sourceKind: "command", unrun: true }),
    ])!;
    expect(p).toMatchObject({ met: 1, total: 1, percent: 100, unrun: 1 });
    expect(p.allMet).toBe(false); // unrun > 0 forbids promotion
  });

  it("a stale-but-met run criterion → 100% number but allMet false (can't back a sign-off)", () => {
    const p = computeProgress([ce({ met: true, sourceKind: "command", stale: true })])!;
    expect(p.percent).toBe(100);
    expect(p.stale).toBe(1);
    expect(p.allMet).toBe(false);
  });

  it("git_clean is root-scoped → EXCLUDED from the per-session percent", () => {
    const p = computeProgress([
      ce({ met: true, sourceKind: "git_clean" }), // root-scoped, excluded
      ce({ met: false, sourceKind: "manual" }), // the only evaluable crit
    ])!;
    expect(p.total).toBe(1);
    expect(p.percent).toBe(0); // the clean tree doesn't credit the session
  });

  it("a MET git_merged is permanent — never stale even if flagged", () => {
    const p = computeProgress([ce({ met: true, sourceKind: "git_merged", stale: true })])!;
    expect(p.stale).toBe(0); // critStale forces false for a met git_merged
    expect(p.allMet).toBe(true);
  });

  it("weights are honored (weight 3 met + weight 1 unmet → 75%)", () => {
    const p = computeProgress([
      ce({ met: true, weight: 3 }),
      ce({ met: false, weight: 1 }),
    ])!;
    expect(p).toMatchObject({ metWeight: 3, totalWeight: 4, percent: 75, met: 1, total: 2 });
    expect(p.allMet).toBe(false);
  });

  it("a NOT-met weight-0 criterion stays visible — no fabricated 100% / allMet", () => {
    // Repro of the honesty bug: weight 0 coalesces to 1 (mockup `c.weight||1`), so
    // an unmet w=0 crit still lowers the percent AND blocks allMet — it must never
    // become invisible and back a sign-off on unmet work.
    const p = computeProgress([
      ce({ met: true, weight: 3 }), // met
      ce({ met: false, weight: 0 }), // unmet, weight 0 -> coalesced to 1
    ])!;
    expect(p.met).toBe(1);
    expect(p.total).toBe(2);
    expect(p.metWeight).toBe(3);
    expect(p.totalWeight).toBe(4); // 3 + (0 -> 1)
    expect(p.percent).toBe(75);
    expect(p.allMet).toBe(false);
  });

  it("a MET weight-0 criterion still counts toward the denominator", () => {
    const p = computeProgress([ce({ met: true, weight: 0 }), ce({ met: true, weight: 3 })])!;
    expect(p.metWeight).toBe(4); // (0 -> 1) + 3
    expect(p.totalWeight).toBe(4);
    expect(p.percent).toBe(100);
    expect(p.allMet).toBe(true);
  });

  it("session_idle measures liveness, not completion → EXCLUDED from the percent + allMet", () => {
    // A card must never climb toward "done" because the agent went idle (§5.1).
    const idleOnly = computeProgress([ce({ met: true, sourceKind: "session_idle" })])!;
    expect(idleOnly).toMatchObject({ total: 0, percent: 0, allMet: false });
    expect(idleOnly.criteria).toHaveLength(1); // still carried for render

    const withWork = computeProgress([
      ce({ met: true, sourceKind: "session_idle" }), // liveness-only, excluded
      ce({ met: false, sourceKind: "manual" }), // the only evaluable crit
    ])!;
    expect(withWork.total).toBe(1);
    expect(withWork.percent).toBe(0); // idle doesn't credit completion
    expect(withWork.allMet).toBe(false);
  });

  it("mixed met/unmet equal weights → rounded percent", () => {
    const p = computeProgress([
      ce({ met: true }),
      ce({ met: true }),
      ce({ met: false }),
    ])!;
    expect(p.percent).toBe(67); // 2/3 rounded
  });

  it("all evaluable met + no unrun/stale → allMet true (sign-off eligible)", () => {
    const p = computeProgress([
      ce({ met: true, sourceKind: "git_merged" }),
      ce({ met: true, sourceKind: "manual" }),
    ])!;
    expect(p.allMet).toBe(true);
    expect(p.percent).toBe(100);
  });
});

describe("criterion classifiers", () => {
  it("rootScoped is git_clean only", () => {
    expect(rootScoped(ce({ sourceKind: "git_clean" }))).toBe(true);
    expect(rootScoped(ce({ sourceKind: "git_merged" }))).toBe(false);
    expect(rootScoped(ce({ sourceKind: "manual" }))).toBe(false);
  });

  it("critGit covers the three git evaluators", () => {
    for (const kind of ["git_clean", "git_ahead_zero", "git_merged"] as DoDSourceKind[]) {
      expect(critGit(ce({ sourceKind: kind }))).toBe(true);
    }
    expect(critGit(ce({ sourceKind: "command" }))).toBe(false);
  });

  it("critUnrun reads the eval flag; critStale guards gate/unrun/permanent-merge", () => {
    expect(critUnrun(ce({ unrun: true }))).toBe(true);
    expect(critStale(ce({ stale: true, gate: true }))).toBe(false);
    expect(critStale(ce({ stale: true, unrun: true }))).toBe(false);
    expect(critStale(ce({ stale: true, sourceKind: "git_merged", met: true }))).toBe(false);
    expect(critStale(ce({ stale: true, sourceKind: "command" }))).toBe(true);
  });

  it("weightOf defaults to 1 and coalesces 0 / negative / undefined to 1", () => {
    expect(weightOf(ce({}))).toBe(1);
    expect(weightOf(ce({ weight: 3 }))).toBe(3);
    expect(weightOf(ce({ weight: -2 }))).toBe(1);
    expect(weightOf(ce({ weight: 0 }))).toBe(1); // mockup `c.weight||1`: 0 -> 1
  });

  it("pendingGate returns the first unmet gate, else null", () => {
    expect(pendingGate([ce({ gate: true, met: false, id: "g" })])?.id).toBe("g");
    expect(pendingGate([ce({ gate: true, met: true })])).toBeNull();
    expect(pendingGate([ce({ met: false })])).toBeNull();
  });
});
