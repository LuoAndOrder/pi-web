// Git-derived DoD evaluation — pure, dependency-injected helpers.
//
// This module imports NOTHING from server.ts so it unit-tests in-process
// (mirroring the tests/git-diff.test.ts precedent of importing a module
// directly). server.ts wires thin wrappers around these with the real `git`
// runner and `gitStatus` loader.
//
// S0 lands `gitIsAncestor` (the `git merge-base --is-ancestor` semantics the
// `git_merged` criterion needs) plus the per-repo-root TTL cache that keeps
// `/api/rollups` from re-spawning git per session. `evalGitCriterion` and the
// rest of the criterion evaluation land in S3.

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
