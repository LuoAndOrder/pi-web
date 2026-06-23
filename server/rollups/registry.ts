// Project Rollups — the registry sidecar store.
//
// This is a VERBATIM structural copy of `createSessionUiStateStore`
// (server/sessionUiState.ts L151-226): the same in-memory `cached`, the same
// `serializeWrite` queue, the same atomic `${file}.${pid}.${Date.now()}.tmp` +
// `rename` write, and the same ENOENT/garbage -> default fallback on read. Only
// the normalizers + domain mutators are swapped for the `ProjectRegistry` shape.
//
// It imports NOTHING from `server.ts` (only the pure types), so it unit-tests
// in-process like the rest of `server/rollups/*`. The registry is the mutable
// truth for `kind:"manual"` criteria (the only persisted boolean) and for the
// criterion/project/workstream definitions; git/command/session evals are
// recomputed on read by `/api/rollups` and never persisted here.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  DoD,
  DoDCriterion,
  DoDSource,
  Project,
  ProjectRegistry,
  Provenance,
  Workstream,
  WorkItemStatus,
} from "./types.js";

export const defaultProjectRegistry: ProjectRegistry = {
  version: 1,
  projects: [],
  workstreams: [],
};

const workItemStatuses = new Set<WorkItemStatus>([
  "planned",
  "in_progress",
  "blocked",
  "done",
  "abandoned",
]);

const provenances = new Set<Provenance>(["user", "agent", "orchestrator", "rule"]);

