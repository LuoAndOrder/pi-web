// S8 regression — /api/git/sync is a rollup_changed dirty trigger.
//
// The bug: markRollupDirtyForCwd(cwd) enqueues a pending entry with an EMPTY
// session id. At flush, mapSessionsToProjects buckets any falsy-id session into
// `unassigned` BEFORE its cwd-prefix match can run, so a cwd-only dirty mark used
// to resolve to zero projects and emit no rollup_changed — an open dashboard never
// auto-refreshed after a git sync, contradicting the S8 acceptance criterion that
// lists /api/git/sync as a dirty trigger.
//
// This drives the REAL wire: a temp repo (with a bare `origin` remote + an
// upstream-tracking branch so the fetch/pull are clean no-ops) is registered as a
// project root, then POST /api/git/sync must coalesce into EXACTLY one
// rollup_changed for the owning project.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  openRealtime,
  repoRoot,
  startServer,
  type RealtimeCollector,
  type RollupServer,
} from "./helpers/rollupHarness.js";
import { commitFile, initRepo, renameBranch, runGit } from "./helpers/gitRepo.js";
import type { ProjectRegistry } from "../server/rollups/types.js";

const NOW = new Date().toISOString();
const DEBOUNCE_MS = 600;

function seedRegistry(root: string): ProjectRegistry {
  return {
    version: 1,
    projects: [
      {
        id: "proj-sync",
        name: "Sync Project",
        roots: [root],
        workstreamIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    workstreams: [],
  };
}

describe("rollups realtime — /api/git/sync dirty trigger (S8)", () => {
  let server: RollupServer;
  let realtime: RealtimeCollector;
  // Repo lives UNDER repoRoot (the server cwd) because gitCwdFromRepoParam rejects
  // absolute / out-of-workspace ?repo= paths; relPath is what we pass on the wire.
  let work: string;
  let relPath: string;

  beforeAll(async () => {
    // Bare origin + a work clone with an upstream-tracking branch → fetch/pull are
    // clean no-ops the sync endpoint can run without a network or divergence.
    const scratch = await mkdtemp(join(repoRoot, ".pi-web-test-gitsync-"));
    const origin = join(scratch, "origin.git");
    work = join(scratch, "work");
    await runGit(["init", "--bare", origin], scratch);
    await initRepo(work);
    await commitFile(work, "README.md", "hello\n", "init");
    await renameBranch(work, "main");
    await runGit(["remote", "add", "origin", origin], work);
    await runGit(["push", "-u", "origin", "main"], work);

    relPath = relative(repoRoot, work);
    server = await startServer({
      registry: seedRegistry(work),
      extraEnv: { PI_WEB_ROLLUP_DEBOUNCE_MS: String(DEBOUNCE_MS) },
    });
    realtime = await openRealtime(server);
  }, 30_000);

  afterAll(async () => {
    realtime?.close();
    await server?.stop();
    // scratch is the parent of `work`; remove the whole tree.
    if (work) await rm(join(work, ".."), { recursive: true, force: true });
  });

  it("emits exactly one coalesced rollup_changed for the project owning the synced cwd", async () => {
    realtime.clear();

    const res = await server.api("POST", `/api/git/sync?repo=${encodeURIComponent(relPath)}`, undefined);
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);

    // Let the full debounce window elapse so the dirty flush has fired.
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 2));

    const rollupChanges = realtime.messages.filter((m) => m.type === "rollup_changed");
    expect(rollupChanges.length).toBe(1);
    expect(rollupChanges[0]?.projectId).toBe("proj-sync");
    // id-only envelope (client refetches) + monotonic seq.
    expect(Object.keys(rollupChanges[0] ?? {}).sort()).toEqual(["projectId", "seq", "type"]);
  }, 20_000);
});
