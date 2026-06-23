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

---

## Adversarial review (red team vs. defender, judged)

The convergence run above grades the design with friendly lenses. To stress it harder, the
artifact then went through four rounds of adversarial review on the `dashboard-design` branch,
each round structured as a debate rather than a single critique:

1. **Four red-team angles attacked.** Each round, four independent adversarial lenses tried to
   break the design — a feasibility/honesty angle (does a "grounded" element actually trace to a
   real signal in `DATA-MODEL-AND-API.md`?), a calm/IA angle (does the design keep one voice and
   one count?), a scale/chaos angle (what happens at 50+ projects, all-blocked, multi-day loops?),
   and a concept-maturity angle (how much value depends on primitives that do not exist yet?).
   Each angle filed charges with a claimed severity.
2. **A defender rebutted with on-disk evidence.** Every charge was answered by reading the actual
   committed `index.html` and the spec, not the lens's paraphrase of it — citing line numbers,
   call sites, and the data model.
3. **A neutral judge ruled each charge.** The judge re-verified both sides against disk by
   grep/sed and marked each charge **upheld** (high or med), **overruled**, or **partial**. A round
   converged only if integrity passed and no charge was upheld above low severity.

### Per-round results

| Round | Commit    | Charges | Upheld high | Upheld med | Overruled | Integrity | Converged |
| ----- | --------- | ------- | ----------- | ---------- | --------- | --------- | --------- |
| 1     | (pre-fix) | 20      | 0           | 6          | 3         | pass      | no        |
| 2     | `841b2dc` | 20      | 2           | 2          | 3         | pass      | no        |
| 3     | `554e3df` | 21      | 1           | 6          | 5         | pass      | no        |
| 4     | `b0709e2` | 22      | 1           | 2          | 5         | pass      | no        |

Integrity passed every round (JS parses clean, all 10 scenarios render, zero console errors), so
the design was never structurally broken. It also never converged: each round surfaced at least one
real high- or medium-severity issue, the team fixed it, and the next round found the next one. The
high-severity count fell from 2 to 1 and stabilized at a single cold-start regression.

### Most notable upheld issues, and the fixes

- **Round 2 — loop-elapsed honesty contradicted its own annotations (HIGH).** The design's loudest
  honesty claim was false: code comments asserted the ungrounded `meta`/`loopTime` text-parse
  fallback had been deleted "so the demo can never silently render the banned path," but it was live
  at three of four call sites (workstream badge, session row, drawer). Only the hero used the
  grounded `loopMinutes`. Fixed by routing every loop badge through `loopMinutes` → `fmtMin`.
- **Round 2 — `attn` projects were uncapped (HIGH).** Every other list (active, dormant, sign-off,
  workstreams) capped into an overflow row; `full = attn.concat(...)` was never sliced and there was
  no virtualization, so an all-blocked fleet painted the instrument-panel wall that locked invariant
  #6 forbids "at ANY scale." Fixed by capping `attn` into an overflow row like `active`.
- **Round 3 — `dotStrip()` was the one uncapped list renderer (HIGH).** It sat on the collapsed card
  face, so a 40–60 workstream project painted an unbounded dot wall. Fixed with a slice plus a
  `+N` tail, matching the cap pattern used everywhere else.
- **Round 3 — fabricated git numstat on a `spark` artifact (MED).** A `spark` kind was not in the
  artifact union, so `artChip` fell through and drew an invented `+88/−402` numstat on a manual PNG
  snapshot. Fixed by handling the kind explicitly so the collapsed face stops mislabeling it.