/** Thrown by domain mutators that must signal a precise failure to the route layer. */
export class RegistryError extends Error {
  code: "not_found" | "not_manual";
  constructor(message: string, code: "not_found" | "not_manual") {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

function cloneRegistry(value: ProjectRegistry): ProjectRegistry {
  return JSON.parse(JSON.stringify(value)) as ProjectRegistry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isoOr(value: unknown, fallback: string = new Date().toISOString()): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const id = trimmedString(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const raw = trimmedString(item);
    if (!raw) continue;
    const abs = resolve(raw);
    if (seen.has(abs)) continue;
    seen.add(abs);
    result.push(abs);
  }
  return result;
}

function normalizeStatus(value: unknown): WorkItemStatus {
  return typeof value === "string" && workItemStatuses.has(value as WorkItemStatus)
    ? (value as WorkItemStatus)
    : "planned";
}

function normalizeProvenance(value: unknown): Provenance | undefined {
  return typeof value === "string" && provenances.has(value as Provenance)
    ? (value as Provenance)
    : undefined;
}

function normalizeBudget(value: unknown): { maxMinutes?: number; maxCostUsd?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const out: { maxMinutes?: number; maxCostUsd?: number } = {};
  const maxMinutes = finiteNumber(value.maxMinutes);
  const maxCostUsd = finiteNumber(value.maxCostUsd);
  if (maxMinutes != null && maxMinutes >= 0) out.maxMinutes = maxMinutes;
  if (maxCostUsd != null && maxCostUsd >= 0) out.maxCostUsd = maxCostUsd;
  return Object.keys(out).length ? out : undefined;
}

// Validates the 6 DoDSource discriminants + their required fields. An invalid
// source returns undefined, which drops the owning criterion in normalization.
export function normalizeDoDSource(value: unknown): DoDSource | undefined {
  if (!isRecord(value)) return undefined;
  const repo = typeof value.repo === "string" && value.repo.trim()
    ? { repo: resolve(value.repo.trim()) }
    : {};
  switch (value.kind) {
    case "manual":
      return { kind: "manual" };
    case "git_clean":
      return { kind: "git_clean", ...repo };
    case "git_ahead_zero":
      return { kind: "git_ahead_zero", ...repo };
    case "git_merged": {
      const into = trimmedString(value.into);
      if (!into) return undefined;
      return { kind: "git_merged", into, ...repo };
    }
    case "command": {
      const cwd = trimmedString(value.cwd);
      const cmd = trimmedString(value.cmd);
      if (!cwd || !cmd) return undefined;
      const expectExit = finiteNumber(value.expectExit);
      return {
        kind: "command",
        cwd: resolve(cwd),
        cmd,
        ...(expectExit != null ? { expectExit } : {}),
      };
    }
    case "session_idle": {
      const sessionId = trimmedString(value.sessionId);
      if (!sessionId) return undefined;
      return { kind: "session_idle", sessionId };
    }
    default:
      return undefined;
  }
}

// `met` is the only mutable boolean truth and is kept SOLELY for manual sources;
// computed git/command/session met-ness is never persisted here.
export function normalizeDoDCriterion(value: unknown): DoDCriterion | undefined {
  if (!isRecord(value)) return undefined;
  const source = normalizeDoDSource(value.source);
  if (!source) return undefined;
  const criterion: DoDCriterion = {
    id: trimmedString(value.id) || randomUUID(),
    text: typeof value.text === "string" ? value.text.trim() : "",
    source,
    weight: (() => {
      const weight = finiteNumber(value.weight);
      return weight != null ? Math.max(0, weight) : 1;
    })(),
  };
  const authoredBy = normalizeProvenance(value.authoredBy);
  if (authoredBy) criterion.authoredBy = authoredBy;
  if (value.gate === true) criterion.gate = true;
  if (source.kind === "manual") criterion.met = typeof value.met === "boolean" ? value.met : false;
  return criterion;
}

export function normalizeDoD(value: unknown): DoD | undefined {
  if (!isRecord(value) || !Array.isArray(value.criteria)) return undefined;
  return {
    criteria: value.criteria
      .map(normalizeDoDCriterion)
      .filter((criterion): criterion is DoDCriterion => Boolean(criterion)),
  };
}

export function normalizeProject(value: unknown): Project | undefined {
  if (!isRecord(value)) return undefined;
  const project: Project = {
    id: trimmedString(value.id) || randomUUID(),
    name: typeof value.name === "string" ? value.name.trim() : "",
    roots: normalizeRoots(value.roots),
    workstreamIds: normalizeStringArray(value.workstreamIds),
    createdAt: isoOr(value.createdAt),
    updatedAt: isoOr(value.updatedAt),
  };
  if (typeof value.description === "string" && value.description.trim()) {
    project.description = value.description.trim();
  }
  const dod = normalizeDoD(value.dod);
  if (dod) project.dod = dod;
  if (value.archived === true) project.archived = true;
  return project;
}

export function normalizeWorkstream(value: unknown): Workstream | undefined {
  if (!isRecord(value)) return undefined;
  const order = finiteNumber(value.order);
  const workstream: Workstream = {
    id: trimmedString(value.id) || randomUUID(),
    projectId: trimmedString(value.projectId),
    name: typeof value.name === "string" ? value.name.trim() : "",
    status: normalizeStatus(value.status),
    sessionIds: normalizeStringArray(value.sessionIds),
    order: order != null ? order : 0,
    createdAt: isoOr(value.createdAt),
    updatedAt: isoOr(value.updatedAt),
  };
  if (typeof value.description === "string" && value.description.trim()) {
    workstream.description = value.description.trim();
  }
  if (typeof value.matchCwd === "string" && value.matchCwd.trim()) {
    workstream.matchCwd = resolve(value.matchCwd.trim());
  }
  const dod = normalizeDoD(value.dod);
  if (dod) workstream.dod = dod;
  if (value.isLoop === true) workstream.isLoop = true;
  if (typeof value.loopStartedAt === "string" && value.loopStartedAt.trim()) {
    workstream.loopStartedAt = value.loopStartedAt.trim();
  }
  const budget = normalizeBudget(value.budget);
  if (budget) workstream.budget = budget;
  if (value.paused === true) workstream.paused = true;
  // Normalize `archived` exactly like project.archived: keep it ONLY when true so a
  // cleared flag is dropped rather than persisted as `archived:false`. An archived
  // workstream stays in the registry (retrievable) but is excluded from active
  // counts / the gauge / the long-pole and surfaced in a separate collapsed bucket.
  if (value.archived === true) workstream.archived = true;
  return workstream;
}

// Re-derive a project's ordered workstreamIds from the surviving workstreams:
// honor the project's existing order first (so a PATCH reorder sticks), then
// append any not-yet-listed workstreams sorted by their stored `order`.
function deriveWorkstreamIds(project: Project, workstreams: Workstream[]): string[] {
  const mine = workstreams.filter((workstream) => workstream.projectId === project.id);
  const mineIds = new Set(mine.map((workstream) => workstream.id));
  const listed: string[] = [];
  const seen = new Set<string>();
  for (const id of project.workstreamIds) {
    if (mineIds.has(id) && !seen.has(id)) {
      seen.add(id);
      listed.push(id);
    }
  }
  const rest = mine
    .filter((workstream) => !seen.has(workstream.id))
    .sort((a, b) => a.order - b.order)
    .map((workstream) => workstream.id);
  return [...listed, ...rest];
}

export function normalizeProjectRegistry(value: unknown): ProjectRegistry {
  if (!isRecord(value)) return cloneRegistry(defaultProjectRegistry);

  const projects = uniqueBy(
    (Array.isArray(value.projects) ? value.projects : [])
      .map(normalizeProject)
      .filter((project): project is Project => Boolean(project)),
    (project) => project.id,
  );

  const projectIds = new Set(projects.map((project) => project.id));
  const workstreams = uniqueBy(
    (Array.isArray(value.workstreams) ? value.workstreams : [])
      .map(normalizeWorkstream)
      .filter((workstream): workstream is Workstream => Boolean(workstream)),
    (workstream) => workstream.id,
  ).filter((workstream) => projectIds.has(workstream.projectId)); // drop orphans

  for (const project of projects) {
    project.workstreamIds = deriveWorkstreamIds(project, workstreams);
  }

  return { version: 1, projects, workstreams };
}

export function applyProjectRegistryPatch(
  current: ProjectRegistry,
  patch: unknown,
): ProjectRegistry {
  if (!isRecord(patch)) return cloneRegistry(current);
  const next: { version: 1; projects: unknown; workstreams: unknown } = {
    version: 1,
    projects: current.projects,
    workstreams: current.workstreams,
  };
  if ("projects" in patch && Array.isArray(patch.projects)) next.projects = patch.projects;
  if ("workstreams" in patch && Array.isArray(patch.workstreams)) next.workstreams = patch.workstreams;
  return normalizeProjectRegistry(next);
}

// Single project→workstream traversal that returns BOTH the criterion and its
// owning Project/Workstream, so callers that need to bump `owner.updatedAt` don't
// re-walk the registry.
function findCriterionWithOwner(
  registry: ProjectRegistry,
  criterionId: string,
): { owner: Project | Workstream; criterion: DoDCriterion } | undefined {
  for (const project of registry.projects) {
    const criterion = project.dod?.criteria.find((item) => item.id === criterionId);
    if (criterion) return { owner: project, criterion };
  }
  for (const workstream of registry.workstreams) {
    const criterion = workstream.dod?.criteria.find((item) => item.id === criterionId);
    if (criterion) return { owner: workstream, criterion };
  }
  return undefined;
}

export function createProjectRegistryStore(file: string) {
  let cached: ProjectRegistry | undefined;
  let writeQueue = Promise.resolve();

  async function serializeWrite<T>(operation: () => Promise<T>) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function read(): Promise<ProjectRegistry> {
    if (cached) return cloneRegistry(cached);
    try {
      cached = normalizeProjectRegistry(JSON.parse(await readFile(file, "utf-8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Could not read pi-web project registry at ${file}:`, error);
      }
      cached = cloneRegistry(defaultProjectRegistry);
    }
    return cloneRegistry(cached);
  }

  async function writeState(state: ProjectRegistry): Promise<ProjectRegistry> {
    cached = normalizeProjectRegistry(state);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cached, null, 2)}\n`, "utf-8");
    await rename(tmp, file);
    return cloneRegistry(cached);
  }

  async function write(state: ProjectRegistry): Promise<ProjectRegistry> {
    return serializeWrite(() => writeState(state));
  }

  async function patch(value: unknown): Promise<ProjectRegistry> {
    return serializeWrite(async () => writeState(applyProjectRegistryPatch(await read(), value)));
  }

  async function createProject(input: unknown): Promise<{ registry: ProjectRegistry; project: Project }> {
    const source = isRecord(input) ? input : {};
    return serializeWrite(async () => {
      const current = await read();
      const now = new Date().toISOString();
      // Delegate field cleanup to the normalizer (writeState re-normalizes on write
      // anyway); only override the fields a create must control.
      const project = normalizeProject({
        ...source,
        id: randomUUID(),
        workstreamIds: [],
        createdAt: now,
        updatedAt: now,
        archived: undefined,
      })!;
      const registry = await writeState({ ...current, projects: [...current.projects, project] });
      return { registry, project: registry.projects.find((item) => item.id === project.id)! };
    });
  }

  async function updateProject(
    id: string,
    patchValue: unknown,
  ): Promise<{ registry: ProjectRegistry; project: Project } | undefined> {
    const source = isRecord(patchValue) ? patchValue : {};
    return serializeWrite(async () => {
      const current = await read();
      const index = current.projects.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const updated: Project = { ...current.projects[index] };
      if (typeof source.name === "string") updated.name = source.name.trim();
      if ("description" in source) {
        if (typeof source.description === "string" && source.description.trim()) {
          updated.description = source.description.trim();
        } else {
          delete updated.description;
        }
      }
      if ("roots" in source) updated.roots = normalizeRoots(source.roots);
      if ("workstreamIds" in source) updated.workstreamIds = normalizeStringArray(source.workstreamIds);
      if ("dod" in source) {
        const dod = normalizeDoD(source.dod);
        if (dod) updated.dod = dod;
        else delete updated.dod;
      }
      if ("archived" in source) {
        if (source.archived === true) updated.archived = true;
        else delete updated.archived;
      }
      updated.updatedAt = new Date().toISOString();
      const projects = [...current.projects];
      projects[index] = updated;
      const registry = await writeState({ ...current, projects });
      return { registry, project: registry.projects.find((item) => item.id === id)! };
    });
  }

  async function deleteProject(id: string): Promise<{ registry: ProjectRegistry } | undefined> {
    return serializeWrite(async () => {
      const current = await read();
      if (!current.projects.some((item) => item.id === id)) return undefined;
      const registry = await writeState({
        ...current,
        projects: current.projects.filter((item) => item.id !== id),
        workstreams: current.workstreams.filter((item) => item.projectId !== id),
      });
      return { registry };
    });
  }

  async function createWorkstream(
    projectId: string,
    input: unknown,
  ): Promise<{ registry: ProjectRegistry; workstream: Workstream } | undefined> {
    const source = isRecord(input) ? input : {};
    return serializeWrite(async () => {
      const current = await read();
      if (!current.projects.some((item) => item.id === projectId)) return undefined;
      const now = new Date().toISOString();
      // Delegate field cleanup to the normalizer; only override create-controlled
      // fields and default `order` to the sequential append position.
      const workstream = normalizeWorkstream({
        ...source,
        id: randomUUID(),
        projectId,
        createdAt: now,
        updatedAt: now,
      })!;
      if (finiteNumber(source.order) == null) {
        workstream.order = current.workstreams.filter((item) => item.projectId === projectId).length;
      }
      // Stamp `loopStartedAt` the moment a workstream is first marked `isLoop` with no
      // explicit start supplied, so the S11 "elapsed from loopStartedAt" badge has the
      // stored field its formula depends on (else every loop renders "∞ looping 0m" and
      // the CLOSE_TAB_LOOP_MIN threshold can never trip). Honors an explicit value.
      if (workstream.isLoop && !workstream.loopStartedAt) {
        workstream.loopStartedAt = now;
      }
      const registry = await writeState({
        ...current,
        workstreams: [...current.workstreams, workstream],
      });
      return { registry, workstream: registry.workstreams.find((item) => item.id === workstream.id)! };
    });
  }

  async function updateWorkstream(
    id: string,
    patchValue: unknown,
  ): Promise<{ registry: ProjectRegistry; workstream: Workstream } | undefined> {
    const source = isRecord(patchValue) ? patchValue : {};
    return serializeWrite(async () => {
      const current = await read();
      const index = current.workstreams.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const updated: Workstream = { ...current.workstreams[index] };
      if (typeof source.name === "string") updated.name = source.name.trim();
      if ("description" in source) {
        if (typeof source.description === "string" && source.description.trim()) {
          updated.description = source.description.trim();
        } else {
          delete updated.description;
        }
      }
      if ("status" in source) updated.status = normalizeStatus(source.status);
      if ("sessionIds" in source) updated.sessionIds = normalizeStringArray(source.sessionIds);
      if ("matchCwd" in source) {
        if (typeof source.matchCwd === "string" && source.matchCwd.trim()) {
          updated.matchCwd = resolve(source.matchCwd.trim());
        } else {
          delete updated.matchCwd;
        }
      }
      if ("dod" in source) {
        const dod = normalizeDoD(source.dod);
        if (dod) updated.dod = dod;
        else delete updated.dod;
      }
      const order = finiteNumber(source.order);
      if (order != null) updated.order = order;
      if ("isLoop" in source) {
        if (source.isLoop === true) {
          updated.isLoop = true;
        } else {
          // Clearing the loop drops its start stamp too (unless the same patch sets one
          // explicitly below) — a non-loop workstream carrying a stale loopStartedAt is an
          // inconsistency the S11 elapsed badge would read as a phantom running loop.
          delete updated.isLoop;
          delete updated.loopStartedAt;
        }
      }
      if ("loopStartedAt" in source) {
        if (typeof source.loopStartedAt === "string" && source.loopStartedAt.trim()) {
          updated.loopStartedAt = source.loopStartedAt.trim();
        } else {
          delete updated.loopStartedAt;
        }
      }
      if ("budget" in source) {
        const budget = normalizeBudget(source.budget);
        if (budget) updated.budget = budget;
        else delete updated.budget;
      }
      if ("paused" in source) {
        if (source.paused === true) updated.paused = true;
        else delete updated.paused;
      }
      if ("archived" in source) {
        if (source.archived === true) updated.archived = true;
        else delete updated.archived;
      }
      updated.updatedAt = new Date().toISOString();
      // Default `loopStartedAt` to now() whenever the workstream is (now) a loop but has
      // no start stamp — covers both `isLoop` flipping true on this patch and a loop that
      // never had one. Without it `elapsedMinFromLoopStart('')` returns undefined and the
      // S11 loop badge is permanently "∞ looping 0m" (review finding). An explicit
      // loopStartedAt in the patch wins; clearing isLoop drops the stamp via its branch above.
      if (updated.isLoop && !updated.loopStartedAt) {
        updated.loopStartedAt = updated.updatedAt;
      }
      const workstreams = [...current.workstreams];
      workstreams[index] = updated;
      const registry = await writeState({ ...current, workstreams });
      return { registry, workstream: registry.workstreams.find((item) => item.id === id)! };
    });
  }

  async function setWorkstreamSessions(
    id: string,
    sessionIds: unknown,
  ): Promise<{ registry: ProjectRegistry; workstream: Workstream } | undefined> {
    return serializeWrite(async () => {
      const current = await read();
      const index = current.workstreams.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const updated: Workstream = {
        ...current.workstreams[index],
        sessionIds: normalizeStringArray(sessionIds),
        updatedAt: new Date().toISOString(),
      };
      const workstreams = [...current.workstreams];
      workstreams[index] = updated;
      const registry = await writeState({ ...current, workstreams });
      return { registry, workstream: registry.workstreams.find((item) => item.id === id)! };
    });
  }

  // Remove a workstream entirely: drop it from the workstreams list AND dereference
  // its id from the owning project's `workstreamIds` (writeState re-derives the list,
  // but we stamp the owner's updatedAt so the change is observable). Returns undefined
  // for an unknown id (the route maps that to 404) so the registry is left untouched.
  async function deleteWorkstream(
    id: string,
  ): Promise<{ registry: ProjectRegistry; projectId: string } | undefined> {
    return serializeWrite(async () => {
      const current = await read();
      const target = current.workstreams.find((item) => item.id === id);
      if (!target) return undefined;
      const projects = current.projects.map((project) =>
        project.workstreamIds.includes(id)
          ? {
              ...project,
              workstreamIds: project.workstreamIds.filter((wsId) => wsId !== id),
              updatedAt: new Date().toISOString(),
            }
          : project,
      );
      const registry = await writeState({
        ...current,
        projects,
        workstreams: current.workstreams.filter((item) => item.id !== id),
      });
      return { registry, projectId: target.projectId };
    });
  }

  async function setWorkstreamDoD(
    id: string,
    criteria: unknown,
  ): Promise<{ registry: ProjectRegistry; workstream: Workstream } | undefined> {
    return serializeWrite(async () => {
      const current = await read();
      const index = current.workstreams.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const updated: Workstream = {
        ...current.workstreams[index],
        dod: normalizeDoD({ criteria }) ?? { criteria: [] },
        updatedAt: new Date().toISOString(),
      };
      const workstreams = [...current.workstreams];
      workstreams[index] = updated;
      const registry = await writeState({ ...current, workstreams });
      return { registry, workstream: registry.workstreams.find((item) => item.id === id)! };
    });
  }

  // Flips the stored boolean of a `kind:"manual"` criterion (project- or
  // workstream-level). Throws RegistryError("not_found") for an unknown id and
  // RegistryError("not_manual") for a non-manual criterion — the registry is
  // left unchanged in both cases (we throw before any write).
  async function toggleManualCriterion(
    criterionId: string,
    met: boolean,
  ): Promise<{ registry: ProjectRegistry; criterion: DoDCriterion }> {
    return serializeWrite(async () => {
      const current = await read();
      const found = findCriterionWithOwner(current, criterionId);
      if (!found) {
        throw new RegistryError(`No DoD criterion with id ${criterionId}`, "not_found");
      }
      if (found.criterion.source.kind !== "manual") {
        throw new RegistryError(`Criterion ${criterionId} is not a manual criterion`, "not_manual");
      }
      found.criterion.met = met === true;
      found.owner.updatedAt = new Date().toISOString();
      const registry = await writeState(current);
      return { registry, criterion: findCriterionWithOwner(registry, criterionId)!.criterion };
    });
  }

  return {
    file,
    read,
    write,
    patch,
    createProject,
    updateProject,
    deleteProject,
    createWorkstream,
    updateWorkstream,
    setWorkstreamSessions,
    setWorkstreamDoD,
    deleteWorkstream,
    toggleManualCriterion,
  };
}

export type ProjectRegistryStore = ReturnType<typeof createProjectRegistryStore>;
