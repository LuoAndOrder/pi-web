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
