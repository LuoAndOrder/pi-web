// Temp git-repo builder for the rollup test suites. Mirrors the init/add/commit
// boilerplate in tests/api.test.ts, factored out so S0 (git_merged semantics)
// and S3 (git-derived DoD) can share deterministic fixtures.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        (error as { stdout?: string }).stdout = String(stdout);
        (error as { stderr?: string }).stderr = String(stderr);
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Init a repo with a deterministic local identity (no global config needed). */
export async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await runGit(["init"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "Rollup Test"], dir);
  await runGit(["config", "commit.gpgsign", "false"], dir);
  return dir;
}

/** Write a file, stage everything, commit, and return the new commit SHA. */
export async function commitFile(
  dir: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(dir, file), content);
  await runGit(["add", "-A"], dir);
  await runGit(["commit", "-m", message], dir);
  return headSha(dir);
}

export async function headSha(dir: string): Promise<string> {
  const { stdout } = await runGit(["rev-parse", "HEAD"], dir);
  return stdout.trim();
}

export async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await runGit(["branch", "--show-current"], dir);
  return stdout.trim();
}

/** Rename the current branch (robust across git's master/main default). */
export async function renameBranch(dir: string, name: string): Promise<void> {
  await runGit(["branch", "-M", name], dir);
}

export async function checkoutNew(dir: string, branch: string): Promise<void> {
  await runGit(["checkout", "-b", branch], dir);
}

export async function checkout(dir: string, branch: string): Promise<void> {
  await runGit(["checkout", branch], dir);
}

/** Merge `branch` into the current branch with a merge commit. */
export async function mergeNoFf(dir: string, branch: string): Promise<void> {
  await runGit(["merge", "--no-ff", "-m", `merge ${branch}`, branch], dir);
}

/** Dirty the working tree (an untracked file -> dirtyCount > 0). */
export async function makeDirty(dir: string, file = "dirty.txt"): Promise<void> {
  await writeFile(join(dir, file), `dirty ${Date.now()}\n`);
}
