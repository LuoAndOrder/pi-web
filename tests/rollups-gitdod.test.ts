import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRepoStatusCache,
  evalGitCriterion,
  gitConflicted,
  gitIsAncestor,
  sessionGitInfo,
} from "../server/rollups/gitDod.js";
import type { DoDCriterion, DoDSource } from "../server/rollups/types.js";
import {
  checkout,
  checkoutNew,
  commitFile,
  headSha,
  initRepo,
  mergeNoFf,
  renameBranch,
  runGit,
} from "./helpers/gitRepo.js";

// `runGit` matches the injected GitRunner signature (args, cwd) -> {stdout, stderr}.
const inject = runGit;

function crit(source: DoDSource): DoDCriterion {
  return { id: "x", text: "criterion", source };
}
const noAncestor = async () => false;

describe("gitIsAncestor (git_merged semantics)", () => {
  let repo: string;
  let featSha: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "rollups-gitdod-"));
    await initRepo(repo);
    await commitFile(repo, "README.md", "base\n", "base");
    await renameBranch(repo, "main");
    await checkoutNew(repo, "feat/x");
    featSha = await commitFile(repo, "feature.txt", "feature\n", "feature work");
    await checkout(repo, "main");
  }, 20_000);

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("is false before the branch is merged into main (exit 1, never throws)", async () => {
    await expect(gitIsAncestor(inject, "feat/x", "main", repo)).resolves.toBe(false);
    await expect(gitIsAncestor(inject, featSha, "main", repo)).resolves.toBe(false);
  });

  it("flips true once feat/x is merged into main", async () => {
    await mergeNoFf(repo, "feat/x");
    await expect(gitIsAncestor(inject, "feat/x", "main", repo)).resolves.toBe(true);
    await expect(gitIsAncestor(inject, featSha, "main", repo)).resolves.toBe(true);
  });

  it("stays true (permanent) after later commits on main", async () => {
    await commitFile(repo, "after.txt", "after\n", "more work");
    await expect(gitIsAncestor(inject, "feat/x", "main", repo)).resolves.toBe(true);
    await expect(gitIsAncestor(inject, featSha, "main", repo)).resolves.toBe(true);
  });

  it("rethrows on a real git error (non-1 exit), e.g. an unknown ref", async () => {
    await expect(gitIsAncestor(inject, "no-such-ref", "main", repo)).rejects.toBeTruthy();
  });
});

