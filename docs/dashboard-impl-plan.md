# Project Rollups — Master Implementation & Test Plan

**Branch:** `dashboard-design`  ·  **Status:** authoritative (merges the backend, frontend, test-architecture, and risk/sequencing expert plans into one)

**Source of truth.** Render logic: `docs/dashboard-designs-final/index.html`. Contract: `docs/dashboard-designs-final/DATA-MODEL-AND-API.md`. Validated visual states: `docs/dashboard-designs-final/scn-*.png` + `state-*.png`. Every line/file pointer below is verified against the current `dashboard-design` branch.

---

## 0. Architecture overview

Project Rollups is an agent-oversight surface that aggregates live pi sessions into **Project → Workstream → Session** rollups, scored against a per-workstream/per-project **Definition of Done (DoD)** and rendered as honest k-of-n progress rings with a "needs-you" triage feed, sign-off list, and drill-in.

Five design pillars, each de-risking a verified fragility in the codebase:

1. **Pure, server+client-shared compute modules.** All derivation (progress formula, status, git-DoD, join) lives in dependency-injected modules under `server/rollups/*` with **zero imports from `server.ts`**, so it unit-tests in-process (no subprocess) — mirroring the `tests/git-diff.test.ts` precedent of importing a module directly. The wired `/api/*` surface and realtime are proven with the existing subprocess harness (`tests/api.test.ts`).

2. **Adapter-at-the-seam frontend port.** `docs/dashboard-designs-final/index.html` renders a *fixture* shape and derives `_prog/_gate/_mixed/_sessGauge` in `enrich(data)` (L1510) at `loadScenario` (L1531). The spec's `/api/rollups` returns `ProjectRollup[]` with `progress` **already computed server-side** and structured `source.kind` on criteria. We port by inserting **one adapter** (`rollupAdapter.ts`) at the `loadScenario` seam that maps each rollup back onto the fixture field names the renderer already reads — keeping `segArcs`/`ringSvg`/`renderCard`/`renderSession`/`byAttention` nearly byte-for-byte. This is the single highest-leverage decision and it dictates slice order.

3. **Bounded git fan-out.** `isGitRepo` (`server.ts` L210) and `gitStatus` (L283, ~6 subprocess spawns) are uncached; `git_merged` needs a net-new `merge-base --is-ancestor`. `/api/rollups` evaluates each **distinct repo root once** through a per-root TTL cache and **never runs `command` DoD on render**. Gate B enforces a latency budget.

4. **Honest degradation is a hard quality bar, not a nicety.** No fabricated amber `block` without structured elicitation; a non-elicited idle stop is a quiet "may be waiting", never an alarm; never-run/stale `command` criteria asterisk the ring and block sign-off promotion; sign-off ≠ merge (no fused "Sign off & merge" button); loop telemetry that needs net-new pi plumbing renders only in a muted "proposed" band. These rules live in `progress`/`status`/`badge`/`cardLive` and must survive the fixture→real-data port verbatim.

5. **Purely additive integration.** New controller, new overlay element, new statusBar toggle, new CSS module, optional realtime branches. `requiredElement` (`src/app/elements.ts` L64) throws if the HTML node is missing, which forces `index.html` + `elements.ts` to land together. The full existing test suite is the regression gate.

### Module map (canonical naming — resolves cross-plan divergence)

**Backend (pure, unit-testable):**
- `server/rollups/types.ts` — stored entities + view models (§3 of DATA-MODEL).
- `server/rollups/registry.ts` — `createProjectRegistryStore(file)` (verbatim copy of `createSessionUiStateStore`).
- `server/rollups/progress.ts` — `computeProgress`, `critUnrun`, `critStale`, `critGit`, `rootScoped`.
- `server/rollups/status.ts` — `deriveStatus` / `deriveUiStatus` / `toWorkItemStatus`.
- `server/rollups/gitDod.ts` — `gitIsAncestor`, `evalGitCriterion`.
- `server/rollups/rollup.ts` — `mapSessionsToProjects`, `joinRollups`, `assembleRollups`.

**Backend (wired):** edits to `server.ts` — store wiring, routes, `merge-base` helper + `cachedGitStatus` TTL cache, command runner, realtime debounce.

**Frontend:** `src/dashboard/dashboard.ts` (controller), `src/dashboard/rollupAdapter.ts` (the seam), `src/dashboard/render.ts` (ported render fns), `src/dashboard/types.ts` (client mirror of view models), `src/styles/dashboard.css` (scoped). Edits to `index.html`, `src/app/elements.ts`, `src/app/icons.ts`, `src/main.ts`, `src/realtime/realtime.ts`, `src/sessions/sessionDrawer.ts`.

### Grounding pointers (verified against `dashboard-design`)
- Store template: `server/sessionUiState.ts` `createSessionUiStateStore` L151–226 (`serializeWrite` L155, `read` L161, atomic `*.tmp`+`rename` `writeState` L174). **Copy verbatim.**
- Store wiring: `server.ts` L1240–1241 (`settingsStore`, `sessionUiStateStore` via `join(getAgentDir(), …)`).
- HTTP helpers: `sendJson(res,status,value)` L81, `readBody(req)` L111 (**bare `JSON.parse` — throws on malformed; every handler must try/catch**), `isAuthorized` L107, `unauthorized` L96.
- Route dispatch: `createServer` L2141; `/api/` gate L2146; auth gate L2151; **every existing route is exact `url.pathname === "…"`** — dynamic ids parsed by hand (`pathname.startsWith(…)+slice`, like `serveArtifact` L122/L126). Session-ui-state handlers end ~L2413/2421; new routes insert there, before `/api/sessions/delete` (L2423).
- Git: `gitStatus(cwd,fetchRemote)` L283 → `{ok,isRepo,root,branch,upstream,defaultRemoteBranch,ahead,behind,files[]}`; `git(args,timeout,cwd)` L193; `isGitRepo` L210; `gitLog` L425. **No `merge-base` helper, no `executeBash` — both net-new.**
- Sessions: `listSessionInfos(extraCwds)` L879 → `simplifySessionInfo` L857 → `runtimeForPath` L795 (`{loaded,isRunning,isStreaming,isCompacting,startedAt,lastActivityAt,pendingMessageCount,model}`); `findSessionInfoById` L1161; `sessionCwd` L745; `applySessionUnreadState` L871.
- Realtime: `broadcast(value)` L1288 → `recordRealtimeMessage` L1281 (seq envelope, 1000-event replay). Live subscription broadcasts `pi_event`+`session_runtime_changed` L1962–1968, `session_stats_changed` L1976 — the canonical dirty-mark hook. Client switch `src/realtime/realtime.ts` `connect()` L313–426 **silently ignores unknown `data.type`** (new envelopes are wire-safe before the UI consumes them); `extension_ui_request` already handled L395.
- Mockup math: `computeProgress` L951–964, `critUnrun` L915, `critGit` L924, `critStale` L925–938, `rootScoped` L950, `STATUS_RANK` L908/byAttention L910, `sessFamily`/mixed L1571–1589, `sessionDone` L1569, `isNeed`/`isSoftWait` L1546–1547, `enrich` L1510, `loadScenario` L1531, render fns L1594–2862.
- Test harness: `tests/api.test.ts` L72–82 spawns `node --import tsx server.ts` with `PI_WEB_MOCK=1,PI_WEB_DEV=1,PORT,PI_WEB_TOKEN="",PI_WEB_SETTINGS_FILE,PI_WEB_SESSION_UI_STATE_FILE`; `waitForServer` polls `/api/state`; `initGitRepo` L39–42; temp git workspace L412–459; WS client L829–862. Add **`PI_WEB_PROJECTS_FILE`** for registry isolation.
- Supervisor restart: `POST /api/restart` / `supervisor.ts` L135. `server.ts`/`server/*` are **not** Vite-HMR'd — every backend slice needs a restart.

