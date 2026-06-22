# Project Rollups — final design changelog

## Iteration 3

Depth pass on the chosen "Project Rollups" concept. Started from iteration 2
(`0507b7a`) and applied the synthesized 20-item critique. No rebuild — every
working surface (calm-by-default grid, drill-down, DoD rings, continue-the-
conversation, scenario switcher) was preserved and tightened. Single
self-contained file, inline CSS+JS, native pi-web dark tokens.

### What changed (by critique item)

1. **De-stacked the top band.** The needs-you count now lives in exactly one
   place — the hero headline. Removed it from the Needs-you section header, the
   tally rail, and the per-card jump pill. The since-last-visit delta is no
   longer a bordered band; it is one muted clause on the hero subline, gated to
   render only when something actually merged since the visit. When `needs===0`
   the whole Needs-you section is dropped (the hero says it once). Result: at
   most headline + subline + one rail row before content.
2. **Rationed hue in the rail.** Only the actionable Sign-off pill carries colour
   (purple = "your turn"). Running / Planned / Merged / Healthy swatches are
   muted grey with the count in `--text`. Colour in the rail now means
   "actionable", not "category".
3. **Grounded the loop primitive.** `isLoop` is stored (not inferred). Added a
   stored `budget {maxMinutes?, maxCostUsd?}` compared to `elapsedMin` / `cost`
   (proxying `SessionStats.cost` + elapsed). `loopHealth()` computes
   stalled (flat/declining spark tail) and over-budget; the loop badge + ring
   flip amber **only** then. Added a budget meter to loop session rows and a
   stalled-loop fixture (datapipe backfill) so a healthy loop and a stalled loop
   no longer look identical. Sparkbar documented as `tool_execution_end` per
   iteration (= one `agent_start→agent_end` with no intervening user message).
4. **Attention-driven collapse, always.** Dropped the `length > 8` gate. Full
   ring-cards render only for attn/active projects; sign-off + calm/dormant
   collapse to grouped rows regardless of fleet size — so 2-active + 6-merged
   shows 2 cards, not 8 panels. (A fleet with no attn/active promotes sign-off
   projects to cards so the grid is never empty — e.g. the no-git scenario.)
5. **No cross-source ring blending.** When a workstream's sessions span >1
   evaluator family, `enrich()` sets `_mixed` and the ring becomes a
   "k of n sessions done" gauge (one segment per session) with a "mixed
   sources" note. Criteria-blended percent is reserved for homogeneous sources.
6. **Sign-off is first-class.** New "Awaiting your sign-off" strip, lifted
   directly under Needs-you, auto-shown (not buried in the Done accordion).
   Row-level **Sign off** flips the manual gate criterion optimistically with an
   undo toast (no drawer); "Review fully" opens the drawer. The grid sign-off
   group is a collapsed drill-down reference that points up to the strip (no
   double-surfacing).
7. **Gate semantics baked in.** Progress excludes `gate` criteria; status
   derives `sign` when all non-gate criteria are met and a manual gate is
   pending; auto sources are never gated. Documented in the grounding note.
8. **View-models extended.** The grounding note now enumerates every rendered
   field's home on the rollup view-models (live, elicitation, blast, failAction,
   loop{iter,sparks,budget}, plannedQueue, dod{criteria…}, lineage, dodSummary).
9. **Honest block detection.** Block + chips require a structured elicitation
   (`{sessionId, question, options[]}`). Non-elicited free-text stops degrade to
   a quiet "Idle · may be waiting (N min since agent_end, unread)" — never a
   fabricated amber alarm.
10. **Split Sign off / Merge.** "Sign off & merge" is gone. "Sign off" = PATCH
    the manual gate (supported today). Merge is a separate, explicitly-labelled
    step (net-new git-merge endpoint or an agent prompt), flagged with an info
    glyph because the git layer is local-only.
11. **Real delta.** Computed by diffing recent `mergedAgo` + numstat against a
    stored `lastVisit`; falls back to "Recent activity" with no fabricated
    interval; no cumulative-iter-as-delta.
12. **One canonical merged/planned scope.** Merged + Planned counts exclude
    dormant projects everywhere (rail, hero, delta, Done, Planned) so every
    jump-link lands on a surface whose count matches. Planned capped at 6 +
    show-all; dormant planned rows excluded.
13. **Ring status encoding fixed.** Surfaced (block/fail) rings are no longer
    42%-opacity ghosts — they stay legible, lose the alarm hue, and gain a quiet
    ↑ marker. When all of a card's workstreams are surfaced, the ring row
    collapses to one "All N workstreams are in Needs you ↑" line. Added a
    colourblind-safe shape channel on the rings (circle=run, square=block,
    diamond=sign, ×=fail).
14. **Trimmed the session row.** Artifact chip face shows only branch + diff (or
    doc name); the command/exit/timestamp/re-check evidence lives once in the DoD
    list. The repeated "best-effort" caption is now one info glyph + tooltip. The
    per-session status badge is dropped (shape-coded dot + workstream badge cover
    it).
15. **Lower segmentation threshold.** Rings segment only for 2–6 criteria; past 6
    they render one clean proportional arc. Collapsed-card ring bumped 46→54px.
16. **One alarm hue per card.** Blast tags inherit the item's own status hue
    (block→amber, fail→red); magnitude lives in the label, so a card never shows
    amber + red at once.
17. **Grounded fail + blast.** Documented: fail derives from
    `tool_execution_end(error)` / abnormal `agent_end` / git `conflicted`, not a
    dashboard command-eval; blast = manual override OR destructive-keyword regex
    OR dirtyCount bucket, and orders triage only (gates nothing).
18. **Provenance ≠ evaluator.** The DoD pill shows provenance (authoredBy); the
    per-criterion pill shows the real evaluator (manual / git / command /
    runtime), with an agent-asserted boolean resolving to `manual`. Documented
    longest-prefix exclusive project matching so nested roots never double-count;
    lineage badge carried into `renderRow` (survives compact/dormant rows).
19. **Layout/receipt honesty.** A single surfaced need uses a natural-width
    column (`.needs.single`). The no-git doc chip is gate-aware: "awaiting your
    review" until the manual gate flips, then "✓ user-reviewed".
20. **Calm polish.** One live-ping at a time (others static cyan); section heads
    reduced to title + count with the ring legend / verification-first text moved
    to `?` tips; open-workstream session lists capped at ~6 + "+N more sessions"
    (a 9-session workstream added to the dense fixture to exercise it);
    state-matched verbs ("Open" for live, "View" for merged, "Continue" for
    blocked/idle).

### UI → data grounding (what backs each element)

- **DoD rings** — `ProgressSnapshot.percent = metWeight/totalWeight` over
  non-gate `DoDCriterion[]`; segmented so a percent always reads as "k of n met"
  and traces to a checkbox / git fact / exit code. Mixed-source workstreams
  switch to "k of n sessions done" (no blended percent).
- **Statuses** — derived from `runtimeForPath()` (isRunning → run/loop),
  git `conflicted` / `tool_execution_end(error)` → block/fail, evaluable 100% +
  pending manual gate → sign, evaluable 100% (auto) → merge.