describe("evalGitCriterion (git-derived DoD)", () => {
  it("off-repo → not met, never throws", async () => {
    const e = await evalGitCriterion(crit({ kind: "git_clean" }), { isRepo: false }, noAncestor);
    expect(e.met).toBe(false);
    expect(e.sourceKind).toBe("git_clean");
    expect(await evalGitCriterion(crit({ kind: "git_clean" }), undefined, noAncestor)).toMatchObject({ met: false });
  });

  it("git_clean: met on a clean tree, unmet with uncommitted files", async () => {
    const clean = await evalGitCriterion(crit({ kind: "git_clean" }), { isRepo: true, files: [] }, noAncestor);
    expect(clean.met).toBe(true);
    const dirty = await evalGitCriterion(
      crit({ kind: "git_clean" }),
      { isRepo: true, files: [{ label: "modified" }, { label: "untracked" }] },
      noAncestor,
    );
    expect(dirty.met).toBe(false);
    expect(dirty.evidence).toContain("2");
  });

  it("git_ahead_zero: met iff ahead 0 AND an upstream exists", async () => {
    const synced = await evalGitCriterion(
      crit({ kind: "git_ahead_zero" }),
      { isRepo: true, ahead: 0, upstream: "origin/main", files: [] },
      noAncestor,
    );
    expect(synced.met).toBe(true);
    const noUpstream = await evalGitCriterion(
      crit({ kind: "git_ahead_zero" }),
      { isRepo: true, ahead: 0, upstream: "", files: [] },
      noAncestor,
    );
    expect(noUpstream.met).toBe(false);
    const ahead = await evalGitCriterion(
      crit({ kind: "git_ahead_zero" }),
      { isRepo: true, ahead: 2, upstream: "origin/main", files: [] },
      noAncestor,
    );
    expect(ahead.met).toBe(false);
  });

  it("git_merged: false before merge, true after (real merge-base on a temp repo)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rollups-evalgit-"));
    try {
      await initRepo(repo);
      await commitFile(repo, "README.md", "base\n", "base");
      await renameBranch(repo, "main");
      await checkoutNew(repo, "feat/y");
      await commitFile(repo, "feature.txt", "feature\n", "feature work");
      // The repo sits on feat/y; the criterion asks "feat/y merged into main".
      const c = crit({ kind: "git_merged", into: "main" });
      const isAncestor = (ancestor: string, into: string) => gitIsAncestor(inject, ancestor, into, repo);

      const before = await evalGitCriterion(c, { isRepo: true, branch: "feat/y", files: [] }, isAncestor);
      expect(before.met).toBe(false);

      await checkout(repo, "main");
      await mergeNoFf(repo, "feat/y");

      const after = await evalGitCriterion(c, { isRepo: true, branch: "feat/y", files: [] }, isAncestor);
      expect(after.met).toBe(true);
      expect(after.evidence).toContain("main");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 20_000);

  it("git_merged: a missing `into` ref degrades to not-met instead of throwing (render path)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rollups-evalgit-noref-"));
    try {
      await initRepo(repo);
      await commitFile(repo, "README.md", "base\n", "base");
      await renameBranch(repo, "master"); // repo has NO `main` branch
      // The real gitIsAncestor RETHROWS on exit 128 (bad `into` revision). The
      // render path must catch it and degrade — not propagate (would 500 the feed).
      const isAncestor = (ancestor: string, into: string) => gitIsAncestor(inject, ancestor, into, repo);
      const c = crit({ kind: "git_merged", into: "main" });

      const evaluated = await evalGitCriterion(c, { isRepo: true, branch: "master", files: [] }, isAncestor);
      expect(evaluated.met).toBe(false);
      expect(evaluated.evidence).toMatch(/could not verify|unavailable/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("sessionGitInfo / gitConflicted", () => {
  it("off-repo → undefined", () => {
    expect(sessionGitInfo(undefined)).toBeUndefined();
    expect(sessionGitInfo({ isRepo: false })).toBeUndefined();
  });

  it("a clean repo → dirtyCount 0, not blocked", () => {
    const g = sessionGitInfo({ isRepo: true, branch: "main", ahead: 1, behind: 2, files: [] })!;
    expect(g).toEqual({ branch: "main", ahead: 1, behind: 2, dirtyCount: 0, blocked: false });
  });

  it("a conflicted file → blocked, dirtyCount counts every file", () => {
    expect(gitConflicted({ isRepo: true, files: [{ label: "conflicted" }] })).toBe(true);
    expect(gitConflicted({ isRepo: true, files: [{ label: "modified" }] })).toBe(false);
    const g = sessionGitInfo({ isRepo: true, branch: "main", files: [{ label: "conflicted" }, { label: "modified" }] })!;
    expect(g.dirtyCount).toBe(2);
    expect(g.blocked).toBe(true);
  });
});

type FakeStatus = { root: string; files: string[]; n: number };

describe("createRepoStatusCache (repo-status TTL cache)", () => {
  it("loads once and serves 2nd-5th calls from cache within the TTL (no re-spawn)", async () => {
    let calls = 0;
    const cache = createRepoStatusCache<FakeStatus>(
      async (cwd) => ({ root: cwd, files: [], n: ++calls }),
      { defaultTtlMs: 10_000 },
    );

    const first = await cache.get("/repo-a");
    const rest = [
      await cache.get("/repo-a"),
      await cache.get("/repo-a"),
      await cache.get("/repo-a"),
      await cache.get("/repo-a"),
    ];

    expect(calls).toBe(1);
    // identical cached shape returned to every caller (no fresh load)
    for (const value of rest) expect(value).toBe(first);
    expect(cache.size()).toBe(1);
    expect(cache.peek("/repo-a")).toBe(first);
  });

  it("collapses concurrent calls for the same root into one in-flight load", async () => {
    let calls = 0;
    const cache = createRepoStatusCache<FakeStatus>(
      async (cwd) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { root: cwd, files: [], n: calls };
      },
      { defaultTtlMs: 10_000 },
    );

    const results = await Promise.all([
      cache.get("/repo-b"),
      cache.get("/repo-b"),
      cache.get("/repo-b"),
      cache.get("/repo-b"),
    ]);

    expect(calls).toBe(1);
    for (const value of results) expect(value).toBe(results[0]);
  });

  it("reloads after the TTL elapses (injected clock)", async () => {
    let calls = 0;
    let clock = 1_000;
    const cache = createRepoStatusCache<FakeStatus>(
      async (cwd) => ({ root: cwd, files: [], n: ++calls }),
      { defaultTtlMs: 3_000, now: () => clock },
    );

    await cache.get("/repo-c"); // load 1 @ t=1000
    clock = 2_000;
    await cache.get("/repo-c"); // hit (1000 < 3000)
    expect(calls).toBe(1);
    clock = 5_000;
    await cache.get("/repo-c"); // 4000 >= 3000 -> reload
    expect(calls).toBe(2);
  });

  it("honors a per-call TTL override", async () => {
    let calls = 0;
    let clock = 0;
    const cache = createRepoStatusCache<FakeStatus>(
      async (cwd) => ({ root: cwd, files: [], n: ++calls }),
      { defaultTtlMs: 10_000, now: () => clock },
    );

    await cache.get("/repo-d"); // load @ t=0
    clock = 50;
    await cache.get("/repo-d", 10); // override ttl=10, 50 >= 10 -> reload
    expect(calls).toBe(2);
  });

  it("invalidates a single root explicitly", async () => {
    let calls = 0;
    const cache = createRepoStatusCache<FakeStatus>(
      async (cwd) => ({ root: cwd, files: [], n: ++calls }),
      { defaultTtlMs: 10_000 },
    );

    await cache.get("/repo-e");
    expect(cache.size()).toBe(1);
    cache.invalidate("/repo-e");
    expect(cache.size()).toBe(0);
    await cache.get("/repo-e"); // reload
    expect(calls).toBe(2);
  });

  it("invalidates sibling keys that share the same resolved repo root", async () => {
    const cache = createRepoStatusCache<FakeStatus>(
      async () => ({ root: "/repo-root", files: [], n: 0 }),
      { defaultTtlMs: 10_000 },
    );

    await cache.get("/repo-root");
    await cache.get("/repo-root/sub"); // different key, same root
    expect(cache.size()).toBe(2);

    cache.invalidate("/repo-root/sub");
    expect(cache.size()).toBe(0);
  });

  it("clears every entry when invalidate() is called with no argument", async () => {
    const cache = createRepoStatusCache<FakeStatus>(
      async (cwd) => ({ root: cwd, files: [], n: 0 }),
      { defaultTtlMs: 10_000 },
    );
    await cache.get("/repo-f");
    await cache.get("/repo-g");
    expect(cache.size()).toBe(2);
    cache.invalidate();
    expect(cache.size()).toBe(0);
  });

  it("normalizes keys via resolveKey so equivalent cwds share one entry", async () => {
    let calls = 0;
    const cache = createRepoStatusCache<FakeStatus>(
      async (cwd) => ({ root: cwd, files: [], n: ++calls }),
      { defaultTtlMs: 10_000, resolveKey: (cwd) => cwd.replace(/\/+$/, "") },
    );
    await cache.get("/repo-h");
    await cache.get("/repo-h/"); // trailing slash -> same key
    expect(calls).toBe(1);
    expect(cache.size()).toBe(1);
  });
});
