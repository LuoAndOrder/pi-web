// Git-derived DoD evaluation — pure, dependency-injected helpers.
//
// This module imports NOTHING from server.ts so it unit-tests in-process
// (mirroring the tests/git-diff.test.ts precedent of importing a module
// directly). server.ts wires thin wrappers around these with the real `git`
// runner and `gitStatus` loader.
//
// S0 lands `gitIsAncestor` (the `git merge-base --is-ancestor` semantics the
// `git_merged` criterion needs) plus the per-repo-root TTL cache that keeps
// `/api/rollups` from re-spawning git per session. S3 adds `evalGitCriterion`
// (inline, cheap, on the render path) + `sessionGitInfo` / `gitConflicted`.

import type { CriterionEval, DoDCriterion, SessionGitInfo } from "./types.js";

export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * True when `ancestor` is an ancestor of `into` (i.e. `into` contains it).
 * `git merge-base --is-ancestor` exits 0 when true, 1 when false, and a
 * different code on real errors — which we rethrow rather than swallow.
 */
export async function gitIsAncestor(
  runGit: GitRunner,
  ancestor: string,
  into: string,
  cwd: string,
): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, into], cwd);
    return true;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 1) return false;
    throw error;
  }
}

export interface RepoStatusCache<T> {
  /** Returns a cached value when fresh within ttl, else loads and caches. */
  get(cwd: string, ttlMs?: number): Promise<T>;
  /** Drop a single root (and any sibling key sharing its resolved root); no arg clears all. */
  invalidate(cwd?: string): void;
  /** Number of cached entries (test/inspection). */
  size(): number;
  /** Peek a cached value without loading (test/inspection). */
  peek(cwd: string): T | undefined;
}

export interface RepoStatusCacheOptions {
  /** Default freshness window; a number or a getter (so env can be read live). */
  defaultTtlMs?: number | (() => number);
  /** Injectable clock for deterministic ttl tests. */
  now?: () => number;
  /** Normalise the cache key (server.ts resolves the cwd to an absolute path). */
  resolveKey?: (cwd: string) => string;
}

/**
 * A TTL cache over a single-arg loader (the loader is `gitStatus` in server.ts).
 * Concurrent calls for the same key share one in-flight load, so a multi-session
 * project evaluates each distinct repo root exactly once.
 */
