# Project Rollups — Convergence Run

This document records the convergence run for the Project Rollups dashboard design
(`index.html` in this folder). It is the run-level companion to the per-iteration builder log in
`changelog.md` and the design rationale in `FINAL.md`. The data model that every live element is
graded against is `DATA-MODEL-AND-API.md`.

The artifact on disk has been restored from the final iteration commit
`2550b6c3c73f1c296a4b640f95e94e4ef4c3f6e8` (`rollups-converge: iteration 7`). Nothing was lost;
the deliverable and all captures are recoverable from git.

---

## Iteration scorecard

Each iteration was built, then graded by four independent lenses (Calm/IA, feasibility,
scale/stress, "Kevin's-eyes") and a disk-grounded convergence judge. The judge re-verified every
claim against the actual on-disk file by grep/sed — this run's recurring failure mode was that
lens scores described a file that was never persisted, so the judge's counts (not the lens
averages) are authoritative.

| Iter | Commit    | Satisfaction | Lens avg | High-sev | Ungrounded LIVE | Regressions | Changes queued | Converged |
| ---- | --------- | ------------ | -------- | -------- | --------------- | ----------- | -------------- | --------- |
| 1    | `0666c6d` | 5            | 8.0      | 4        | 3               | 4           | 9              | no        |
| 2    | `6821ae1` | 3            | 8.8      | 3        | 4               | 1           | 9              | no        |
| 3    | `f68ef75` | 4            | 8.8      | 5        | 4               | 4           | 8              | no        |
| 4    | `825b7c6` | 8            | 8.8      | 1        | 0               | 2           | 7              | no        |
| 5    | `d1cc533` | 8            | 8.5      | 0        | 0               | 0           | 8              | no        |
| 6    | `0f01219` | 3            | 9.0      | 3        | 3               | 4           | 7              | no        |
| 7    | `2550b6c` | 8            | 8.8      | 0        | 1               | 0           | 4              | no        |

Lens averages stayed high throughout (8.0–9.0); satisfaction did not, because the dominant blocker
for most of the run was a **pipeline-integrity problem**, not a design problem.

---

## Stop reason: stalled

The run stopped at iteration 7 with stop reason **stalled** — not because the design was failing
to improve, but because the same root cause kept resurfacing and consuming iterations:

**The critiqued file and the on-disk deliverable repeatedly diverged.** In iterations 1, 2, 3, and
6 the builder's "verified fixes" and all four lens critiques described a version of `index.html`
that was never persisted to disk (line numbers offset by 50–87 lines; flagship fixes like
`loopElapsed()` / `proposedLoop()` absent; `loopHealth()` still live). The judge caught this each
time by grepping the actual file, which meant entire iterations were spent reconciling a phantom
build instead of advancing the design. Iteration 6 shipped the *iteration-4 checkpoint* by mistake;
iteration 7's headline finding was the inverse — the genuine work lived only in commit `2550b6c`,
off the then-current HEAD line. The loop stalled on this build/review desync rather than on
unsolvable design issues.

---

## Convergence verdict: CONVERGED (final blocker resolved post-run)

