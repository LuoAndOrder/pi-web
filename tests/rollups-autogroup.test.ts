// M4 — Unfiled auto-group clustering (the SINGLE grounded heuristic).
//
// Pure unit tests, no server, no DOM. They pin `clusterUnfiledSessions`, the client-side
// formula behind the "Group these N related sessions?" suggestion chips:
//   1. ≥2 sessions sharing a normalized leading token cluster → one suggestion, named by the
//      LONGEST common leading phrase (as specific as the evidence supports).
//   2. A lone session, or a too-weak (1-2 char) head, never produces a suggestion (no
//      fabricated grouping from thin signal).
//   3. Trailing disambiguators ("#2", "(3)") are stripped so "Auth refactor #1" and
//      "Auth refactor #2" still cluster; output is sorted largest-first with a stable key tiebreak.

import { describe, expect, it } from "vitest";

import { clusterUnfiledSessions } from "../src/dashboard/render.js";

describe("clusterUnfiledSessions", () => {
  it("groups ≥2 sessions sharing a leading phrase, naming by the longest common prefix", () => {
    const groups = clusterUnfiledSessions([
      { id: "a", name: "Auth refactor: login" },
      { id: "b", name: "Auth refactor: logout" },
      { id: "c", name: "Billing dashboard" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Auth Refactor");
    expect(groups[0].key).toBe("auth-refactor");
    expect(groups[0].sessionIds.sort()).toEqual(["a", "b"]);
  });

  it("never suggests a group for a lone session or a too-weak head token", () => {
    expect(
      clusterUnfiledSessions([
        { id: "a", name: "Auth refactor" },
        { id: "b", name: "Billing" },
        { id: "c", name: "Payments" },
      ]),
    ).toEqual([]); // every distinct topic appears once → no cluster
    // A 1-2 char shared head ("wip") is too weak to group on, even with multiple members.
    expect(
      clusterUnfiledSessions([
        { id: "a", name: "wip thing one" },
        { id: "b", name: "wip thing two" },
      ]).find((g) => g.key === "wip"),
    ).toBeUndefined();
  });

  it("strips trailing #N / (N) disambiguators so numbered variants still cluster", () => {
    const groups = clusterUnfiledSessions([
      { id: "a", name: "Nightly lint #1" },
      { id: "b", name: "Nightly lint #2" },
      { id: "c", name: "Nightly lint (3)" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Nightly Lint");
    expect(groups[0].sessionIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("sorts suggestions largest-first with a stable key tiebreak; ignores nameless sessions", () => {
    const groups = clusterUnfiledSessions([
      { id: "a", name: "Search index build" },
      { id: "b", name: "Search index reindex" },
      { id: "c", name: "Search index purge" },
      { id: "d", name: "Theme tokens dark" },
      { id: "e", name: "Theme tokens light" },
      { id: "f", name: "" }, // nameless → contributes no tokens, never grouped
      { id: "g" },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["search-index", "theme-tokens"]);
    expect(groups[0].sessionIds).toHaveLength(3);
    expect(groups[1].sessionIds).toHaveLength(2);
    expect(groups.some((g) => g.sessionIds.includes("f") || g.sessionIds.includes("g"))).toBe(false);
  });
});