### Tech-lead decisions (resolve the four plans' open items)
- **Naming.** Backend compute under `server/rollups/*` (split for testability — the DoD demands per-branch unit tests). Frontend under `src/dashboard/*`. Tests `tests/rollups-*.test.ts` + `tests/e2e/rollups-dashboard.spec.ts`.
- **`SessionRollup` carries BOTH `status: WorkItemStatus` (5-value canonical) AND `uiStatus` (9 render-states: run/loop/sign/merge/block/fail/queued/planned/unset)** so the ported `STATUS_RANK`/badge logic has its input without lossy collapse.
- **Manual-criterion truth = a `met?: boolean` on the stored `DoDCriterion`, guarded to `source.kind==="manual"` only** in normalize. (Simpler than a separate map.)
- **`command` DoD is opt-in** behind `PI_WEB_ALLOW_DOD_COMMANDS=1`, on-demand-only (`POST /api/dod/evaluate`), **never on the rollup render path**, time-bounded + cwd-allowlisted. Default off → criterion renders `unrun` ("command DoD disabled").
- **Client trusts the server `ProgressSnapshot`; it does NOT re-derive on render.** A small client `computeProgress` copy exists only for *optimistic* recompute after a sign-off toggle. This sidesteps the Vite/tsconfig cross-boundary import risk entirely (no `server/rollups/*` value-import from `src/`).
- **View shape = full-screen overlay** (a `[data-testid="rollup-dashboard"]` container layered above `main.app`, its own scroll, does not unmount chat DOM), **opened via a statusBar toggle**, NOT auto-default-landing in v1 (auto-open is deferred decision B). This honors the frontend plan's UX and the risk plan's "off-by-default, lowest-regression" stance.
- **Env vars:** `PI_WEB_PROJECTS_FILE` (registry isolation), `PI_WEB_GIT_CACHE_TTL_MS` (default 3000, tuned at Gate B), `PI_WEB_ROLLUP_DEBOUNCE_MS` (default 500), `PI_WEB_ALLOW_DOD_COMMANDS`.
- **`rollup_changed` payload is `{projectId}` id-only; client refetches** (idempotent, replay-safe).
- **Session→project mapping:** explicit `workstream.sessionIds` wins, then longest `roots`/`matchCwd` cwd-prefix; unmatched sessions go to an `unassigned` bucket (not crammed into a default project); forks (`parentSessionPath`) are not auto-grouped in v1.

---

## 1. Slice order (overview)

Sequenced **safest-first**: backend store + rollups proven by unit/curl → frontend read-only render → interactions → realtime → DoD evaluation. Everything before S4 is provable with `curl`/vitest at **zero UX risk**. First visible milestone is **S5**.

| # | Slice | Visible? | Phase | Gate |
|---|---|---|---|---|
| S0 | Shared types + `merge-base` helper + repo-status TTL cache | no | backend | typecheck |
| S1 | `ProjectRegistry` store + `PI_WEB_PROJECTS_FILE` | no | backend | **A** |
| S2 | `/api/projects` + `/api/workstreams` CRUD + `project_registry_changed` | no | backend | **A** |
| S3 | **`GET /api/rollups`** — pure compute modules + endpoint | no | backend | **B (key)** |
| S4 | Frontend scaffold (overlay, button, css, wiring, empty render) | yes (shell) | render | **C** |
| S5 | **Read-only render core** (port via adapter, buttons disabled) | **YES (1st milestone)** | render | **D** |
| S6 | Drill-in + "Continue the conversation" → REAL session | yes | interactions | **E** |
| S7 | Quick-reply chips + manual sign-off (optimistic) + recheck stub | yes | interactions | **E** |
| S8 | Debounced `rollup_changed` realtime (server) + client consumption | yes | realtime | **F** |
| S9 | Cold-start "needs setup" + onboarding | yes | dod | **G** |
| S10 | `POST /api/dod/evaluate` (command DoD, sandboxed) + DoD authoring drawer | yes | dod | **H (security)** |
| S11 | Loop "proposed" band + merge affordance (degraded-but-honest) | yes | polish | **I** |

---

## 2. Implementation slices (ordered, safest-first)

### S0 — Shared types, `git_merged` helper, repo-status TTL cache
**Files (add):** `server/rollups/types.ts` (§3 stored + view-model types: `WorkItemStatus`, `DoDSource`, `Provenance`, `DoDCriterion` incl. stored `met?: boolean`, `DoD`, `Project`, `Workstream`, `ProjectRegistry`, computed `CriterionEval`, `ProgressSnapshot`, `SessionRollup` incl. `status`+`uiStatus`, `WorkstreamRollup`, `ProjectRollup`, `ArtifactReceipt`), `src/dashboard/types.ts` (frontend mirror of the view models that cross the wire; reuses `SessionInfo["runtime"]` from `src/app/types.ts` — **add `model?: string` to that runtime type**, since `simplifySessionInfo` attaches it but `src/app/types.ts` L209 lacks it).
**Files (edit):** `server.ts` near git helpers (after `gitCommitDetails` ~L453): `async function gitIsAncestor(ancestor, into, cwd)` → `git(["merge-base","--is-ancestor", ancestor, into], 15_000, cwd)` returns `true` on exit 0, `false` when `error.code===1`, rethrow otherwise; `const repoStatusCache = new Map<string,{at,value}>()` + `async function cachedGitStatus(cwd, ttlMs = Number(process.env.PI_WEB_GIT_CACHE_TTL_MS)||3000)` wrapping `gitStatus`. Invalidate a root on `/api/git/sync` (L2271) and on `pi_event(agent_end)` for that cwd.
**Work:** Purely additive helpers + types. No routes, no runtime behavior change.
**Acceptance:** `npm run typecheck` clean; `cachedGitStatus` returns the identical shape to `gitStatus`; a second call within TTL spawns no git process; `gitIsAncestor` true after a merge, false before, never throws on exit 1.
**Test:** `tests/rollups-gitdod.test.ts` (seed, begun here) — temp repo via `initGitRepo`; commit on `feat/x`, merge into `main`, assert `gitIsAncestor` semantics; a cache micro-bench (2nd–5th `cachedGitStatus` faster than 1st).
**Gate:** typecheck clean.