- **Artifact chips** — `gitCommitDetails` numstat (+/−), `gitStatus` branch,
  `git merge-base --is-ancestor` (merged · sha); command checks are
  `kind:"command"` DoD via `executeBash`, on-demand only with `evaluatedAt` +
  staleness. No PR/CI object exists; merge is called out as net-new work.
- **Loops** — stored `isLoop` + `budget`; sparkbar = `tool_execution_end` per
  iteration; amber only when stalled or over budget.
- **Sign-off** — manual gate criterion toggled via PATCH
  `/api/dod/criterion/:id` (the only mutable truth for `kind:"manual"`).
- **Projects / workstreams / DoD** — pi-web-owned `ProjectRegistry` sidecar
  (mirrors `server/sessionUiState.ts`); sessions matched to exactly one project
  by longest cwd prefix; rollups computed on read in `/api/rollups`.
- **Delta** — `lastDashboardVisitAt` in the UI sidecar diffed against recent
  `mergedAt` + numstat.

### Scenarios exercised

default, single (many rings), scale (42 projects → 3 cards + 2 collapsed
groups), dense (8 workstreams incl. a 9-session one), calm (Quiet Sunday),
blocked (6 waiting), loop (growing 3→17 + a stalled loop), no-git research,
mixed (six DoD sources, k-of-n gauge), empty/first-run.

## Iteration 4

Final-form pass. Started from iteration 3 (`61d7326`) and applied the synthesized
13-item critique. No rebuild — the calm grid, drill-down, DoD rings,
continue-the-conversation and scenario switcher were preserved and tightened. The
fixture grew two active loops (fleet scale) and one stale command criterion
(dense) so the new honesty paths are demonstrable, not just coded.

### What changed (by critique item)

1. **Sign-off became a light, capped to-do LIST.** `.soff` dropped the purple
   gradient + left bar + per-item `sign` badge and is now a flat `var(--panel-2)`
   single-column ROW (crumb · criterion · artifact chip · one purple "Sign off" +
   ghost "Review"). Purple now appears ONCE per row (the button). Capped to 3 rows
   + a "+N more to sign off" stepper, with a "Sign off all N" batch action in the
   header. ~⅓ the visual mass — the default fold is one loud band (Needs you), not
   two.
2. **Active full cards are capped (scale).** `renderGrid` always renders attn
   (block/fail) cards full but caps ACTIVE (run/loop) full cards at 6 by
   attention; the overflow folds into a "Running · N more" grouped-row card (name
   + dot-strip + live one-liner). The scale fixture now carries 10 simultaneous
   loops → 6 cards + "Running · 4 more", not 10 panels.
3. **Honest calm hero + stalled-loop surfacing.** When `sign>0` (and nothing
   needs you) the headline says "N done — your sign-off is all that's pending."
   "You can close this tab." prints ONLY when needs+sign+stalled are all 0. Any
   `_loopWarn` flips the headline to "N loop(s) need a look", appends "· N loop(s)
   stalled — review", adds an amber rail pill **Loops need attention** that jumps
   to the card, and sorts warn-loops above healthy active projects.
4. **Merge affordance gated + disambiguated.** Merge renders only when
   `artifact.branch && kind!=='doc'`, labelled **"Ask pi to merge feat/x → main"**
   (buildable via `/api/prompt`); a no-git/doc DoD shows **"Archive"** instead —
   no branch/main implied (verified: nogit → Archive, default → Ask pi to merge
   feat/plaid → main).
5. **Glance-level progress honesty.** `computeProgress` excludes never-run command
   criteria from the denominator (faint "not yet checked" segment + asterisked
   "k/n" number) and `allMet` (which gates the sign-off promotion) now requires
   every evaluable criterion RUN and FRESH; a stale-backed sign item shows
   "done — pending recheck" with a Re-check on the card face, and a neutral
   pulsing "evaluating" ring covers the two-phase load / on-demand recheck. Fixed
   the dense `c()` helper that silently dropped `at` timestamps.
6. **Durable loop telemetry + git freshness (grounding).** Documented net-new
   `isLoop` / `budget` / `loopStartedAt` registry fields; elapsed from stored
   `loopStartedAt` (not `runtimeForPath`, which resets on dispose); iter/sparkbar
   rebuilt from `CustomEntry('pi-web:loop-iter')` + `tool_result` ENTRIES; git DoD
   freshness as a TTL poll or fs/git watcher emitting dirty-scoped
   `rollup_changed`.
7. **Delta = real transition digest, deduped.** Removed the duplicate "N merged
   recently" subline; `deltaClause()` now diffs transitions vs the stored
   `lastDashboardVisitAt` → "+N merged · N newly blocked · N ready to sign off ·
   bug-sweep +N iters", each fragment a jump-link, numstat demoted to the merged
   fragment's tooltip. Recent merges count fleet-wide (incl. dormant) so
   calm-collapse never zeroes throughput.
8. **De-noised metadata + raised the text floor.** `.srcTag` is borderless (plain
   muted text + leading middot) — bordered pills are reserved for clickable
   things. Load-bearing secondary text (`.ppath`, `.ws-dod`, `.sess-dod`,
   `.dnote`, `.cev`) raised to a 12px floor with the extra muted-% reductions
   dropped; 11px kept only for uppercase micro-labels.
9. **No double headings; remaining reveals capped.** Done/Planned dropped the
   outer `shead`; the jump ids moved onto the self-labeling accordions. The
   dormant group is recency-sorted + capped at 6 with "+N more — show all", and
   the "+N more need you" reveal is likewise capped.
10. **Rail jumps + denominators fixed.** Dormant group is `#sec-healthy` (the
    Healthy pill lands on it and auto-expands; Done/Planned/grpcard jumps also
    auto-open). Healthy is labelled by unit ("Healthy · N projects") so it isn't
    confused with the session-level counts; the decorative grey swatch is dropped
    everywhere except the hued Sign-off / warn pills.
11. **No double-surfacing on cards.** `cardLive` skips items already in Needs-you
    and points up ("answer in Needs you ↑" / "sign off above ↑") instead of a
    redundant Continue; when every attn/active card is fully surfaced the whole
    grid collapses to one line + a drill-in group; surfaced rings stay SALIENT
    (amber hue + dashed outline + ↑) so attention doesn't invert onto the quietest
    cell.
12. **Cold start demonstrates auto-discovery.** `SCENARIOS.empty.candidates=3` →
    the first-run panel offers a one-tap discovery list mined from recent session
    cwds / git roots.
13. **Honesty hedges.** Prose-parsed queues show "~N more planned" (exact totals
    reserved for a plan-tool CustomEntry); the doc artifact file count is sourced
    from the session's write/edit `tool_result` entries (stated in chip tooltip +
    grounding); a note that production keys mixed-source detection off
    `DoDSource.kind`, not the fixture's label regex; the colourblind ring shape
    enlarged to ~5px at the 12-o'clock cap.

### UI → data grounding (deltas this iteration)