export function createRepoStatusCache<T extends { root?: string }>(
  loader: (cwd: string) => Promise<T>,
  options: RepoStatusCacheOptions = {},
): RepoStatusCache<T> {
  const now = options.now ?? (() => Date.now());
  const resolveKey = options.resolveKey ?? ((cwd: string) => cwd);
  const ttlOf = () => {
    const value =
      typeof options.defaultTtlMs === "function" ? options.defaultTtlMs() : options.defaultTtlMs;
    return typeof value === "number" && value >= 0 ? value : 3000;
  };

  const store = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();

  async function get(cwd: string, ttlMs: number = ttlOf()): Promise<T> {
    const key = resolveKey(cwd);
    const hit = store.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;

    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const value = await loader(cwd);
        store.set(key, { at: now(), value });
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  function invalidate(cwd?: string): void {
    if (cwd == null) {
      store.clear();
      return;
    }
    const key = resolveKey(cwd);
    const targetRoot = store.get(key)?.value.root;
    for (const [entryKey, entry] of store) {
      const root = entry.value.root;
      if (entryKey === key || root === key || (targetRoot != null && root === targetRoot)) {
        store.delete(entryKey);
      }
    }
  }

  return {
    get,
    invalidate,
    size: () => store.size,
    peek: (cwd: string) => store.get(resolveKey(cwd))?.value,
  };
}

// ---- Git-derived criterion evaluation (S3, inline on the render path) --------

/** The subset of `gitStatus(cwd)` that the git evaluators read. */
export interface GitStatusLite {
  ok?: boolean;
  isRepo?: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files?: Array<{ label?: string }>;
}

/** A merge-base check bound to one repo root (the `git_merged` evaluator). */
export type IsAncestorFn = (ancestor: string, into: string) => Promise<boolean>;

/** True when the working tree carries a conflicted file → the session is blocked. */
export function gitConflicted(status: GitStatusLite | undefined): boolean {
  return Boolean(status?.isRepo) && (status?.files || []).some((f) => f?.label === "conflicted");
}

/** The per-session git facts that ride on a SessionRollup. Undefined off-repo. */
export function sessionGitInfo(status: GitStatusLite | undefined): SessionGitInfo | undefined {
  if (!status?.isRepo) return undefined;
  return {
    branch: status.branch || "",
    ahead: Number(status.ahead || 0),
    behind: Number(status.behind || 0),
    dirtyCount: (status.files || []).length,
    blocked: gitConflicted(status),
  };
}

/**
 * Build a CriterionEval record (id/met/evidence/evaluatedAt/sourceKind + the
 * gate/weight/text copy). Shared by every evaluator family so the record shape
 * stays in one place — git criteria here, manual/command/session_idle in
 * rollup.ts via this same helper. `extra` carries flags like `{ unrun: true }`.
 */
export function evalBase(
  criterion: DoDCriterion,
  met: boolean,
  evidence: string,
  evaluatedAt: string,
  extra?: Partial<CriterionEval>,
): CriterionEval {
  const out: CriterionEval = {
    id: criterion.id,
    met,
    evidence,
    evaluatedAt,
    sourceKind: criterion.source.kind,
    ...extra,
  };
  if (criterion.gate === true) out.gate = true;
  if (typeof criterion.weight === "number") out.weight = criterion.weight;
  if (criterion.text) out.text = criterion.text;
  return out;
}

/**
 * Evaluate a single git-family criterion against a pre-loaded (cached) gitStatus
 * for its repo root. Cheap and inline — git criteria are always FRESH on read
 * (never `unrun`/`stale` from here; the render-path TTL is what can age them, and
 * a MET git_merged is permanent regardless). `command` criteria are NOT handled
 * here — they are excluded inline and evaluated on-demand via /api/dod/evaluate.
 */
export async function evalGitCriterion(
  criterion: DoDCriterion,
  status: GitStatusLite | undefined,
  isAncestor: IsAncestorFn,
  now: Date = new Date(),
): Promise<CriterionEval> {
  const at = now.toISOString();
  const source = criterion.source;

  if (!status?.isRepo) {
    return evalBase(criterion, false, "repo unavailable (not a git repo)", at);
  }

  switch (source.kind) {
    case "git_clean": {
      const dirty = (status.files || []).length;
      return evalBase(
        criterion,
        dirty === 0,
        dirty === 0 ? "working tree clean" : `${dirty} uncommitted change(s)`,
        at,
      );
    }
    case "git_ahead_zero": {
      const ahead = Number(status.ahead || 0);
      const tracked = Boolean(status.upstream && status.upstream.trim());
      const met = ahead === 0 && tracked;
      const evidence = !tracked
        ? "no upstream branch to compare against"
        : ahead === 0
          ? "in sync with upstream (ahead 0)"
          : `${ahead} commit(s) ahead of upstream`;
      return evalBase(criterion, met, evidence, at);
    }
    case "git_merged": {
      const branch = status.branch || "";
      if (!branch) return evalBase(criterion, false, "no current branch", at);
      // `isAncestor` (git merge-base --is-ancestor) RETHROWS on a non-1 exit —
      // e.g. exit 128 when `into` does not resolve (a typo, a `main` default on a
      // `master` repo, a deleted branch). On the /api/rollups render path that
      // must NOT bubble up and 500 the whole feed (S3: never throw on a messy
      // session). A missing `into` ref honestly means "not merged" → degrade to
      // not-met with evidence. The rethrow stays intact for callers that want the
      // real error (the on-demand /api/dod/evaluate path).
      let merged = false;
      try {
        merged = await isAncestor(branch, source.into);
      } catch {
        return evalBase(
          criterion,
          false,
          `could not verify merge into ${source.into} (ref unavailable)`,
          at,
        );
      }
      return evalBase(
        criterion,
        merged,
        merged
          ? `${branch} merged into ${source.into}`
          : `${branch} is not an ancestor of ${source.into}`,
        at,
      );
    }
    default:
      // Not a git criterion — caller should not route it here.
      return evalBase(criterion, false, "not a git criterion", at);
  }
}