- **Round 4 — open-ended ring shown without an actual loop (HIGH).** `allOpenEnded = g.total===0`
  (`index.html:2305`) never checks for a real loop, so a project whose workstreams all lack a DoD —
  the common cold-start path after `registerProject` — rendered a cyan ∞ "looping · open-ended"
  ring, a grounding lie in the one reserved status color (invariant #2). One-line fix: gate on
  `loopWs>0`. (This is the open finding at HEAD `b0709e2`; the gate `loopWs` exists at line 2322 but
  is not yet wired into `allOpenEnded`.)
- **Round 4 — `fmtMin` had no day rollover and `byAttention` had no tiebreaker (MED, MED).** A
  three-day loop rendered as "72h" — the sole grounded loop signal made least legible exactly when a
  runaway loop matters most — and `byAttention` (line 862) sorted without an id tiebreaker, so the
  six-item fold collapsed to non-deterministic insertion order. `renderNeeds` (line 1976) already
  carries the exact `localeCompare` stable-sort fix with a comment explaining the failure mode, so
  both are one-line ports of a pattern the team already uses.

The earlier-round medium issues — name-overflow clamp asymmetry, per-session vs. per-root
`git_clean` scoping, carrying quick-reply chips into overflow rows, and the git-criteria staleness
asterisk — were all real and all fixed by the same disciplined pattern reuse.

### Most notable overruled charges (where the adversary was wrong)

The debate did not just capitulate to the red team. The judge overruled the loudest charges in
every round after checking them against disk:

- **"No stored idle timestamp" (R1, overruled).** The spec grounds idle duration as "N min since
  `agent_end`" with a durable `SessionInfo.modified` field; the premise was factually wrong.
- **"Two heroes break calm" (R2, overruled).** One `<h1>` owns the only count and the band header
  explicitly carries none — the charge conflated a band header with a second hero.
- **"Needs-you count includes unproven stops" (R2, overruled).** Non-elicited stops are honestly
  excluded via `c.softwait`; the grounding rule was working, not vaporware.
- **"Rings run `executeBash` on render" (R3, overruled).** `critUnrun` already excludes unrun
  command criteria; the rings display a cached `evaluatedAt`, they do not execute on paint.
- **"`git_merged` is ungrounded at scale" (R4, overruled).** `gitLog()` carries `%ad` (date) and
  `%H`/`%h` (sha) on every commit (`server.ts:427`), so `mergedAt` and the merged sha are derivable;
  a met `git_merged` is permanent, so the TTL-staleness dilemma the charge posed does not exist.
- **"The plan queue is vaporware" (R4, overruled).** `plannedQueue` is a spec-typed
  feasibly-proposed field rendered with the prescribed "~N more planned" hedge.

A recurring adversary failure mode was equating a grounded primitive with an ungrounded one:
displaying a cached `evaluatedAt` is not running a command on render; a local merge-base proxy is
not a remote PR/CI check; declining to fabricate a stall verdict is the grounding rule working, not
hiding a fact. The judge narrowed those to their real, bounded kernels rather than accepting the
headline severity.

### Final verdict

The design survived adversarial scrutiny, wounded but honest. Across four rounds it never failed
integrity and never lost its core honesty and calm invariants; the red team landed six genuine
high-severity hits over the run, every one a concrete, mechanical fix (a missing cap, a mis-routed
helper, an ungrounded ring), and the friendly review had missed all of them. As of HEAD `b0709e2`
one high-severity cold-start regression (the `allOpenEnded` ring) and two trivial one-line chaos
fixes (`fmtMin` day rollover, `byAttention` tiebreaker) remain open — so the artifact is not yet
converged, but the gap between it and convergence is three known, scoped edits rather than any
structural or conceptual flaw. The honesty discipline held where the design claimed it: the only
place the code contradicted its own honesty annotations (the round-2 loop-elapsed surface) was
caught and fixed.

---

## Visual review (steelman vs. red team, judged on screenshots)

The adversarial run above debated the *code*: it grepped `index.html`, traced helpers, and argued
about grounding. This second run debated the *picture*. A steelman and a red team each **looked at
the rendered captures** — all thirteen-plus screenshots in this folder (the scenario set:
`scn-calm`, `scn-blocked`, `scn-coldstart`, `scn-loop`, `scn-mixed`, `scn-scale`, `scn-nogit`,
`scn-dense`, `scn-single`, `scn-empty`, plus the interaction states `state-coldstart-expanded`,
`state-dormant-expanded`, `state-continue`, `state-drill`, `state-expand`, and `home`) — zoomed
into contested regions at up to 10x, and argued about what the design *communicates to a human
looking at it*: hero voice, color meaning, scannability, card silhouette, layout rhythm, and
whether a glance tells the truth. A convergence judge then re-checked every charge against both the
pixels and the code and graded the artifact's visual quality directly.

### Per-round scorecard

| Round | Commit    | Steelman grade | Judge visual grade | Charges | Upheld HIGH | Upheld MED | Overruled | Converged |
| ----- | --------- | -------------- | ------------------ | ------- | ----------- | ---------- | --------- | --------- |
| 1     | (pre-fix) | 8              | 8                  | 19      | 5           | 3          | 2         | no        |
| 2     | `8bf3649` | 8              | 8                  | 18      | 1           | 2          | 3         | no        |
| 3     | `e3ec889` | 8              | 8                  | 16      | 0           | 3          | 4         | no        |

Visual grade held at 8/10 the whole run while the defect profile drained from the top down: five
HIGH in round 1, one in round 2, zero by round 3. The remaining blockers are bounded medium-grade
layout and keying issues, not conceptual ones — the same shape as the code run, where the design
never lost a core invariant.

### Most notable UPHELD visual/UX issues — and how they were fixed

- **The cold-start hero lied at a glance (HIGH, rounds 1–2).** A registered project with *no*
  Definition of Done rendered as `healthy` at every collapsed surface — `newsvc … healthy` under
  "HEALTHY & DORMANT", and a hero reading "Nothing needs you." The eye was told everything was fine
  when a project explicitly needed setup. **Fixed structurally:** cold-start now gets its own indigo
  voice-changing hero — "1 project needs setup — author a Definition of Done to start tracking." —
  its own "NEEDS SETUP" project group, a filled "Set a Definition of Done" CTA, and a purple
  `Needs setup` chip (see `scn-coldstart.png` / `state-coldstart-expanded.png`). The unset state is
  routed out of `healthy`/`dormant` entirely instead of silently folding into calm.
- **"Continue the conversation" was not the consistent primary (MED, rounds 1–2).** The failed
  cal-sync card taught "Re-authenticate" as its filled button while the neighboring blocked card said
  "Continue" — breaking the reflex that *the answer is always to continue*. **Fixed:** every NEEDS
  YOU card now carries a single filled-primary "Continue the conversation"; the remedy
  (Re-authenticate / Re-run) is demoted to the secondary outline style (`scn-blocked.png`,
  `home.png`).
- **A status hue leaked onto an action control (MED, round 2).** The "Triage all in focus" bulk
  button was painted the same amber reserved for Blocked status, on a six-blocked screen. **Fixed:**
  the focus button now uses the indigo interaction accent, never a status color — matching the
  sign-off bulk button, which already proved the pattern (action ≠ status).
- **Three card silhouettes in one scale row + an indented auto-expanded card (MED, round 3,
  open).** In `scn-scale.png` the project cards don't share one silhouette (filled vs. empty
  top-right slot, ring vs. `∞` baseline, one subtitle truncates), and the auto-expanded mixed card
  in `scn-mixed.png` renders narrower/indented than the full-bleed panels above it and clips at the
  fold. These are the bounded layout fixes still queued at the cap.