- **Rings** still = `metWeight/totalWeight` over non-gate criteria, but the
  denominator now excludes never-run **command** criteria (`/api/dod/evaluate`,
  on-demand + cached) and the number asterisks when any evidence is stale/unrun;
  `allMet` requires fresh evidence before a sign-off promotion.
- **Loops** — elapsed from registry `loopStartedAt`, iter/spark from durable
  `CustomEntry('pi-web:loop-iter')` + `tool_result` entries; budget vs
  `SessionStats.cost` + elapsed; amber only when stalled/over-budget.
- **Delta** — transition diff vs `lastDashboardVisitAt`; merges count fleet-wide.
- **Merge** — no local merge route exists; the gated button sends an agent prompt
  via `/api/prompt` (or a net-new git-merge endpoint), never a fake local op.

## Iteration 1 — convergence run

The prior run plateaued at 7/10 across four iterations: it kept re-drawing
features pi cannot ground, left the core attention-routing bug unfixed, and broke
prior wins while chasing new critiques. This run targets convergence: every
carry-forward must-fix applied, the grounding rule enforced to zero ungrounded
live elements, locked invariants preserved. Started from the prior final
(`index.html` as carried in), edited in place — the calm grid, drill-down, honest
k-of-n rings, continue-the-conversation and the 10-scenario switcher all kept.

### Carry-forward must-fixes (all applied + verified)

- **A — `cardLive` now names the blocker.** The old version computed the card
  one-liner from NON-need sessions only, so a project with a blocker AND running
  work showed the running task while the human-blocking item hid as the faintest
  ring. Rewritten to scan ALL sessions, take the single highest-priority one
  (failed → blocked → awaiting sign-off → running → idle), and NAME it in the
  one-liner. Verified: default `wealthlens` card reads "Plaid integration needs
  your input — Which Plaid product scopes…" (not the running token-refresh job);
  `zippy` reads "Calendar sync failed — …".
- **B — one canonical sign-off surface.** The grid's duplicate "Awaiting your
  sign-off" grpcard (`#sec-signgrp`) is gone. The lifted strip
  (`#sec-signoff`) is the only sign-off heading; its rows drill in via "Review".
  Verified: exactly one rendered "Awaiting your sign-off" heading on the page.
- **C — dense card no longer a ring wall.** The collapsed card face no longer
  paints a ring-per-workstream. It shows ONE muted project gauge (k of n
  workstreams done — an honest aggregate, not an authored percent), a shape-coded
  dot-strip (one dot per workstream, calm at 3 or 9), and the NAMED long pole +
  its status badge. Rich per-criterion rings appear only on an opened workstream.
  Verified: dense (9 workstreams) shows 0 ring cells on the face, a 3/9 gauge, a
  9-dot strip, "Long pole: Plaid integration · Blocked", and 9 rings only in the
  expanded body.
- **D — loop telemetry is no longer drawn as live.** Iteration sparkbar, budget
  meter, iteration count, stall/over-budget alarm and the durable Pause/Resume
  control are removed from the live view (hero, rail, rings, badges, card faces,
  session rows). They depend on a per-iteration log + orchestrator pi does not
  expose. The concept survives as an explicit, muted, dashed **"proposed"** band
  shown ONLY inside an opened loop session — never mistaken for live data. The
  live loop badge is just "∞ looping {elapsed}" (grounded in stored
  `loopStartedAt`). Verified: no `iter N` / budget / stall strings render in the
  collapsed grid or hero; the proposed band is hidden until a session is opened.
- **E — merge honesty.** "merged to mainline" → "merged into local main"
  everywhere (35 fixture + transcript strings); the merge button stays "Ask pi to
  merge feat/x → main" with the local-only info glyph. No remote merge/PR implied.
- **F — active full-cards capped.** `ACTIVE_CAP` lowered 6 → 4; overflow folds
  into the "Running · N more" grouped-row card. Verified: scale (42 projects, 10+
  simultaneous loops) renders 6 full cards (2 attn + 4 active) + a Running
  overflow group + collapsed sign-off strip + Healthy & dormant group; no
  horizontal scroll (scrollWidth === clientWidth at 1440).
- **G — surfaced alarm quieted.** Because the collapsed face no longer carries
  per-workstream ring cells, the salient dashed-amber outline + floating ↑ badge
  that risked inverting attention onto the quietest cell are gone by construction.
  The one-liner names the blocker; the dot-strip shows it as a calm amber square.

### Honesty cleanups beyond the must-fix list

- Non-elicited free-text stop now reads "Idle · may be waiting" (spec §5.3),
  not a fabricated "Paused" badge.
- Fixture `live` strings stripped of "within budget" / "(possible stall)" claims
  so no always-visible one-liner implies budget or stall tracking the dashboard
  can't ground; stall surfaces only in the proposed band.

### UI → signal grounding (deltas this run)

- **Project gauge (card face)** — `ProjectRollup` aggregate: k of n workstreams
  whose evaluable DoD is met (merge / sign / `allMet`). Muted, segmented, never an
  authored percent. Per-workstream criterion rings remain `metWeight/totalWeight`
  on the opened workstream only.
- **Loop badge** — `isLoop` (stored) + elapsed from stored `loopStartedAt`. Iter
  count / rhythm / budget / stall are explicitly **proposed** (need a durable
  `CustomEntry('pi-web:loop-iter')` + orchestrator), rendered muted, never live.
- **Card one-liner** — the project's highest-priority `SessionRollup` by derived
  status; for block/fail it names the workstream + the structured elicitation and
  routes up to Needs you (the canonical action surface).

## Iteration 2 — convergence run

Built on the iteration-1 convergence output (`0666c6d`). The verification lenses
flagged that several iteration-1 "wins" had drifted or were applied to surfaces
they missed. This run closes those gaps and lands the deferred polish — every
edit grep-verified, then re-verified live in the browser per scenario. No locked
invariant regressed; `node --check` of the inline app JS passes.

### Grounding / honesty / regression fixes (prioritized 1–8)

1. **Loop telemetry fully grounded (carry-fwd #D).** `loopElapsed()` (strips
   `· iter N`) was already on the live session-row badge and the workstream badge,
   but the **drawer transcript "Autonomous loop · …" sys line still rendered raw
   `s.meta`** (leaking `iter 12`). Wrapped it in `loopElapsed()`. Verified: 0
   `esc(s.meta||'looping')` raw call sites remain; `iter N` now appears ONLY in the
   muted, dashed "proposed — not live yet" band (`proposedLoop`).
2. **Budget / stall as live chrome — confirmed clean.** 0 occurrences of
   "within budget" / "possible stall" anywhere; budget/stall live only as text in
   the explicitly-proposed band. (Already removed in it-1; re-verified by grep.)
3. **Merge honesty completed.** Two stragglers the it-1 sweep missed — a fixture
   DoD label `"tests pass + merged to main"` and the onboarding teaching line
   `"merged to main, tests passing…"` — changed to `"merged into local main"`.
   Verified: `merged to mainline` = 0, `merged to main` = 0, `merged into local
   main` = 37 across rendered DoD labels.
