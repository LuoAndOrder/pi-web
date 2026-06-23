// Project Rollups — progress derivation (pure, unit-testable).
//
// This is a faithful port of `computeProgress` + `critUnrun` / `critStale` /
// `critGit` / `rootScoped` from the validated mockup (`index.html` L915-964),
// re-keyed off the STRUCTURED `CriterionEval.sourceKind` instead of the mockup's
// free-text `srcFamily()` substring match (DATA-MODEL §5.5 / risk #9). It imports
// nothing from `server.ts`, so the rollup compute that consumes it stays
// in-process testable.
//
// The exact computation (DATA-MODEL §5.2, matches the mockup byte-for-byte):
//   evaluable = criteria where !gate && !rootScoped   (sign-off gates + repo-root
//                                                       git_clean excluded from %)
//   run       = evaluable where !unrun                (never-run command criteria
//                                                       excluded from the denominator)
//   percent   = sum(weight of met run) / sum(weight of run) * 100
//   allMet    = run.length > 0 && all run met && unrun === 0 && stale === 0

import type { CriterionEval, ProgressSnapshot, WorkItemStatus } from "./types.js";

/** git_clean is a property of the REPO ROOT, not any one session — scoped OUT of
 *  the per-session percent and rendered once at repo scope (mockup L944-950). */
export function rootScoped(c: CriterionEval): boolean {
  return c.sourceKind === "git_clean";
}

/** The git evaluator family (git_clean / git_ahead_zero / git_merged). */
export function critGit(c: CriterionEval): boolean {
  return (
    c.sourceKind === "git_clean" ||
    c.sourceKind === "git_ahead_zero" ||
    c.sourceKind === "git_merged"
  );
}

/** A never-run command criterion — excluded from the denominator, drawn faint. */
export function critUnrun(c: CriterionEval): boolean {
  return c.unrun === true;
}

/** Ran, but the cached result is old → can't back a 100% / a sign-off promotion.
 *  A MET git_merged is a permanent fact (merge-base --is-ancestor stays true once
 *  an ancestor) so it never goes stale (mockup L933). Gates + unrun crits aren't
 *  clock-stale. The eval stage stamps `stale` for clock-bound git/command crits. */
export function critStale(c: CriterionEval): boolean {
  if (c.gate || critUnrun(c)) return false;
  if (c.sourceKind === "git_merged" && c.met) return false;
  return c.stale === true;
}

/** Default weight 1; clamp a stray negative to 0 (registry already clamps). */
export function weightOf(c: CriterionEval): number {
  return typeof c.weight === "number" && c.weight >= 0 ? c.weight : 1;
}

/** A WorkItemStatus derived from the criteria alone (runtime/git refine it in
 *  status.ts). allMet → done; some weight met → in_progress; else planned. */
function derivedStatusFor(allMet: boolean, metWeight: number): WorkItemStatus {
  if (allMet) return "done";
  if (metWeight > 0) return "in_progress";
  return "planned";
}

/** A zeroed snapshot for a DoD with no evaluable (non-gate, non-rootScoped) criteria. */
export function emptyProgress(criteria: CriterionEval[] = []): ProgressSnapshot {
  return {
    met: 0,
    total: 0,
    metWeight: 0,
    totalWeight: 0,
    percent: 0,
    allMet: false,
    unrun: 0,
    stale: 0,
    derivedStatus: "planned",
    criteria,
  };
}

/**
 * Compute an honest k-of-n ProgressSnapshot over evaluated criteria.
 * Returns `null` only when there are no criteria at all (parallels the mockup's
 * `computeProgress` returning null on an empty list); a gate-only / rootScoped-only
 * DoD returns a zeroed snapshot so callers always get a shape to render.
 */
export function computeProgress(
  criteria: CriterionEval[] | null | undefined,
): ProgressSnapshot | null {
  if (!criteria || !criteria.length) return null;
  const evaluable = criteria.filter((c) => !c.gate && !rootScoped(c));
  if (!evaluable.length) return emptyProgress(criteria);

  const run = evaluable.filter((c) => !critUnrun(c));
  const unrun = evaluable.length - run.length;
  const stale = run.filter(critStale).length;

  let metWeight = 0;
  let totalWeight = 0;
  let met = 0;
  for (const c of run) {
    const w = weightOf(c);
    totalWeight += w;
    if (c.met) {
      metWeight += w;
      met += 1;
    }
  }

  const percent = totalWeight ? Math.round((metWeight / totalWeight) * 100) : 0;
  const allMet = run.length > 0 && metWeight === totalWeight && unrun === 0 && stale === 0;

  return {
    met,
    total: run.length,
    metWeight,
    totalWeight,
    percent,
    allMet,
    unrun,
    stale,
    derivedStatus: derivedStatusFor(allMet, metWeight),
    criteria,
  };
}

/** The first not-yet-met sign-off gate (excluded from %, promotes status to "sign"). */
export function pendingGate(criteria: CriterionEval[] | null | undefined): CriterionEval | null {
  return (criteria || []).find((c) => c.gate && !c.met) || null;
}