### Most notable OVERRULED charges (where the adversary was wrong on looking)

The red team's loudest "dishonesty" charges mostly failed once the judge actually looked at the
pixels:

- **"The calm ring is a lie" — overruled.** The "1/1 met DoD" ring counts only the merged
  workstream and discloses "1 loop running" separately; both numbers are literally true at their own
  grain (`scn-calm.png`).
- **"A free-floating amber blast-radius pill" — overruled.** The blast-radius pill is *red* on the
  failed card and amber on the blocked card — each follows its own card's single status hue, not a
  stray amber (`scn-blocked.png` / `home.png`).
- **"The dormant green dots are fake idle indicators" — overruled.** The green dots are a
  per-merged-workstream tally mapping 1:1 to the "N merged" count — green means merged, exactly as
  labeled.
- **"The sign-off strip is a faint unreadable ledger" — overruled.** The strip is comfortably
  spaced and legible (`home.png`, `scn-nogit.png`); the only residue is a low-grade scan double-take
  between a workstream-grain ring and a session-grain badge.
- **"Verified receipts are loop auto-merges" / "PROJECTS 51 shows only 3" — overruled (round 1).**
  The receipt carries an inline `?` provenance glyph on a real terminal merge sha, and the "only 3"
  was a viewport-fold crop — the rollup group and rail jump exist below it (`scn-scale.png`).

A recurring adversary failure mode, mirroring the code run, was reading a two-grain truth as a
contradiction: a workstream-level ring and a session-level badge can disagree numerically and both
be honest. The judge narrowed those to their real residue — a scannability nit — rather than
accepting the "lie" framing.

### Final verdict

Looked at, not just read, this is a genuinely accomplished and opinionated dashboard. The single
voice-changing hero that owns the only obligation count holds from one project to fifty-one; color
is rationed to a disciplined status palette so the only saturated things on screen are the things
that need a human; the k-of-n rings are honest about what they count; the quiet-Sunday view is
truly calm and brave enough to say "You can close this tab"; and "Continue the conversation" is the
one filled verb on every card that needs you. The visual run earned a steady 8/10 and drove the
honesty defect the code reviews never saw — a cold-start project rendering as `healthy` to the
naked eye — from a five-HIGH cluster down to zero, fixing it structurally rather than papering over
it. It stops short of converged only on three bounded medium layout/keying issues (uneven scale-row
silhouettes, an indented auto-expanded card, and a fixture-keyed mixed-source fork): real, visible,
and worth fixing, but mechanical, not conceptual. The experience a person actually sees is calm,
legible, and honest — and now honest in exactly the place a glance used to be reassured by a lie.