4. **`allWsSurfaced` made session-level (regression + mixeddod FAIL).** Was
   `every(w => w.status==='block'||'fail')`, which treated the mixed-source single
   workstream (status `block`, but run/block/sign/unset/loop **sessions**) as fully
   surfaced — collapsing the whole mixeddod grid and hiding the very gauge it
   exists to demonstrate. Now requires every **session** of every workstream to be
   block/fail. Verified live: mixed scenario renders the full card + the honest
   "k of n sessions done" mixed-source gauge, no collapse; blocked scenario still
   collapses correctly ("All work across 3 projects is in Needs you").
5. **Onboarding candidate dots neutralised (pi-systems).** Unregistered candidate
   folders carried fabricated status dots (green `merge` / grey `idle`) — but an
   unregistered folder has no computed rollup/status/DoD. Replaced with a neutral
   muted folder glyph; the grounded `git · N sessions` meta stays. Brushes nothing
   against the colour=status-only invariant now.
6. **`Paused` → `idle` (honesty / leak-prone).** All 8 fixture `meta:"…paused Nm
   ago"` (incl. the capitalised one) are now `idle Nm ago` — `s.meta` feeds
   `fleetDelta()`/`isRecent()`, so the fabricated "Paused" word was one render path
   from leaking. Verified: 0 `paused` in the rendered DOM; the CSS `.badge.paused`
   token is untouched.
7. **Sign-off count consolidated to one surface (Calm/IA).** Dropped the
   `N done awaiting sign-off` fragment from the needs>0 hero subline. The number now
   lives once on the lifted "Awaiting your sign-off" strip + its rail pill, honoring
   the same count-in-one-place discipline the needs-count already follows.
8. **Close-this-tab honesty tension resolved (Calm/IA).** When `needs+sign==0` the
   hero still says "You can close this tab." — UNLESS the longest grounded loop has
   run past a threshold (`CLOSE_TAB_LOOP_MIN = 45m`), in which case it states the
   neutral fact "Longest loop running {elapsed}" instead. Elapsed comes from the
   stored `loopStartedAt` (fixture `elapsedMin`/parsed meta); never an invented
   stall/over-budget alarm. Calm scenario (22m loops) keeps the reassurance; the
   long-running loop scenario (2h 40m) shows the fact.

### Low-severity polish (item 9, landed after 1–8 were grep-verified)

- **9a** Long-pole badge mutes to "· in Needs you ↑" (muted dashed jump) when that
  workstream is already surfaced in Needs-you, so salience lives once and no amber
  alarm appears on the calm card face.
- **9b** Project-gauge wording: a `sign` workstream "met DoD" (pending sign-off),
  not "done" — card face now reads "k of n workstreams met DoD · m pending
  sign-off"; the ring math is unchanged.
- **9c** Rings show honest **k/n** as the centre number always (invariant #3 —
  never an invented percent); the derived percent moved to an SVG `<title>` tooltip.
  Unrun/stale command evidence still asterisks the fraction muted.
- **9d** Stale scenario label "Single project · many rings" → "Single project ·
  3 workstreams".