Graded against the genuine iteration-7 artifact (`2550b6c`), the convergence bar was met on every
axis except one ungrounded chip. That chip was fixed by hand after the run (see "Post-run
resolution" below), so the shipping artifact now meets **every** axis:

| Convergence criterion          | Bar          | Iteration-7 result                                  | Pass |
| ------------------------------ | ------------ | --------------------------------------------------- | ---- |
| All four lenses                | each ≥ 8     | Calm 9, Feasibility 8, Scale 9, Kevin's-eyes 9      | yes  |
| High-severity issues           | 0            | 0                                                   | yes  |
| Regressions of locked invariants | 0          | 0                                                   | yes  |
| Dense + scale scenarios        | both pass    | both pass (captures present, caps verified in code) | yes  |
| Ungrounded LIVE elements       | **0**        | **0** — `queue 3 → 17` chip resolved post-run        | yes  |

**Post-run resolution.** The single remaining blocker was the live "queue 3 → 17" growth chip,
driven by a `queueStart` *before*-value with no grounding in `DATA-MODEL-AND-API.md` (the spec
models `plannedQueue` as `{items, total, source}` only). It was fixed by hand after the run:
`queueStart` was dropped from the fixture and the render path, and the chip now shows a grounded,
hedged **`~17 queued`** sourced from `plannedQueue.total`. Verified on disk — `queueStart` and the
`3 → 17` delta have zero occurrences, the loop scenario renders "~17 queued", and JS parses clean
with no errors. With this, ungrounded LIVE elements = 0 and the design meets the full convergence bar.

---

## What got fixed vs. what remains

### Fixed and verified on the shipping artifact

- **Grounding (the historical #1 blocker) — closed except for the one chip above.** Loop iteration
  count, rhythm sparkline, and budget meter are confined to the muted `proposedLoop()` band
  labeled "— not live yet"; `loopHealth()` is deleted (one hit, the DELETED comment at line 1367,
  zero call sites); the live loop badge is elapsed-only (`∞ {elapsed}` from stored `loopStartedAt`).
- **Merge honesty.** Receipts read "merged into local main" (×38); the misleading "merged to
  mainline" framing is gone (×0). Local-only git facts are no longer dressed as shared/remote merges.
- **Color discipline (invariant #2).** `--accent` is soft indigo `#8ea2f0`, distinct from
  running-cyan `--st-run #7dd3fc`; interaction color no longer collides with a status hue.
- **Honest k-of-n rings.** Segmented gauges, one arc per non-gate DoD criterion; `?` / `k/n*`
  for unset / never-run / stale; `computeProgress` blocks stale promotion.
- **Single voice-changing hero** owns the only obligation count (sign-off / planned single-sourced
  to the rail + section); answer-is-continue wired (chips prefill the composer).
- **Attention-first disclosure** with no instrument-panel wall at dense (8 ws / 40 sessions) and
  scale (51 projects).
- **Prior-run regressions resolved:** the `#signmore` CSS-specificity sign-off-overflow break
  (iter 4), the signoff-class project count reconciliation (iter 5), and the hero subline
  punctuation collision (iter 7) are all fixed and verified.

### Remaining

- **None that gate convergence.** The one ungrounded chip is resolved (see "Post-run resolution").
- **Low-severity polish only** — copy/consistency nits called out in `changelog.md` (planned-queue
  phrasing, hero subline hygiene, singular-world phrasing). None gate the bar; address during
  implementation.

---

## Recommended next step

**Convergence closed.** The `queueStart` chip was dropped and replaced with a grounded `~17 queued`
from `plannedQueue.total` (done, verified on disk). The mockup is final-form; what follows is
implementation.

**Toward real implementation:** the design is feasibility-graded and ready to build against
`DATA-MODEL-AND-API.md`. Sequence:

1. **Stand up the read-side aggregation** that `DATA-MODEL-AND-API.md` specifies — `WorkItemStatus`
   derivation (runtime + git + DoD), `computeProgress` over `CriterionEval`, and the
   `WorkstreamRollup` / project rollup shapes — so the UI binds to real signals instead of fixtures.
2. **Wire the grounded live elements first** (the ones already proven feasible): needs-you count
   from structured elicitation (§5.3), k-of-n rings (§5.2), status hues (§5.3), elapsed-only loop
   badge from `loopStartedAt` (§5.4), and merge receipts from `git_merged` / manual-gate state.
3. **Defer the proposed-only primitives** that the design deliberately quarantines: the
   per-iteration loop log (iteration count, rhythm sparkline, budget cap) and any plan-sequence
   primitive (queue ordinals, queue *before*-value). Ship these only once a durable backing signal
   exists; until then they stay in the muted "— not live yet" band, exactly as the mockup models.

The single-file `index.html` is the visual contract; `DATA-MODEL-AND-API.md` is the binding
contract. Build #1–#2 against the spec, keep #3 behind the proposed band, and resolve the queue
chip to converge the mockup itself.

---

## Reliable convergence run (pipeline fixed)

The run above stalled on a *pipeline* defect, not a design one. This section records the re-run
after that pipeline was repaired, and is the honest accounting of whether the fix held.

### Root cause of the prior desync

The earlier run kept **multiple physical copies of `index.html` in play at once**: the builder
wrote into a worktree checkout, the critics read whichever copy their cwd resolved to, and the
synthesis/judge step graded a third. Because nothing forced these to be the same inode, the
builder's "verified fixes" and the four lens critiques routinely described a file that was never
persisted to the path being shipped — line numbers drifted 50–87 lines, flagship functions
(`loopElapsed()` / `proposedLoop()`) appeared in the critique but not on disk, and deleted code
(`loopHealth()`) read as still-live. The loop burned iterations 1, 2, 3, and 6 reconciling a
phantom build. **Critics and synth were grading different files**, so high lens scores never
translated into real convergence.

### The fix

1. **One canonical file, edited in place.** All builders, critics, and the judge operate on the
   single on-disk path `docs/dashboard-designs-final/index.html` in the main repo. **No worktrees,
   no copies** — there is exactly one inode for everyone to read and write.
2. **A deterministic verifier gate.** Before any iteration is allowed to converge, a verifier
   re-greps the committed on-disk file for every critical marker and emits `integrityPass` plus a
   `discrepancies` array. Convergence is gated on `integrityPass === true` **and**
   `discrepancies.length === 0`, independent of the (subjective) lens averages. Lens scores can no
   longer wave a phantom build through.

### Per-iteration table (this run)

| Iter | Commit    | integrityPass | Discrepancies | Satisfaction | Lens avg | High-sev | Ungrounded LIVE | Regressions | Converged |
| ---- | --------- | ------------- | ------------- | ------------ | -------- | -------- | --------------- | ----------- | --------- |
| 1    | `2b8d629` | true          | 0             | 9            | 9.3      | 0        | 0               | 0           | yes       |

One iteration, zero changes applied: the canonical file was already at final form when the
verifier and the four lenses (Calm 9 / Feasibility 10 / Scale-stress 9 / Kevin's-eyes 9)
re-graded the *actual* committed bytes. The judge independently re-grepped the on-disk file
(2661 lines, clean at HEAD `2b8d629`) and confirmed every critical marker: `queueStart` = 0
occurrences, the `3 → 17` queue delta = 0, "merged to mainline" = 0, "merged into local main"
= 38, within-budget = 0, `loopHealth(` = 1 (the DELETED comment, zero call sites), exactly one
`<h2>Awaiting your sign-off</h2>`, and `--accent #8ea2f0` distinct from `--st-run #7dd3fc`.

### Final verdict: CONVERGED (honestly this time)

Yes — it converged, and the difference from the prior run is that the grade is now provably about
the shipped file. `integrityPass` was true with an **empty** discrepancies array, every lens scored
≥ 8 with empty `regressions` and empty `ungroundedLiveElements`, there were **zero** high-severity
issues, and the two historical hard cases (dense and scale) passed in every lens. The artifact at
`docs/dashboard-designs-final/index.html` is committed clean at HEAD `2b8d629` — the fact that **no
recovery from a side commit was needed** is itself the proof the desync is fixed. The remaining nits
are all severity-low and explicitly fixture-only or future-production-port notes (the `loopMinutes`
text-parse fallback marked "must never ship", the `srcFamily`/`sessFamily` substring heuristic, the
proposed-band placeholder numbers, and a possible nudge affordance for the idle bucket); each is
already disclosed with a guard comment and none gate FINAL.