### S1 — `ProjectRegistry` store
**Files (add):** `server/rollups/registry.ts` — **copy `createSessionUiStateStore` (`server/sessionUiState.ts` L151–226) verbatim** → `createProjectRegistryStore(file)`: same `cached`, `serializeWrite` queue, atomic `${file}.${process.pid}.${Date.now()}.tmp`+`rename` (L174–181), `read`/`write`/`patch` (ENOENT/garbage → default, L165–169). Replace normalizers with `normalizeDoDSource` (validates the 6 `kind` discriminants + required fields — `git_merged` needs `into:string`, `command` needs `cwd`+`cmd`), `normalizeDoDCriterion` (`id` via `randomUUID()`, `text`, `source`, `authoredBy?`, `gate?`, `weight?` default 1 clamped ≥0, `met?` **kept only when `source.kind==="manual"`**), `normalizeDoD`, `normalizeProject` (`id`, `name`, `roots` each `resolve()`+de-dup, `workstreamIds`, `dod?`, ISO `createdAt`/`updatedAt`, `archived?`), `normalizeWorkstream` (incl. `isLoop`/`loopStartedAt`/`budget`/`paused`/`matchCwd`/`order`), `normalizeProjectRegistry` (version:1, dedupe by id, drop workstreams whose `projectId` has no project, re-derive `workstreamIds`). Domain mutators (each `serializeWrite`-wrapped, stamping `updatedAt`): `createProject`, `updateProject`, `deleteProject` (drops its workstreams), `createWorkstream`, `updateWorkstream`, `setWorkstreamSessions`, `setWorkstreamDoD`, `toggleManualCriterion(criterionId, met)` (flips only if `source.kind==="manual"`, else throws).
**Files (edit):** `server.ts` L1241-area: `const projectRegistryStore = createProjectRegistryStore(process.env.PI_WEB_PROJECTS_FILE || join(getAgentDir(), "pi-web-projects.json"))`. **Land the env override before writing the test** (mirrors `PI_WEB_SESSION_UI_STATE_FILE` so vitest never clobbers the real `~/.pi/agent/pi-web-projects.json`).
**Work:** Store only; no routes.
**Acceptance:** missing file → `{version:1,projects:[],workstreams:[]}`; malformed disk JSON falls back without throwing; manual `met` survives round-trip, `command`/`git_*` never persist a computed `met`; orphan-workstream pruning; writes atomic (no `*.tmp` left) + serialized.
**Test:** `tests/rollups-registry.test.ts` (direct import, `mkdtemp`, no server): read-missing→default; `patch` with dupes+garbage→normalized/deduped; `readdir` after write contains only the final file; `await Promise.all([...50 patches])` → final `read` valid + `JSON.parse(readFile)` never throws; manual-toggle accept + non-manual reject.
**Gate A:** registry CRUD round-trips; atomic write verified; **`tests/api.test.ts` session-ui-state cases still pass** (proves the verbatim copy didn't disturb the original store).

### S2 — Project/Workstream CRUD routes + registry realtime
**Files (edit):** `server.ts` — insert one block after the session-ui-state handlers (~L2413, before `/api/sessions/delete` L2423), following the exact `if (method === … && url.pathname === …)` style. Add `const seg = url.pathname.split("/").filter(Boolean)` for `:id` parsing (guard against `/`, like `serveArtifact` L126). **Every handler wraps `readBody` in try/catch → `sendJson(res,400,…)`** (it bare-`JSON.parse`s). Routes, each → `sendJson` + `broadcast({type:"project_registry_changed"})` on mutation:
- `GET /api/projects` → `{ok, registry}` (raw `read()`, no rollup compute).
- `POST /api/projects` → validate `name`+`roots[]`; 201.
- `PATCH /api/projects/:id`, `DELETE /api/projects/:id` (404 unknown).
- `POST /api/projects/:id/workstreams` → 201.
- `PATCH /api/workstreams/:id`, `PUT /api/workstreams/:id/sessions`, `PUT /api/workstreams/:id/dod`.
- `PATCH /api/dod/criterion/:id` → `toggleManualCriterion(id, body.met)`; non-manual → 400.
Auth honored automatically (sits after `isAuthorized` gate L2151).
**Work:** CRUD + validation + one realtime envelope. No DoD evaluation.
**Acceptance:** all routes correct status codes; `roots` resolved absolute; deleting a project drops its workstreams; bad body → 400 not 500; each mutation emits exactly one `project_registry_changed`; non-manual criterion toggle → 400 registry unchanged.
**Test:** `tests/rollups-api.test.ts` (subprocess, `PI_WEB_MOCK=1`+temp `PI_WEB_PROJECTS_FILE`; WS client drains envelopes). Lifecycle: create project → create workstream → set DoD (one `manual`, one `git_clean`) → toggle manual (200) → toggle git (400) → attach sessionIds → delete; assert each `project_registry_changed`; malformed body → 400; with `PI_WEB_TOKEN` set, unauth'd → 401.
**Gate A.**

### S3 — `GET /api/rollups` (the key slice)
**Files (add):**
- `server/rollups/progress.ts` — port `computeProgress` + `critUnrun`/`critStale`/`critGit`/`rootScoped` from `index.html` L915–964 **exactly**: `evaluable = !gate && !rootScoped` (`rootScoped = source.kind==="git_clean"`), `run = !unrun`, `percent = round(metWeight/totalWeight*100)`, `allMet = run.length>0 && metW===totW && unrun===0 && stale===0`. `git_merged` met is **permanent (never stale, L933)**. Keys families/unrun/stale off **structured `source.kind`**, not substring `srcFamily`.
- `server/rollups/status.ts` — `deriveUiStatus({runtime, git, progress, pendingGate, elicitation, fail})` → 9 render-states; `toWorkItemStatus(uiStatus)` collapses to 5. **Block honesty:** `block` only from git `conflicted` OR tool error/abnormal end AND only counts as a hard "need" when `elicitation` present (`isNeed` L1546); a non-elicited idle stop degrades to soft "may be waiting" (`isSoftWait` L1547), never amber. `signPending` flagged when a `sign` rests on unrun/stale evidence (L967).
- `server/rollups/gitDod.ts` — `evalGitCriterion(criterion, cwd)` → `CriterionEval`: `git_clean` met iff `cachedGitStatus().files.length===0`; `git_ahead_zero` met iff `ahead===0 && upstream!==""`; `git_merged` met iff `gitIsAncestor(branch, into, root)`; any file `label==="conflicted"` ⇒ `git.conflicted=true`. `command` excluded inline (marked `unrun` unless a cached `evaluatedAt` exists). `evaluatedAt` stamped.
- `server/rollups/rollup.ts` — `mapSessionsToProjects(registry, sessions)` (explicit `sessionIds` ∪ `matchCwd` longest-prefix → workstream; else longest `roots` prefix → project; else `unassigned`); `buildSessionRollup`/`buildWorkstreamRollup` (mixed family → `sessionGauge` k-of-n + `progress:null`, L1518–1527) / `buildProjectRollup` (+`counts: Record<WorkItemStatus,number>`, `activeSessionCount`, `lineage` when a root nests under another project's root); `joinRollups(registry, sessionInfos, evalCtx)` / `assembleRollups`.
**Files (edit):** `server.ts` — `GET /api/rollups` and `GET /api/rollups/:projectId` near the S2 routes. Reads `projectRegistryStore.read()` + `applySessionUnreadState(await listSessionInfos(), await sessionUiStateStore.read())`; evaluates each **distinct root once** via `cachedGitStatus`; manual=stored `met`; git=inline; `command`=excluded; `runtime` straight off `simplifySessionInfo`. Must work in `mockMode` (`listSessionInfos` → `mockSessions`). **Never throws on a messy session** — default every optional field (mirror `simplifySessionInfo` defaults). Returns `{ok:true, rollups: ProjectRollup[]}`; unknown projectId → 404.
**Work:** Join + evaluate + aggregate; command criteria never spawn here.
**Acceptance:** `computeProgress` matches the mockup byte-for-byte on the §5.2 cases (never-run command excluded from denominator; stale blocks `allMet`; `git_clean` excluded from per-session %; weights honored; gate excluded but doesn't block `allMet`); a 2-root project issues **one** `gitStatus` per root (call-counter assert), not one per session; `git_merged` true once `feat/x` is an ancestor of `main`, false before, stays true after later commits; mixed-source workstream → `progress:null`+`sessionGauge`; messy session → 200, no throw.
**Test:** (a) **pure** `tests/rollups-progress.test.ts` (~12 table cases), `tests/rollups-status.test.ts` (~8 cases), `tests/rollups-join.test.ts` (nested-root resolves to its OWN project + `lineage`; explicit-sessionIds override; mixed→gauge; counts sum; unmatched omitted) — all direct imports, fast, no server. (b) `tests/rollups-gitdod.test.ts` against real temp repos. (c) extend `tests/rollups-api.test.ts`: temp git repos, register a project on those roots, `GET /api/rollups`, assert git criteria evaluate + the TTL cache collapses duplicate `gitStatus` calls; dirty a repo, re-GET, assert `git_clean` flips and percent drops; add a `command` criterion → `unrun`, excluded; messy-session case.
**Gate B (hard):** correctness above **plus** a fan-out latency budget — `GET /api/rollups` across ≥3 repo roots completes under ~1.5s in CI mock and the cache demonstrably collapses repeat git spawns. **No UI work starts until B passes.** Tune `PI_WEB_GIT_CACHE_TTL_MS` here if needed.

### S4 — Frontend scaffold (overlay shell, button, css, wiring, empty render)
**Files (add):** `src/dashboard/dashboard.ts` (skeleton controller), `src/styles/dashboard.css`.
**Files (edit):** `index.html` — `<button id="dashboardButton" class="iconButton statusBarButton">` in `#statusBar` (after L26) + `<div id="dashboardBackdrop" hidden></div>` and `<section id="dashboardView" data-testid="rollup-dashboard" hidden><div class="wrap" id="dashboardWrap"></div></section>` inside `main.app` (full-viewport overlay, own scroll, z-index above composer, does NOT unmount `#messages`/composer). `src/app/elements.ts` — add `dashboardButton`/`dashboardView`/`dashboardBackdrop`/`dashboardWrap` to `AppElements` + `getAppElements()` via `requiredElement` (forces HTML to land together). `src/app/icons.ts` — import `LayoutDashboard`, add `"layout-dashboard": LayoutDashboard` to the `iconNodes` allowlist. `src/main.ts` — `setIcon(elements.dashboardButton,"layout-dashboard")` in `initStaticIcons()` (L127); build `dashboard = createDashboard({state, elements, api, sessions, addMessage: messages.addMessage})` after `sessions` (L167); `dashboard.init()`; button click → `dashboard.open`; backdrop/ESC → `dashboard.close`; keyboard shortcut `mod+h` via `initKeyboardShortcuts` (L235). **`src/styles/dashboard.css`** — port the mockup `<style>` (L8–776) `:root` tokens + `.hero/.rail/.needs/.pcard/.rings/.ring*/.badge/.dotstrip/.soff/.toast/.onboard`, **all scoped under `#dashboardView`** so global `button{}`/`*{box-sizing}` can't leak.
**Controller contract:**
```ts
export type DashboardController = {
  init: () => void;
  open: () => void;     // fetch /api/rollups, render, reveal overlay
  close: () => void;    // hide overlay (keeps DOM)
  isOpen: () => boolean;
  applyRollupChange: (projectId?: string) => void; // debounced refetch on realtime
};
```
**Work:** `open()` sets `dashboardView.hidden=false`, fetches `/api/rollups`, renders Loading/error via `addMessage` on failure. Off by default behind the toggle.
**Acceptance:** clicking `#dashboardButton` reveals the overlay; a `/api/rollups` request fires (network visible); ESC/backdrop closes; closing returns to the live conversation untouched; sessions/git/settings panels still open; typecheck clean.
**Test:** `tests/e2e/rollups-dashboard.spec.ts` (Playwright, mock mode, `beforeEach POST /api/mock/reset`) — assert the button toggles `#dashboardView` visibility and a `/api/rollups` request is made. **agent-browser smoke:** open `http://localhost:8787`, click the button, screenshot the overlay.
**Gate C:** overlay toggles cleanly; zero regression to existing surfaces; three suites green.

### S5 — Read-only render core (port via adapter seam) — **FIRST VISIBLE MILESTONE**
**Files (add):** `src/dashboard/rollupAdapter.ts` (**the seam**), `src/dashboard/render.ts`.
**Files (edit):** `src/dashboard/dashboard.ts`.
**Work:** Lift the render functions from `index.html` with **minimal edits** into `render.ts`: `segArcs` L1594, `ringShape` L1615, `ringSvg` L1624, `badge` L1651, `srcTag`/`dodInline` L1657, `dotStrip` L1661, `projNeeds` L1676, `allUnset` L1682, `pClass` L1686, `cardLive` L1698, `wsDone`/`wsUnscorable`/`projGauge`/`longPole` L1724–1748, `byAttention` L908–910, section renderers `renderAll` L1764, `heroHtml`/`renderRail` L1923/2023, `needsSectionHtml`/`renderNeeds` L2054/2062, `signoffSectionHtml`/`renderSignoff` L2198/2216, `projectsSectionHtml`/`renderGrid`/`renderCard`/`renderWorkstream`/`renderSession` L2281–2696, `renderPlanned`/`renderDone` L2697/2737. `rollupAdapter.ts` `toViewModel(rollups: ProjectRollup[])` maps each `ProjectRollup`/`WorkstreamRollup`/`SessionRollup` back onto the fixture field names the renderers read (`source.kind→c.src`, `progress→s._prog`, `dod.criteria→s.crit`, `runtime`+`uiStatus`→status, `live/elicitation→chips/blast/loop/artifact/plannedQueue→queue` pass-through) and builds `state.SESS`. **Replace `srcFamily()`/`sessFamily()` substring matchers with structured `source.kind`.** Delete `loadScenario`/`SCENARIOS`/`enrich`/scenario `<select>`. **Do NOT re-derive progress** — trust the server `ProgressSnapshot`. Data entry: `state.data = toViewModel(await fetch('/api/rollups'))`. Render-stage DOM/test-id contract (load-bearing for the e2e matrix): `.pcard[data-project-id]`, `.ws[data-ws-id]`, `[data-open="<sessionId>"]`, `[data-reply="<sessionId>"][data-text]`, `[data-signoff="<critId>"]`, `[data-recheckcard="<sessionId>"]`, `#signAll`, `#focusBtn`, `[data-testid="needs-you"]`, `[data-testid="signoff"]`, `[data-testid="needs-setup"]`, `[data-testid="first-run"]`, `[data-testid="ring"][data-percent][data-asterisk]`. `lastDashboardVisitAt` (§5.6 delta) read from `GET /api/session-ui-state` on `open()` (deferred field — degrade gracefully if absent). Continue/sign-off buttons rendered **disabled** this slice (read-only).
**Acceptance:** with a real registry (one project, one workstream, manual DoD) the grid renders an honest k-of-n ring (e.g. `0/1`) matching server `progress`; hero/rail/needs/sign-off/done sections render from live data; the validated `scn-*` states still look right fed equivalent real data; messy real sessions render with no console errors; no fixture artifacts remain.
**Test:** `tests/e2e/rollups-dashboard.spec.ts` — seed via `POST /api/projects`+`PUT /api/workstreams/:id/dod`, open, assert a `.ring-num`/`[data-percent]` shows `0/1` and the project name appears; visual snapshot vs the validated mockup states. **agent-browser:** create a project, open dashboard, screenshot the grid + ring.
**Gate D:** render parity on validated scenarios; `typecheck`+`vitest`+`playwright` all green; sessions/git/settings unbroken.

### S6 — Drill-in + "Continue the conversation" → REAL session
**Files (edit):** `src/sessions/sessionDrawer.ts` — expose the internal `openSessionTab(sessionId, cwd)` (L911 — already does `POST /api/sessions/open` → `writeActiveSessionIdToUrl` → `refreshState` → `refreshMessages`) by adding `openSession: openSessionTab` to the `SessionsController` return (L1532) + its type (L8). `src/dashboard/dashboard.ts` — port the click delegation from `index.html` L3166–3213, scoped to `#dashboardView`: `data-toggle` (card/ws/grp expand-collapse), `data-jump` (scroll + auto-expand). **Override `data-open`** → look up `state.SESS[id]` for `cwd` → `dashboard.close()` then `await sessions.openSession(id, cwd)`. **Delete the mockup's synthetic `#conv`/`openSession`/`transcript` composer (L3059–3159) entirely** — the real composer is the landing target.
**Acceptance:** clicking Continue/Open/Review/Start on any session row closes the overlay and lands in that session's **real** conversation with the live composer focused and `?sessionId=` in the URL; card/workstream rows expand/collapse; jump-links scroll + auto-expand.
**Test:** e2e — open dashboard, click a session's Continue, assert `#dashboardView` hidden, `#prompt` present/focused, URL carries the session id. **agent-browser:** click Continue, confirm the conversation view with composer.
**Gate E:** drill-in + continue land in the real session; no destructive default action.

### S7 — Quick-reply chips + manual sign-off (optimistic) + recheck stub
**Files (edit):** `src/dashboard/dashboard.ts`.
**Work:** Quick-reply chips (`data-cfill`/`data-reply`) → `POST /api/prompt {sessionId, message: chipText}` (handler L2517, returns 202); on 202 show a toast and `await sessions.openSession(id,cwd)` (answering IS continuing). Sign-off: port `signOff`/`signOffAll`/`showToast` (L2249–2271); replace the fixture flip with `PATCH /api/dod/criterion/:id {met:true}` — **optimistic**: flip the gate locally + re-render `renderSignoff()` immediately, fire the PATCH, on failure revert + error toast; Undo sends the inverse PATCH. Keep "sign-off ≠ merge" copy — **never a fused "Sign off & merge"**. `recheckCard` (L2273) → `POST /api/dod/evaluate {criterionId}` **stub** (full eval in S10); show the neutral `_evaluating` pulsing ring.
**Acceptance:** Sign off optimistically flips the row to "✓ Signed off" + issues the PATCH; registry persists `met:true`; Undo reverts both UI and registry; gate excluded from percent (percent unaffected); a chip click POSTs `/api/prompt` (202) and opens the session; optimistic UI reconciles with the realtime echo without flicker.
**Test:** `tests/rollups-api.test.ts` — `PATCH /api/dod/criterion/:id` flips the stored boolean + persists. e2e — seed a sign-off-ready workstream, click Sign off, assert the row updates and `GET /api/rollups` shows the gate met; Undo reverts. **agent-browser:** drive sign-off + undo, screenshot the toast.
**Gate E.**

### S8 — Debounced `rollup_changed` realtime (server) + client consumption
**Files (edit):** `server.ts` — near `broadcast` (L1288): `dirtyProjectIds: Set<string>` + `rollupFlushTimer` + `markRollupDirty(sessionFileOrCwd)` (maps via `mapSessionsToProjects` against the cached registry → adds project ids; invalidates `repoStatusCache` for that root; schedules a single `setTimeout(flushRollupDirty, Number(process.env.PI_WEB_ROLLUP_DEBOUNCE_MS)||500)`, `.unref?.()`) + `flushRollupDirty` (`broadcast({type:"rollup_changed", projectId})` per dirty project, clears the set). Hook `markRollupDirty(eventSessionFile)` into the subscription **after L1968**, gated to durable events only: `agent_start`, `agent_end`, `compaction_end`, `tool_execution_end`, `message_end` — **NOT** `message_update`/`tool_execution_update`. Also mark dirty from the prompt `finally` (~L2561) and `/api/git/sync` (L2271). `src/realtime/realtime.ts` — add `projects/dashboard` to `createRealtime` options (L20), pass from `main.ts` (L208); in the `connect()` switch (L313–426): `project_registry_changed → dashboard.applyRollupChange()`, `rollup_changed → dashboard.applyRollupChange(data.projectId)`. `applyRollupChange` debounces 250ms (like `scheduleSessionRefresh` L87) and **only refetches when `dashboard.isOpen()`**. Confirm `message_update`/`tool_execution_update` are NOT consumed by the dashboard.
**Acceptance:** a 30-tool-call streaming session emits **zero** `rollup_changed` until a terminal event, then **one** coalesced envelope per project within the debounce window; editing a project DoD emits `project_registry_changed` immediately AND schedules one `rollup_changed{projectId}`; envelopes carry a monotonic `seq` and replay on reconnect; existing `/ws` consumers (sessions/git/settings) unaffected; a chatty session never repaints the grid.
**Test:** `tests/rollups-realtime.test.ts` (WS client) — fire a mock prompt that streams + ends, assert `rollup_changed` count ≤1 within a window after `agent_end` and that interim `pi_event` floods did not each produce one; a registry POST → exactly one `project_registry_changed`; reconnect `?lastSeq=` replays the missed envelope. e2e (two contexts) — PATCH a criterion from tab B, assert tab A's ring updates within the debounce window.
**Gate F:** chatty session ≤1 debounced `rollup_changed`; existing consumers unaffected; seq/replay intact.

### S9 — Cold-start "needs setup" + onboarding
**Files (edit):** `src/dashboard/dashboard.ts`; optionally `server.ts` (`GET /api/projects/candidates` returning `Array.from(knownCwds)`).
**Work:** Port `onboardHtml`/`bindOnboard` (L2790–2862) for an empty registry (`/api/projects` → `[]`): "Register a project" → `POST /api/projects` with candidate roots from `knownCwds` (via the new `/api/projects/candidates`, or derive client-side from `/api/sessions`). Port the `needsSetup` path: `allUnset(p)` (L1682) → purple "?" needs-setup group + hero `em.setup` CTA (L1946) + `.pill.setup`; hero CTA `data-jump="sec-setup"` scrolls to the group. No fabricated percent for unset projects.
**Acceptance:** fresh install (no `pi-web-projects.json`) shows the onboarding card with candidate cwds; registering re-renders into the grid in a `needs-setup` state (purple "?" ring, no percent); hero reads "N projects need setup".
**Test:** e2e against an empty `PI_WEB_PROJECTS_FILE` — assert onboarding renders, register, assert the needs-setup group appears. **agent-browser:** screenshot cold-start → register → needs-setup.
**Gate G:** cold-start + needs-setup honest; no fabricated percent.

### S10 — `POST /api/dod/evaluate` (command DoD, sandboxed) + DoD authoring drawer
**Files (edit):** `server.ts`; `src/dashboard/dashboard.ts`.
**Work (server, security-first):** net-new `async function runCommandCriterion(cwd, cmd, expectExit=0, timeoutMs)` → `execFileAsync("/bin/sh", ["-c", cmd], { cwd, timeout: Math.min(timeoutMs ?? 60_000, 300_000), maxBuffer: 4*1024*1024 })`; met iff exit `===expectExit` (capture via rejected `error.code`) → `CriterionEval{met, evidence:"exit N", evaluatedAt}`. **Guards:** behind `process.env.PI_WEB_ALLOW_DOD_COMMANDS==="1"` (default off → returns `unrun`, evidence "command DoD disabled"); **cwd allowlist** (must be under a registered `roots`/`knownCwds`, else 400); hard timeout + maxBuffer; **never reachable from `/api/rollups`**. Cache results in-memory keyed by criterion id with `evaluatedAt`; `/api/rollups` reads this cache so a fresh command shows fresh (else `unrun`/`stale` per `critStale`). `POST /api/dod/evaluate {projectId?|workstreamId?|criterionId?}` resolves the target DoD, evaluates `git_*` inline + `command` via the runner, returns `{ok, evals: CriterionEval[]}`, then `markRollupDirty` the owning project. **Work (client):** port `dodAuthor`/`addCriterion`/`addManualCriterion`/`removeCriterion`/`saveDoD` (L2907–2956) into a DoD drawer inside the dashboard → `PUT /api/workstreams/:id/dod {criteria}`; wire `recheckCard` (S7 stub) to `/api/dod/evaluate`.
**Acceptance:** with `PI_WEB_ALLOW_DOD_COMMANDS=1`: `cmd:"exit 0"`→`met:true`; `cmd:"exit 1"`→`met:false`; `sleep 999` killed at timeout → `met:false` (no hung request); cwd outside roots → 400. Without the env → `unrun`, runs nothing. A subsequent `/api/rollups` reflects the cached result (fresh, not asterisked) + emits one `rollup_changed`. Stale results never back a 100% (`allMet` stays false). Adding/removing criteria persists via `PUT …/dod` and the ring updates to honest k-of-n.
**Test:** `tests/rollups-api.test.ts` (with `PI_WEB_ALLOW_DOD_COMMANDS=1`+temp registry) — workstream DoD with two `command` (`exit 0`,`exit 1`) + one `git_merged`; POST `/api/dod/evaluate`; assert the three evals; re-GET `/api/rollups` → command criteria fresh; a second run without the env → `unrun`; `sleep 999` → timeout; cwd `/etc` → 400. e2e for the authoring drawer round-trip. **agent-browser:** author a DoD, re-check a command criterion, screenshot the updated ring.
**Gate H (security):** run `/security-review` on the exec surface before merge; cwd allowlist + timeout + opt-in enforced; on-demand only.

### S11 — Loop "proposed" band + merge affordance (degraded-but-honest)
**Files (edit):** `src/dashboard/dashboard.ts`.
**Work:** Loop iteration count/sparkbar would need durable `CustomEntry('pi-web:loop-iter')` writes that **do not exist today** — until then, render loops as cyan "running", elapsed from stored `loopStartedAt` via `loopMinutes(s)` (reading the view model, **never** a `runtimeForPath` timestamp — the 60s session dispose means runtime elapsed is unreliable), and the iteration/budget telemetry **only in the muted "proposed" band** (`proposedLoop` L2610) — never live, never amber (the mockup already deleted `loopHealth` for this reason, L1562). Merge affordance gated on a real branch (`hasGitBranch` L2196): render "Ask pi to merge feat/x→main" as an `/api/prompt` send, or "Archive" for no-git/doc DoD. **No "Sign off & merge" fused button.**
**Acceptance:** loops show elapsed from `loopStartedAt` surviving a 60s dispose; no fabricated stall/over-budget; merge button only appears with a branch.
**Test:** unit on `loopMinutes`/elapsed-from-`loopStartedAt`; e2e asserts the loop badge never goes amber without durable telemetry.
**Gate I:** no fabricated loop alarms; merge gated on a real branch.

---

## 3. agent-browser END-TO-END use-case matrix (human-facing proof)

Run via the **agent-browser** skill against the **live dev server at `http://localhost:8787`** (auth disabled). Determinism: a dedicated seed workspace `~/.pi-rollups-e2e/` with temp git repos, projects created through the **real** API, and `resetAll()` (`GET /api/projects`→`DELETE` each, then `git checkout -- . && git clean -fd` each seed repo, then `POST /api/mock/reset`) in `beforeEach`. Each case asserts the DOM hook AND saves a screenshot to `docs/dashboard-designs-final/e2e/<id>.png` — the bundle is the reviewable artifact alongside the validated `scn-*.png` captures.

| id | Use case | Setup | Steps | Assertions | Screenshot |
|----|----------|-------|-------|-----------|-----------|
| E1 | Create a project (POST) | empty registry | open `/`; click "New project"; enter name+root; submit | new `.pcard[data-project-id]` appears; toast + visible name; `GET /api/projects` includes it | `e1-create.png` |
| E2 | Real sessions roll up | project `root=PI_WEB_CWD` | run a prompt on `mock-current`; open dashboard | `.pcard` shows ≥1 `SessionRollup` row with the live one-liner; `activeSessionCount≥1`; running cyan hue | `e2-rollup.png` |
| E3 | Add workstream + attach sessions | E2 state | create workstream; `PUT sessionIds:[mock-current]` | session moves under `.ws[data-ws-id]`; ws ring/gauge updates | `e3-workstream.png` |
| E4 | Manual DoD: toggle + sign-off | card with manual DoD incl. a gate | check the last criterion; click `[data-signoff]` | ring climbs to 100%; status flips purple "awaiting sign-off"; optimistic flip + undo toast; `#signAll` clears the section | `e4-signoff.png` |
| E5 | Git-derived DoD tracks repo | temp repo | dirty→commit clean→branch+merge into main | three shots; `[data-percent]` 0→partial→100 in lockstep with git; merged stays green after a new commit | `e5a/b/c.png` |
| E6 | Nested project resolves to its OWN project | A `root=/outer`, B `root=/outer/inner` | a session in `/outer/inner` | session appears under **B** only, with a `lineage` "under A" badge; A's count excludes it | `e6-nested.png` |
| E7 | Drill: project→workstream→session | seeded project | click `.pcard`→`.ws`→session row | progressive disclosure at each level; criteria list + evidence visible at session level | `e7-drill.png` |
| E8 | Continue the conversation | session with a chip | click `[data-open]` (or `[data-reply]` chip) | navigates to session (`?sessionId=`); `#prompt` visible + `#primaryButton` enabled; chip prefilled; send → user msg in `#messages`, 202 from `/api/prompt` | `e8-continue.png` |
| E9 | Realtime cross-tab | two contexts on `/` | tab A `PATCH /api/dod/criterion` | tab B's ring/status updates without reload; no flicker from chatty events | `e9-realtime.png` |
| E10 | Cold-start / needs-setup | project with NO DoD | open dashboard | `[data-testid="needs-setup"]` shows the project with a "Set criterion" affordance; no fabricated percent | `e10-coldstart.png` |
| E11 | Empty / first-run | `resetAll()`, zero projects | open dashboard | `[data-testid="first-run"]` onboarding with candidate roots; no empty grid | `e11-empty.png` |
| E12 | Calm (nothing needs you) | all sessions merged/idle | open dashboard | needs-you region empty/collapsed; calm hero copy; no amber alarms | `e12-calm.png` |
| E13 | Scale stays calm | ~40 projects (API loop), most merged/idle | open dashboard | grid collapsed/calm; needs-you surfaces only real failures/elicited blocks; CAP-fold deterministic (stable id tiebreak L910); render <~1s | `e13-scale.png` |
| E14 | Honest non-block | a non-elicited idle stop | open dashboard | quiet "Idle · may be waiting", NOT in needs-you count (proves §5.3 anti-fake-alarm) | `e14-softwait.png` |

---

## 4. Dev-server, deterministic seed-data & reset strategy

**Restarting with new server code.** `server.ts`/`server/*` are **not** Vite-HMR'd (only the Vite client is). Two real paths: (1) `npm run dev` (`PI_WEB_DEV=1 node --import tsx supervisor.ts`) → hit `POST /api/restart` (`supervisor.ts` L135) to reload `server.ts` in place between agent-browser cases that change server code; (2) `npm run dev:server` (`--watch server.ts`) for an auto-restart inner loop. **Discipline:** land all backend slices (S0–S3, S8 server bits, S10) iterating via `curl`/vitest before any frontend slice; frontend slices (S4–S7, S9, client of S8) are HMR.

**Deterministic seeding.**
- *Unit/integration (vitest):* `startServer({projectsFile, cwd, token, extraEnv})` spawns `node --import tsx server.ts` with `PI_WEB_MOCK=1, PI_WEB_DEV=1, PI_WEB_TOKEN="", PI_WEB_SESSION_UI_STATE_FILE, PI_WEB_SETTINGS_FILE`, and the new `PI_WEB_PROJECTS_FILE=<temp>`. `seedRegistry(file, registry)` writes a `ProjectRegistry` JSON before boot (deterministic, no API churn). `gitRepo` builder (`makeDirty/makeClean/commitAll/branchAndMerge/setUpstreamAhead`) wraps `git init/add/commit/checkout/merge` like `tests/api.test.ts` L39–42, L417–424. The mock session feed is fixed (`mock-current`, `mock-older`, both `cwd: piCwd`) so a project `root=PI_WEB_CWD` deterministically rolls them up. Factor the proven `freePort`/`waitForServer`/`waitForCondition`/`initGitRepo` boilerplate into `tests/helpers/rollupHarness.ts` + `tests/helpers/gitRepo.ts`; fixtures in `tests/fixtures/rollups/*.json`.
- *e2e (agent-browser):* seed through the **real** create/attach/dod endpoints + a fixed `~/.pi-rollups-e2e/` git workspace. Avoid the mockup's `?scn=` switcher (fixture-only, not wired to `/api/rollups`).

**Reset between runs.**
- *vitest:* fresh `mkdtemp` per `describe` + `afterAll rm` (matches `tests/api.test.ts` L84–87); `POST /api/mock/reset` (L2153) clears sessions/ui-state; **each suite points at its own `PI_WEB_PROJECTS_FILE`** so suites never share state.
- *e2e:* `resetAll()` in `beforeEach` (delete every project, restore seed repos, mock-reset).

---

## 5. Definition of Done — the "rock solid" exit bar

Ship only when **ALL** hold:

1. **`npm run typecheck` clean** (incl. `server/rollups/*` and `src/dashboard/*`).
2. **`npm run test:unit` green**, including every new suite: `rollups-harness`, `rollups-registry`, `rollups-progress`, `rollups-status`, `rollups-gitdod`, `rollups-join`, `rollups-api`, `rollups-realtime`.
3. **Derivation-core branch coverage** — every branch in the §5.2 progress formula and §5.3 status table has a named test: asterisk/unrun/stale, gate-exclusion, allMet-on-stale-blocked, `git_clean` root-scoping, mixed-source→gauge, nested-root→own-project, conflicted-blocked, weights honored.
4. **`npm run test:e2e` green** — existing specs unbroken + `tests/e2e/rollups-dashboard.spec.ts`.
5. **All 14 agent-browser cases (E1–E14) pass** with their DOM assertions AND a saved screenshot; the bundle is visually reviewed against the validated mockup `index.html`/`scn-*.png`.
6. **No fabricated signal** — a grep/assert proves the dashboard never renders a percent not backed by a criterion eval (every ring `[data-percent]` equals a `ProgressSnapshot.percent` from `/api/rollups`), and `command` criteria are never evaluated on rollup render (only via `/api/dod/evaluate`).
7. **Realtime hygiene** — cross-tab update proven (E9) and chatty-event suppression proven (S8/T7): a busy session never repaints the grid.
8. **Persistence/atomicity proven** — kill-9 mid-write leaves no torn `pi-web-projects.json` (registry atomicity + a crash-injection variant); 50 concurrent patches leave valid JSON.
9. **Reviewers find zero high/med issues** — `/security-review` on the S10 command-exec surface returns clean; `/code-review` on the diff finds no high/medium findings.
10. **Zero regression to existing panels** — sessions/git/settings still open and function; the full pre-existing suite (`tests/api.test.ts` et al.) stays green; the dashboard is purely additive (new controller/element/toggle/CSS, optional realtime branches only).

---

## 6. Deferred / proposed (NOT live in v1) — kept honest per the spec

These are surfaced only as muted "proposed" affordances or net-new dependencies; **never presented as live data or alarms**:

- **Loop iteration telemetry (count, sparkbar, budget meter)** — requires a pi extension writing durable `CustomEntry('pi-web:loop-iter')` entries; **not present today**. v1 renders loops as cyan "running" with elapsed from stored `loopStartedAt`; iteration/budget appear only in the muted "proposed" band; the loop badge never goes amber from inference (mockup deleted `loopHealth` for this reason, L1562). (Slice S11.)
- **`command` DoD execution** — ships behind `PI_WEB_ALLOW_DOD_COMMANDS=1`, on-demand-only via `/api/dod/evaluate`, cwd-allowlisted + time-bounded, never on render. Default posture is **off**. (Slice S10; security gate H.)
- **Merge route** — no push/PR/merge in the local-only git layer. v1 uses an agent-prompt "Ask pi to merge feat/x→main" via `/api/prompt`, gated on a real branch (`hasGitBranch` L2196). A true local `git merge` endpoint is optional net-new. **Never a fused "Sign off & merge" button** (sign-off ≠ merge). "Real done = merged PR + green CI" is unavailable; `git_merged`/`ahead` are local proxies, labeled as such in the DoD source label.
- **Structured elicitation / loud "Blocked · needs input"** — requires `extension_ui_request` (exists, `realtime.ts` L395) or a proposed `ask_user` tool. Until structured asks are emitted, `block` comes only from git `conflicted` or a tool error; a non-elicited free-text stop degrades to quiet "may be waiting" (`isSoftWait` L1547) — never a fabricated amber alarm.
- **`lastDashboardVisitAt` "since last visit" delta (§5.6)** — needs a new field on `SessionUiState` (`server/sessionUiState.ts`), owned by the delta/UI-sidecar work; the dashboard degrades gracefully when absent.
- **Auto-open as default landing (decision B)** — v1 ships toggle-first (statusBar button + `mod+h`); auto-opening when `currentSessionId===""` is gated behind a future setting.
- **Per-session embedded `CustomEntry('pi-web:dod')` mirror** — the sidecar registry is the source of truth in v1; the custom-entry writer is deferred.
- **Durable `ArtifactReceipt` (numstat `add`/`del`, merge `sha`, doc file counts)** — no durable receipt source exists today. `buildSessionRollup.gitArtifact` populates a MINIMAL artifact from the git facts already on the render path (`branch` + a met `git_merged` ⇒ `merged`), which lights up the merge affordance (`hasGitBranch`/`branchOf`/`mergeAffordance`) and the Done-section merged receipt. The numstat (`+N/−N`) and the merge `sha` stay UNSET (gitStatus exposes neither); `artChip` omits the diff segment when they're absent rather than fabricate it. A real diff/doc receipt source (a pi extension writing durable receipts) is deferred. (Slice S11.)

---

## 7. Key risks (ranked) & de-risking

1. **Render-logic regression porting ~2700 lines** → adapter-at-the-seam (S5) keeps render fns byte-for-byte; only `loadScenario`'s data source changes; lock with the visual-snapshot harness.
2. **Git fan-out jank** → `cachedGitStatus` TTL (S0), evaluate distinct roots once, command off the render path, Gate B latency budget. Escalation: precompute on dirty-mark and serve cached.
3. **`server.ts` restart vs Vite HMR thrash** → land backend (S0–S3) before any frontend; iterate via `curl`; use `/api/restart`.
4. **Messy real-session crashes** → adapter + `joinRollups` default every optional field (mirror `simplifySessionInfo`); Gate B includes an explicit messy-session case.
5. **Realtime repaint storms** → server-side debounce + dirty-project scoping (S8); client ignores `message_update`/`tool_execution_update`.
6. **Command-DoD security** → sandboxed helper, cwd allowlist, timeout/maxBuffer, opt-in env, on-demand-only, `/security-review` gate (S10/H).
7. **Type duplication across the wire** → view-model types live once; the client imports types only; client trusts the server `ProgressSnapshot` (no cross-boundary value import); contract locked by `rollups-progress`/`rollups-join` tests.
8. **Test isolation clobbering the real registry** → `PI_WEB_PROJECTS_FILE` env override (S1) + per-suite temp files.
9. **Progress-formula drift (mockup substring `srcFamily` vs structured `source.kind`)** → production keys off `source.kind`; a golden test feeds identical criteria through the ported `computeProgress` and recorded mockup outputs to prove parity.
10. **`WorkItemStatus` (5) vs render-states (9) impedance** → carry both `status` and `uiStatus`; the frontend port consumes `uiStatus` for `STATUS_RANK`/badges.