- **9e** Opened-card workstream list capped at 6 with "+N more workstreams"
  (reuses the `data-toggle=more` reveal). Verified: dense (8+1 workstreams) renders
  6 + a "+3 more workstreams" expander — no instrument wall (invariant #6).
- **9f** Delta-digest true-diff vs `lastDashboardVisitAt` — **deferred**: the
  current `isRecent` heuristic is already honest and explicitly labelled ("Recent
  activity" fallback), and a rewrite risked regressing the verified delta clause.

### UI → signal grounding (deltas this iteration)

- **Drawer loop sys line** — now `loopElapsed(meta)` (stored `loopStartedAt`),
  matching the live badges; iteration count is proposed-only.
- **Ring centre number** — `k/n` over RUN non-gate criteria (`computeProgress`);
  percent is tooltip-only, never the face value.
- **Onboarding candidate** — neutral folder glyph + `git · N sessions` from
  `listGitRepos`; no status until the folder is registered and a rollup computed.
- **Hero close-tab clause** — longest-loop elapsed from stored `loopStartedAt`,
  shown as a neutral fact past 45m, never a stall alarm.

### Scenarios re-verified live (1440×900, no console errors)

default · scale (42 projects, no h-scroll) · dense (8-ws cap) · calm (close-tab
kept, only cyan) · blocked (3-project collapse, 0 "paused") · empty (folder
glyphs) · mixed (full card + mixed gauge, no collapse) · expand · continue
(composer + chips prefill = answer-is-continue).

## Iteration 3 — convergence run

Restored the iteration-2 deliverable from its commit (`6821ae1`) and re-applied the
prioritized change list against the **real on-disk file** this time. Root cause of
the prior thrash: the iteration-2 grounding/honesty fixes were committed to `6821ae1`
but never propagated to the working directory the review lenses audited — so the
lenses critiqued a stale, pre-convergence copy and the line numbers in the change
list pointed at that copy. Working from `6821ae1`, most high-severity items (loop
iteration telemetry quarantined, budget/stall removed from live, `merged to mainline`
→ `merged into local main`, `paused` → `idle` in fixtures) were already landed and
were re-verified by grep here; the remaining regression + polish items were applied
and committed. `node --check` of the inline app JS passes; 0 console errors across
all scenarios at 1440×900.

### Re-verified already-present (high-severity, from `6821ae1`)

- **Loop iteration telemetry is not a live element (P2).** Live loop badges
  (session row, workstream, drawer "Autonomous loop" sys line) all render
  `loopElapsed()` (strips `· iter N`). `iter`, the rhythm sparkline, and any budget
  cap appear ONLY in the muted, dashed `.proposed` band labelled "not live yet".
- **No live budget/stall claim (P3).** `within budget` = 0, `possible stall` = 0.
- **Merge honesty (P4).** `merged to mainline` = 0, `merged to main` = 0,
  `merged into local main` = 37; merge stays a gated, separate "Ask pi to merge … →
  main" affordance only when a real branch exists (else "Archive").
- **`paused` → `idle` (P6).** 0 `meta:"paused…"` in any fixture.

### Applied this iteration

5. **Hero calm path: obligation count in exactly one place (P5).** In the
   `needs===0` branch the headline already states the sign-off ("N done — your
   sign-off is all that's pending"); dropped the duplicate `N done awaiting your
   sign-off` push from the subline so the count is asserted once.
6. **Calm hero de-dup (P9b).** When `sign===0`, the headline states the run/loop
   count ("{N loops running}, everything else can wait"); the subline no longer
   repeats it. When `sign>0`, the headline carries the sign-off and the subline
   carries the run/loop count — mirroring the `needs>0` branch.
7. **Delta digest grounded (P7 + P9d + P9f).** Removed the `ready to sign off`
   fragment (no became-allMet timestamp grounds "new since visit", and it restated
   the sign count a third time). The `newly blocked` fragment is suppressed when
   `needs>0` (the hero headline already states the needs count). Net git numstat now
   renders **inline** on the `+N merged` fragment, not just in the tooltip.
8. **Open-ended loops excluded from the gauge (P9a).** `projGauge` denominator and
   `longPole()` now skip `wsOpenEnded` workstreams, so a perpetual loop never reads
   as "0 of N met DoD". An all-loop project shows a running ∞ and "Continuous loop —
   no terminal Definition of Done" instead of "0 of 0".
9. **Dense scenario at spec density (P8).** `WORLD_DENSE` rebuilt to exactly **8
   workstreams / 40 sessions** (was 9 ws / ~17, with a label mismatch). The
   session-heavy "Tax form mappings" workstream holds 14 sessions, proving the
   per-workstream "+8 more sessions" cap; the 8 workstreams prove the "+2 more
   workstreams" cap. Generated filler sessions still trace to real signals (git
   merge / command exit / manual sign-off). Re-captured `scn-dense` with the card +
   the heavy workstream opened so both caps are on-screen.
10. **Protective cleanup + polish (P9c/e/g/h).** Deleted dead CSS that could silently
    reintroduce a live amber meter — `.badge.paused`, `.pill.warn`, `.loopBadge.warn`,
    `.budget*` (all confirmed unused). Added a visible `~ parsed from notes` marker on
    planned-queue chips (best-effort parse is no longer tooltip-only). Fixed the fleet
    label (`42` → `51`, the real rendered count). Added an "Attach sessions to a
    workstream" step to first-run onboarding (register → attach → set DoD).

### UI → signal grounding (deltas this iteration)

- **Project gauge** — `k of n` over **non-open-ended** workstreams (`projGauge`
  excludes `wsOpenEnded`); a loop has no terminal DoD, so it is never in the
  denominator and never the long pole.
- **Delta numstat** — `+add/−del` from `git numstat` over commits merged since the
  stored `lastDashboardVisitAt`, shown inline as a muted git fact (not a status).
- **Planned-queue chips** — `~ parsed from notes` is now visible: pi has no
  TodoWrite/plan primitive, so the count stays approximate (`~`).
- **Dense fixtures** — every generated session resolves to `git_merged` /
  `command` exit / manual sign-off; no ring is faked to reach density.

### Scenarios re-verified live (1440×900, 0 console errors)

default · scale (51 projects, capped cards + grouped running + dormant, no
h-scroll) · dense (8 ws / 40 sessions, card + heavy workstream open, +2 more
workstreams / +8 more sessions visible, loop shows ∞ not 0/1) · calm (headline
states loops, subline does not repeat; gauge 1/1 with loop excluded) · blocked
(top-2 full + "+4 more need you" by blast radius) · empty (3-step onboarding incl.
attach-sessions) · expand (card → workstream → sessions, "merged into local main"
DoD) · continue (quick-reply chip prefills the composer = answer-is-continue).

---

## Iteration 4 — convergence run (the strategy fix)

This run targeted the actual convergence blockers verified ON DISK in the iteration-3
artifact (not against builder claims). Every change preserves the locked invariants; the
focus was killing the last fabricated live signal and finishing the honesty polish.

1. **P1 — pull EVERY loop stall/over-budget/iteration signal off all live surfaces
   (the #1 forbidden category).** Deleted `loopHealth()` entirely — computing a
   stall / over-budget verdict was the last code path by which a fabricated alarm
   could leak (it depends on a durable per-iteration log + an orchestrator pi does not
   expose). `enrich()` no longer assigns `s._loop` / `_loopWarn`; `projWarn()` is now a
   stable `false` and the "stalled loops first" active-card sort was removed.
   `proposedLoop()` no longer appends a `· {reason}` stall/over-budget clause — iteration
   count, rhythm sparkbar and budget cap appear ONLY inside the muted, dashed,
   "— not live yet" proposed band, never as live data and never amber. Re-grounded the
   `WORLD_LOOP` `datapipe` fixture: it was contrived to trip the (now-removed) alarm
   (`elapsedMin 160 > maxMinutes 120`, `cost 6.4 > maxCostUsd 6`, a declining sparkbar
   and a stall-narrating one-liner). Budget is now within bounds (240m / $9), the
   sparkbar is non-declining, and the one-liner is neutral — the long 2h40m elapsed is
   kept so the calm hero still honestly states "Longest loop running 2h 40m".
2. **P2 — merge honesty (verified, already clean).** `grep "mainline"` = 0,
   `"into local main"` = 38. The DoD never claims an authoritative "mainline"; merge is a
   gated, local "Ask pi to merge feat/x → main" affordance only when a real branch exists.
3. **P3 — sign-off hero is PURPLE, not amber.** Added `.headline em.sign{color:var(--st-sign)}`
   and emit `<em class="sign">${c.sign} done</em>` in the calm sign-off branch. Verified
   computed color = `rgb(192,132,252)` = `--st-sign`. Sign-off no longer conflates with
   blocked/needs-you in the one place it was reading amber.
4. **P4 — desaturated the +/− numstat on card-face artifact chips** to the same muted
   `color-mix(... var(--muted))` the delta digest uses; full-saturation `--st-fail` red is
   now reserved strictly for FAILED status. A "−96" inside a green merged chip no longer
   momentarily reads as a failure. Diff-hunk backgrounds stay green/red.
5. **P5 — non-elicited (soft) blocks excluded from the hero obligation count.** `isNeed`
   now takes the session and counts a block only when `s.elicited` (spec §5.3 — a free-text
   stop can't be PROVEN blocked); `fleetCounts` tallies soft blocks into a separate
   `softwait`, surfaced as a quiet italic "N may be waiting" subline clause, never inside the
   "N things need you" headline. `projNeeds` is likewise elicited-aware. (Latent today —
   every shipped fixture is elicited — but now sound for final form.)
6. **P6 — de-noised the dense workstream.** When a session's DoD is identical (text + source)
   to its workstream's, the per-row DoD line is suppressed (the header already states it); it
   re-appears only on rows whose source/criteria deviate. Verified in the 14-session "Tax form
   mappings" workstream: 8 rule-based run/queued rows suppress, the 6 merge/sign rows (deviating
   source) keep their DoD.
7. **P7 — time-since-waiting on Needs-you cards + age tie-break.** Added a muted "waiting Nm"
   tag (from the session's last-activity meta) to elicited need cards and the +N-more rows, and
   broke blast-radius ties by AGE (oldest first) in `renderNeeds`. Verified live: cal-sync
   (failed 21m) now sorts before Plaid (idle 12m) at equal blast.
8. **P8 — re-grounded verification on the artifact + low nits.** Re-rendered all scenarios
   from the actual file and re-ran the grounding greps against `index.html` (not the changelog):
   mainline 0 · into-local-main 38 · zero live loopHealth/_loop/.warn refs · zero live
   within-budget/needs-attention/loops-stalled. Reconciled the calm delta vs `lastVisit`:
   `fleetDelta` now counts only merges/blocks NEWER than the stored visit age (3h/5h-old merges
   no longer count against a 2h-ago visit). Added a heuristic-provenance tooltip to `.blast`
   tags. Stripped the numeric badges from the Running/Merged rail pills when `needs===0`
   (the calm hero owns those counts).

### UI → signal grounding (deltas this iteration)

- **Loop telemetry** — a live loop is only "running" (cyan ∞) with elapsed from the stored
  `loopStartedAt`. Iteration count / rhythm sparkbar / budget cap render ONLY in the muted
  "— not live yet" proposed band; stall and over-budget are computed nowhere.
- **Hero obligation count** — `c.needs = elicited blocks + fails`; non-elicited stops are a
  separate `softwait` hedge ("may be waiting"), never an obligation.
- **Since-last-visit delta** — merges/blocks count only when `agoToMin(item) <= agoToMin(lastVisit)`;
  older activity is not "new since your visit" (no fabricated window).
- **Workstream DoD** — hoisted to the header; per-row DoD shown only where the source/criteria
  deviate from the workstream.

### Scenarios re-verified live (1440×900, 0 console errors)

default ("2 things need you", muted numstat, waiting-Nm on cards) · scale (attention-driven
cards + grouped Running + dormant, no h-scroll) · dense (8 ws / 40 sessions; Tax workstream
de-noised — 8/14 per-row DoDs suppressed; loop shows ∞, no iter/budget alarm) · calm (cyan
"Nothing needs you", Running/Merged rail pills carry no number, no false merge-delta) ·
blocked ("6 things need you", top-2 full + "+4 more need you" by blast radius, destructive
migration ranked first) · empty (3-step onboarding, "merged into local main") · nogit (PURPLE
"2 done — your sign-off is all that's pending", doc DoD "awaiting your review", no merge
prompt) · expand (honest k-of-n rings, "∞ looping 38m" with no alarm) · continue (Plaid
elicitation + quick-reply chips prefilling "Ask pi…" = answer-is-continue).

## Iteration 5 (convergence run)

Restored iteration 4 (`825b7c6`) and applied a prioritized convergence change list. Goal:
clear the ONE high-severity issue, the two invariant regressions, and three med issues that
kept the loop from converging — without regressing any locked invariant. No rebuild; every
prior win preserved. Single self-contained file, inline CSS+JS, native dark tokens.

### What changed (by priority)

1. **P1 (HIGH) — sign-off overflow actually collapses.** `#signmore .needmore-b` carried
   `display:flex` at specificity (1,1,0), overriding both `.needmore-b{display:none}` and the
   `.needmore.open` toggle — so the overflow body was permanently visible and the chevron was a
   no-op. Split into `#signmore .needmore-b{padding:8px}` (no display) + `#signmore.open
   .needmore-b{display:flex…}`. Verified live in **dense**: at rest the body computes
   `display:none` / height 0 (3 rows + a collapsed "+N more to sign off"); clicking the header
   flips it to `display:flex` / height 468 (6 rows) and re-collapses. This clears the high issue,
   the invariant #5/#6 regression, and the dense wall-of-rows partial-fail in one fix.
2. **P2 — single-source the sign-off count.** The Sign-off rail pill now drops its number when
   `needs===0` (calm/nogit), mirroring the Running/Merged pills. The obligation count now lives in
   exactly one place per hero state: the hero headline + the "Awaiting your sign-off" strip header
   (invariant #1). Verified: calm rail pills render `["Running","Merged","Healthy · 1 project"]`
   with no numbers.
3. **P3 — rail no longer contradicts the blocked hero.** The "Everything healthy — nothing needs
   you" fallback pill is now gated on `needs===0`. In **blocked** the rail is empty under the
   "6 things need you" hero (verified `#rail .pill` = `[]`) instead of asserting all-clear.
4. **P4 — honest running spread in the scale hero.** "N running across {projects}" now counts
   only projects with running/looping work (`projNeeds(p).run>0`), labelled "active projects",
   instead of the whole fleet. Verified in **scale**: subline reads "12 running across 12 active
   projects" and the recomputed active-project count is 12 — screenshot and code now reconcile
   (was 31 vs 51).
5. **P5 — collapsed-card summary reconciles with the dot-strip.** Dropped the verbatim-redundant
   "All workstreams have met their Definition of Done" prose pole line when all scoped workstreams
   are done (the gauge line already says it). When loop workstreams are excluded from the gauge
   denominator, the line now names the denominator ("scoped workstream") and appends "· N loop
   running". Verified in **calm**: wealthlens/zippy read "1 of 1 scoped workstream met DoD · 1 loop
   running" against a 2-dot strip (green + cyan) — the count and the dots now agree.
6. **P6 — invariant #2 future-proofing.** The base `.iterspark i` bar is now the MUTED token; cyan
   is opt-in only via an explicit `.iterspark.live` modifier (no grounded live call site exists). A
   future live spark call site can no longer silently render a decorative status-cyan meter.
7. **P7 (safe subset) — low-severity polish.** (f) dropped the ordinal numbers on the hedged
   `~ parsed from notes` planned-queue chips (no grounded ordering); (h) re-coloured the artifact
   preview sparkline to a neutral stroke, not status-cyan (it is rendered output, not a status
   signal); (b) commented the synthesized diff-hunk / doc-markdown in `artifactPreview()` as
   mock-only with the production source (`/api/git/commit`, write/edit tool_results); (c) added a
   production-gating note to `loopMinutes()` (gate on stored `loopStartedAt`, drop the meta-text
   parse). Deferred the multi-render-path items (a single-project crumb suppression, e mixed-tag
   dedupe, g blocked face-number-over-unrun) to avoid regression risk on a convergence run.

### UI → signal grounding (deltas this iteration)

- **Sign-off overflow** — `#signmore` is purely presentational collapse of the same lifted
  sign-off strip rows (each backed by `progress.allMet` + a pending manual gate, spec §5.2/§6.4);
  the fix changes only CSS display, not what is asserted.
- **Scale hero "active projects"** — counts `ProjectRollup`s with `activeSessionCount>0`
  (`runtime.isRunning` across the project, spec §3), never the dormant tail.
- **Collapsed-card gauge** — "k of n scoped workstreams" is the project `ProgressSnapshot` over
  non-open-ended workstreams; open-ended loops are excluded from the denominator (no terminal DoD,
  spec §5.4) and surfaced explicitly as "· N loop running" so the gauge never silently disagrees
  with the dot-strip.
- **Iteration spark** — remains inside the muted "proposed" band only; the base hue is now neutral
  so the status-only colour ration (invariant #2) cannot be breached by a future live call site.

### Scenarios re-verified live (1440×900, 0 console errors)

default ("2 things need you") · scale ("12 running across 12 active projects", attention-driven
cards + grouped Running + dormant, no h-scroll) · dense (sign-off overflow collapsed at rest —
3 rows + "+N more", body `display:none`; opens on chevron) · calm ("Nothing needs you. 2 loops
running", cards read "1 of 1 scoped workstream met DoD · 1 loop running" matching the 2-dot strip,
no redundant pole prose, rail pills carry no numbers) · blocked ("6 things need you", empty rail —
no all-clear contradiction, top-2 full + "+4 more need you" by blast radius) · empty (Project ›
Workstream › Session › DoD onboarding, register/attach/set-DoD) · expand (honest k-of-n rings,
mixed-sources gauge, "in Needs you ↑" routing) · continue (Plaid elicitation + quick-reply chips
prefilling "Ask pi…" composer = answer-is-continue, "your reply goes straight to the agent").

---

## Iteration 6 (convergence run)

Restored iteration 5 (`d1cc533`) and applied a prioritized 8-item change list. Goal: clear the
two remaining MED convergence blockers (both count-reconciliation/ambiguity — the exact failure
class this design kept regressing on) plus six LOW grounding/single-sourcing nits, without
regressing any locked invariant. No rebuild; every prior win preserved (the cardLive
attention-routing fix, the single sign-off action heading, honest k-of-n rings, answer-is-continue,
attention-driven disclosure, no instrument-panel wall at any scale). Single self-contained file,
inline CSS+JS, native dark tokens. Verified live at 1440×900 with 0 console errors.

### What changed (by priority)

1. **P1 (MED, blocker) — every counted project now has a navigable home in the grid.** In
   iteration-5 `renderGrid`, sign-off-class projects were filtered into `signoff` but only rendered
   when nothing was attn/active; otherwise they appeared as neither card nor row while the
   "Projects N" header still counted them (default: header said 3, only 2 cards — ai-education
   vanished). Fix: render the non-promoted `signoff` array as collapsed **navigate-only** rows in a
   small "Awaiting sign-off" group card (`#sec-signoff-grid`) via `renderRow(p,{navOnly:true})`.
   The `navOnly` flag threads through `renderWsList → renderWorkstream → renderSession`, where a
   sign session opens to "Review" and its inline Sign-off button is suppressed — so the canonical
   sign-off ACTION stays solely in the lifted strip (carry-fwd #B: no double action surface). The
   count reconciles (2 cards + 1 row = 3) and invariant #5's dense-row treatment is satisfied.
   *Verified:* `#sec-proj .cnt` = "3"; `.pcard` count = 2; `#sec-signoff-grid .prow` = 1
   (ai-education); `#sec-signoff-grid [data-signoff]` = 0 (navigate-only).

2. **P2 (MED, blocker) — disambiguated the two sign-off counts on the project card.** The
   session-grain countPill `${c.sign} to sign off ↑` and the workstream-grain gauge clause
   `· N pending sign-off` shared the bare "sign off" label and diverged sharply at dense scale
   (9 sessions vs 2 workstreams), reading as rival counts. Dropped `pendTxt` from the gauge caption
   entirely — the caption is now purely DoD progress ("N of M scoped workstreams met DoD · K loop
   running"); the pill + lifted strip own the sign-off obligation (invariant #1). *Verified:* in
   dense, caption reads "3 of 7 scoped workstreams met DoD · 1 loop running" with no "pending
   sign-off" clause; the pill reads "9 to sign off ↑".

3. **P3 (LOW, all four lenses) — planned-queue ordinals removed everywhere.** Dropped the `qn`
   ordinal span in `renderPlanned` and changed both drawer-transcript plan listings from `${i+1}.`
   to a non-ordinal `· ` bullet, since the notes-parse cannot ground a sequence. Removed the now-dead
   `.qchip .qn` CSS rule. *Verified:* loop transcript plan renders "· fix flaky e2e / · upgrade
   vitest / …" with no "1." ordinal.

4. **P4 (LOW) — trimmed the duplicate sign-off count near the strip.** Removed the strip-header
   `<span class="cnt">${c.sign} done</span>` when `c.sign>1` (the adjacent "Sign off all N" button
   already carries the count ~2cm away); kept the cnt only in the single-item case. *Verified:*
   default (sign=3) shows no cnt pill, only "Sign off all 3".

5. **P5 (LOW) — single-sourced the planned count.** Dropped the "N planned, not started" fragment
   from the needs>0 hero subline (mirroring how sign-off is already kept out); the rail Planned pill
   + Planned section header own it. Made the trailing subline period conditional so an empty
   `subBits` cannot leave an orphan ".". *Verified:* needs>0 subline has no "planned".

6. **P6 (LOW) — singular-world phrasing + loop punchline.** (a) When exactly one project has running
   work, the subline reads "N running in {project}" instead of the awkward "N running across 1
   active project". (b) On collapsed loop cards, the queue-growth delta is a dedicated muted card-face
   chip ("queue 3→17", from `queueStart`/`queueTotal` on the view model) rather than relying on the
   clamped live string that truncated the punchline. *Verified:* mixed scenario subline reads
   "3 running in wealthlens"; loop scenario shows a "queue 3→17" chip.

7. **P7 (LOW) — grounding hygiene (batched).** (a) Added a production-derivation note for `failAction`
   where it is consumed (heuristic from the failing criterion/error: command-fail → "Re-run <cmd>",
   git conflicted → "Resolve conflict", auth-keyword → "Re-authenticate", default "Re-run").
   (b) Added one non-elicited idle session (`s2b`, `status:"block"`, `elicited` omitted) to the
   default world so the honest "Idle · may be waiting" degradation actually renders — it stays out of
   the bold "needs you" count and shows as the quiet "N may be waiting" hero tally; cardLive also
   degrades honestly if such a session is ever the card-face top. (c) Manual/visual checks now carry
   `kind:"manual"` (drop the faked `exit:0`) and render "reviewed" via a new `checkChip()`/
   `isManualCheck()` helper instead of a fake command exit code. (d) Removed the dead `dIter:4`
   fixture field. *Verified:* default expand shows "Idle · may be waiting"; hero shows "1 may be
   waiting"; mixed m4 spark shows "✓ visual check · reviewed" (no "exit 0" anywhere).

8. **P8 (LOW) — interaction accent shifted off the running cyan.** `--accent` was `#7dd3fc`,
   identical to `--st-run`, so hover borders / focus rings / the brand-dot glow momentarily read as
   a "running" status cue. Shifted to a soft indigo `#8ea2f0` — clearly distinct from running-cyan
   and sign-off-purple — protecting invariant #2's "cyan == running" contract. (The dead topbar
   search icon / snooze affordance were deferred as low-value on a near-converged run.)

### UI → signal grounding (deltas this iteration)

- **Sign-off grid group** (`#sec-signoff-grid`) — navigate-only rows over the same `ProjectRollup`s
  that are `signoff`-class (`progress.allMet` + a pending manual gate, spec §5.2/§6.4). It asserts
  nothing new — the rows just give counted projects a home and a drill-in; the sign-off PATCH
  (`/api/dod/criterion/:id`, spec §6.4) fires only from the lifted strip.
- **Gauge caption** — now exclusively the project `ProgressSnapshot` over non-open-ended workstreams
  ("k of n scoped workstreams") + the `loop` count; the sign-off obligation is no longer mixed into
  it, so two different grains can never be mistaken for rival counts.
- **`failAction`** — a presentation label heuristically derived from the failing criterion / the
  `tool_execution_end(error)` that drove the `fail` status (spec §5.3); never a gate, never an
  asserted signal pi can't ground.
- **Non-elicited idle block** — degrades to the quiet "may be waiting" tally + an "Idle · may be
  waiting" badge (spec §5.3); it is NEVER promoted to the bold "things need you" count, because a
  free-text stop cannot be proven a blocker without a structured elicitation.
- **Manual/visual check** — rendered as "reviewed" (no exit code), since a manual review has no exit
  code; only a real `command` check (`executeBash` exit, spec §6.2) shows "exit N".
- **`queue N→M` chip** — best-effort from `plannedQueue` (`source:"notes"`, spec §3); muted grey (a
  count, not a status) per invariant #2, and explicitly hedged as expected loop growth, never an alarm.

### Scenarios re-verified live (1440×900, 0 console errors)

default ("2 things need you"; 3 projects = 2 cards + 1 navigate-only sign-off row; "1 may be
waiting" tally; cardLive names the blocker and points up) · single · scale ("12 running across 12
active projects", attention-driven cards + grouped Running + dormant, no h-scroll, no instrument
wall) · dense (8 workstreams / 40 sessions calm; caption "3 of 7 scoped workstreams met DoD · 1
loop running", pill "9 to sign off ↑" — no rival counts) · calm ("Nothing needs you. 2 loops
running. You can close this tab.", only cyan) · blocked ("6 things need you", top-2 full + "+4 more
need you" by blast radius, destructive migration first) · loop ("queue 3→17" chip on the card face)
· nogit (doc DoD → "reviewed", "Archive" not merge) · mixed (singular "3 running in wealthlens";
visual check "reviewed") · empty (Project › Workstream › Session › DoD onboarding) · expand (honest
k-of-n rings, "Idle · may be waiting" degradation) · continue (quick-reply chips prefill the "Ask
pi…" composer = answer-is-continue).

## Iteration 7 (convergence run)

Restored the iteration-6 deliverable (`0f01219`) and ran the prioritized change list. The change
list's overriding finding (P1) was a **pipeline-integrity** issue: the four lenses had scored a
stale *Iteration-4* checkpoint, not the shipped artifact, so they flagged offenders (live
`loopHealth()`, live `iterSparkHtml()`, live queue ordinals, running-cyan `--accent`, a no-space
delta clause) as present that the iteration-6 file had already resolved. This run reconciled the
critique against the **actual on-disk file** before applying anything, so every convergence claim
below is verified against the artifact that ships — not a builder narrative.

### Pipeline reconciliation (P1) — verified against the on-disk file

The critiqued offenders P2–P5 do **not** exist in the iteration-6 deliverable; confirmed by direct
inspection rather than trusting the changelog:

- **P2 (loopHealth):** `grep "loopHealth(" index.html` → exactly **one** hit, and it is the
  `loopHealth() DELETED` comment (line 1367). **Zero call sites.** No amber stall / over-budget
  verdict flows into the hero headline, a rail pill, a workstream `loopBadge`, or a budget bar. The
  live loop badge is **elapsed-only** (`∞ {elapsed}` from the stored `loopStartedAt`, spec §5.4),
  line 2206.
- **P3 (iterSparkHtml):** the only call site is inside `proposedLoop()` (line 2164), which renders
  in the muted, explicitly **"— not live yet"** `.proposed` band. Base spark bars are the muted
  token (`--muted` 45%); cyan is an opt-in `.iterspark.live` modifier with **zero call sites**
  (`grep` for the live class → 0). It can never read as a live status meter.
- **P4 (queue ordinals):** `grep 'class="qn"' index.html` → **0**. Planned-next chips are plain
  hedged items (`~ parsed from notes →`, `~N more planned`), with no `1·2·3` sequence pi cannot
  ground (no TodoWrite/plan primitive, spec §1.3).
- **P5 (--accent):** already `#8ea2f0` (soft indigo) at line 15, distinct from running-cyan
  `--st-run #7dd3fc`. Confirmed live: `getComputedStyle` → `{accent:"#8ea2f0", stRun:"#7dd3fc"}`.
  Interaction color no longer collides with the running-status hue (invariant #2).

### What actually changed this iteration

1. **P6 (the one genuine residual) — fixed the hero subline punctuation collision.** On the single
   most-read line, the running/loop bits closed with a period (`${subBits.length?".":""}`) and the
   delta clause carries its own leading separator (CSS `.delta::before{content:"·"}`), so the line
   rendered an awkward **"1 may be waiting. · Since you last looked"** — a period jammed directly
   against the separator. (The change list described this as a no-leading-space concatenation
   producing "waiting.Since"; in the iteration-6 file the `::before` separator already prevented the
   run-together, leaving only the doubled punctuation.) Fix: compute the delta clause once per call
   site and **suppress the trailing period when a delta follows** it (both `heroHtml` call sites,
   lines ~1676 and ~1701; the calm-branch variant keeps the period after a `closeTab` sentence so
   "You can close this tab. · Since…" stays two clean sentences). The line now reads
   **"1 may be waiting · Since you last looked 2h ago: +1 merged +331/−96 lines."**
   *Verified live + by zoomed crop.*

2. **P7 — re-verified ALL ten scenarios against the shipped artifact** at 1440×900 (see below).

### UI → signal grounding (zero ungrounded live elements)

Every live element traces to a real or feasible-proposed signal in `DATA-MODEL-AND-API.md`:

- **needs-you count / hero** ← `isNeed` over runtime + structured elicitation (spec §5.3); a
  non-elicited stop degrades to the quiet "may be waiting" tally, never the bold count.
- **k-of-n rings** ← `computeProgress` over `CriterionEval` (spec §5.2); never an authored percent;
  mixed-source workstreams switch to a "k of n SESSIONS done" gauge (spec §5.5).
- **status hues** ← `WorkItemStatus` from runtime + git + DoD (spec §5.3); color is status-only.
- **live loop badge** ← `∞ {elapsed}` from stored `loopStartedAt` (spec §5.4) — iteration count,
  rhythm sparkline, and budget cap are **proposed-only**, in the muted band.
- **merged / sign-off receipts** ← `git_merged` (`merge-base --is-ancestor`) + manual gate
  (spec §6.4); merge is a separate step, never one "Sign off & merge" button; no-git DoD shows
  "Archive".
- **Continue / quick-reply chips** ← `POST /api/prompt` (spec §4.1); the composer is the answer.

### Scenarios re-verified live (1440×900, 0 console errors, scrollWidth === clientWidth = 1440)

default · single · scale (51 projects → "12 running across 12 active projects", attention cards +
grouped Running + dormant collapse, no h-scroll, no instrument wall) · dense (8 ws / 40 sessions,
calm, long-pole named, sessions capped "+N more") · calm ("Nothing needs you. … You can close this
tab.", only cyan, no fabricated badges) · blocked ("6 things need you", top items full + "+4 more
need you" by blast radius) · empty (Project › Workstream › Session › DoD onboarding + detected
folders) · loop (queue 3→17 chip, elapsed-only badge, proposed band for telemetry) · nogit (doc DoD
→ "reviewed", "Archive" not merge) · mixed ("k of n SESSIONS done" gauge, never a blended percent).
Expand → workstream → sessions and open-session (composer ready, chips prefill) both verified;
walkthrough re-recorded against the patched file.
