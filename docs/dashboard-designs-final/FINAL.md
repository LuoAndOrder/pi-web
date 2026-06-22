# Project Rollups — Final Design

The final mockup is `index.html` in this folder (a single self-contained file: inline CSS + JS,
pi-web's native dark tokens, a scenario switcher in the top bar). Supporting captures:
`home.png`, `scn-calm.png`, `scn-blocked.png`, `scn-scale.png`, `scn-empty.png`,
`state-expand.png`, `state-continue.png`, and `walkthrough.webm`. The data model and API behind
it are in `DATA-MODEL-AND-API.md`; the per-iteration critique log is in `changelog.md`.

This document covers the design thesis, how every rendered element maps to a real pi signal, how
the design behaves under each pressure-test scenario, the iteration history with scores, and the
open risks to settle before implementation.

---

## 1. The problem and the thesis

Kevin runs many agents across many repos. He has four oversight questions: what needs me, what
are the agents doing, what is done, and what is planned but not started. The failure mode the
brief explicitly rejects is the "instrument-panel wall" — a grid of equal-weight cards, each
carrying a row of labeled progress rings, that turns the 3-second whole-world read into a sea of
dials with no focal point. The second rejected mode is the "Triage Inbox": a flat list of every
blocker that loses prioritization the moment there is more than one.

The thesis is **one calm view with a single voice-changing hero**. The page routes the eye to the
human-blocking item and nothing else competes for that attention:

- **Hero owns the obligation count.** The headline changes voice with the world — "N things need
  you" when blocked, "Nothing needs you, 3 loops running" when calm, "N done — your sign-off is
  all that's pending" when only approvals remain. The count lives in exactly one place.
- **Color is rationed to status, never decoration.** Six status hues (running cyan, blocked
  amber, failed red, sign-off purple, merged green, idle grey) and nothing else. Source labels,
  lineage badges, and category counts are muted grey. Color in the rail means "actionable".
- **Progressive disclosure, attention-first.** Only projects that need you or are running render
  as full ring-cards. Sign-off and dormant projects collapse to dense one-line rows. Within a
  card, workstreams sort blocked-first / merged-last, and only the opened workstream lists its
  sessions.
- **Answer IS continue.** Quick-reply chips prefill the composer; replying to a blocked agent
  continues its conversation. Continue is always one click from the surfaced item.
- **Honest encoding.** A ring is a segmented gauge — one arc per DoD criterion, filled = met — so
  a percent always reads as "k of n met" and traces to a checkbox, a git fact, or an exit code.
  Nothing is authored; where a signal does not exist, the UI refuses to invent one (a "?" ring,
  an asterisked "k/n", a quiet "may be waiting" instead of a fake alarm).

---

## 2. How the UI maps to the data model

Every visible element is backed by a real signal from `DATA-MODEL-AND-API.md`. The script's
header comment block (`index.html` lines ~613-693) is the canonical field-by-field grounding;
the summary:

| UI element | Backing signal |
| --- | --- |
| DoD ring (segmented gauge) | `ProgressSnapshot.percent = metWeight/totalWeight` over non-gate `DoDCriterion[]`; one segment per criterion; collapses to one proportional arc past 6 criteria. |
| Ring "?" / "k/n*" / pulsing track | `unset` DoD / never-run or stale `command` criterion / two-phase or on-demand eval. The ring never shows a confident percent it cannot back. |
| Ring shape at 12 o'clock (circle / square / diamond / ×) | Colourblind-safe status channel so a blocked 50 ≠ a running 50 without relying on hue. |
| Workstream "k of n sessions done" gauge | `WorkstreamRollup.mixed` — sessions span >1 evaluator family; no blended percent. |
| Status badge / hue | Derived `WorkItemStatus` (runtime.isRunning → run/loop; git conflicted / tool error → block/fail; evaluable 100% + manual gate → sign; evaluable 100% auto → merge). |
| "Blocked · needs input" + quick-reply chips | A structured elicitation (`extension_ui_request` / proposed `ask_user` `{question, options[]}`). Non-elicited stop → quiet "Paused / may be waiting" instead. |
| Loop badge `∞`, "looping 38m · iter 12", sparkbar, budget meter | Stored `isLoop` + `loopStartedAt` + `budget`; iter/spark rebuilt from durable `CustomEntry('pi-web:loop-iter')` + `tool_result` entries; cost from `SessionStats`. Amber only when stalled or over budget. |
| Artifact chip (branch / sha / +N/−N diff) | `gitStatus` branch + `git merge-base --is-ancestor` (merged · sha) + `gitCommitDetails` numstat. |
| Artifact chip (doc: "competitors.md · 3 files") | Derived from the session's own write/edit `tool_result` entries — no git, no PR; verification is the user's review. |
| "Sign off" button | `PATCH /api/dod/criterion/:id` flipping the manual gate (optimistic + undo toast). |
| "Ask pi to merge feat/x → main" | `/api/prompt` (or a net-new git-merge endpoint); rendered only when a real branch exists, with an info glyph noting the git layer is local-only. |
| Planned-next chips + "~N more planned" | Best-effort parse of agent notes — pi has no TodoWrite primitive, so the count is approximate (the `~` and an info glyph say so). |
| "Since you last looked" delta clause | Transition diff vs stored `lastDashboardVisitAt`; numstat in the merged fragment's tooltip; each fragment a jump-link. |
| Projects / workstreams / DoD themselves | pi-web-owned `ProjectRegistry` sidecar; sessions matched to exactly one project by longest cwd prefix; rollups computed on read in `/api/rollups`. |

---

## 3. Behavior under each pressure-test scenario

The scenario switcher in the top bar loads ten fixtures. Each is a deliberate stress on a stated
weakness.

**single — Lone project, many rings.** One registered project (pi-web, 3 workstreams). The grid
uses `.grid.single` so the lone card sits at its natural width (max 560px, centered) rather than
stretching to fill the row; the rail collapses to one honest line; Continue on the most recent
session is one click. No empty sibling slots.

**scale — Fifty-card wall (42 projects).** The documented weakest axis. `renderGrid` is
attention-driven: full ring-cards render only for attn (block/fail) and the first 6 active
(run/loop) projects; the rest fold into a "Running · N more" grouped-row card and a "Healthy &
dormant" group (recency-sorted, capped at 6 + show-all). The fixture carries 10 simultaneous
loops → ~6 full cards + "Running · 4 more", plus 38 dormant projects as one collapsed group. The
rail gives the fleet count and doubles as jump-links. No horizontal scroll, no 42 instrument
panels.

**dense — Eight-workstream monster.** The collapsed card wraps 8 rings into a tidy grid (no
horizontal scroll); the card names the long pole rather than a flattering average. Expanding sorts
workstreams blocked-first / merged-last; each is a ring + DoD + session count; only the opened
workstream lists its sessions (one workstream has 9 sessions to exercise the "+N more sessions"
cap), so 40 sessions never render at once.

**calm — Quiet Sunday.** `needs===0` drops the entire Needs-you section; the hero states the truth
("Nothing needs you. 3 loops running, everything else can wait."). Only cyan appears, no amber or
red. "You can close this tab" prints only when needs + sign-offs + stalled loops are all zero.
Refreshing invents no badges.

**blocked — Five agents waiting (6 blockers).** Needs-you shows the top 1-2 in full context with
quick-reply chips and collapses the rest into a "+4 more need you" stepper, ordered by blast
radius. A &gt;2 count exposes a "Triage all in focus" stepper. The tally still reads in 3 seconds;
the page never becomes a wall of red.

**loop — The loop that keeps planning (queue 3→17).** The loop renders as one calm row: an `∞`
ring (never a misleading percent), "LOOPING 38m · iter 12", an iteration sparkbar, and the next
2-3 planned chips + "~14 more planned". Growth is expected — no amber. A second fixture (datapipe
backfill) is genuinely stalled (flat/declining spark tail, over time budget) so a healthy loop and
a stalled loop do not look identical; the stalled one flips amber and surfaces in the hero + rail.

**empty — Cold start.** Empty registry → a single onboarding panel replaces the grid: one sentence
on the project → workstream → session → DoD model, one primary action, and a one-tap
auto-discovery list mined from recent session cwds / git roots. No placeholder cards, no zero-fill
rings.

**nogit — Research with no repo.** The workstream shows a non-git source pill ("user-defined") and
plain-words criteria ("3 competitor profiles written & user-reviewed"); the ring fills against
those, not commits. The artifact chip is a doc receipt ("competitors.md · 3 files"), gate-aware
("awaiting your review" until the manual gate flips, then "✓ user-reviewed"). The terminal action
is "Archive", not a merge — no branch/main implied.

**mixed — Six definitions of done.** One expanded card holds all six sources (git_merged,
rule-based, agent-defined, user sign-off, user-defined-unset, orchestrator-defined). Each
workstream shows its source pill at rest and full criterion text on expand; the per-criterion pill
names the real evaluator (manual / git / command / runtime), distinct from the at-rest provenance
pill. The unset session prompts "set the criterion" (a "?" ring) instead of a fabricated percent.
Terminal actions adapt by source; no source is silently treated as another.

**nested — Child that earns its own card.** ai-education lives physically inside ~/zippy but
appears as its own top-level card with an "⤷ in zippy" lineage badge and full path. Longest-prefix
exclusive matching means its sessions and needs-you counts belong to it alone and never inflate
zippy's rollup. The relationship is a quiet badge, not a nested tree, so the flat scalable grid
holds. The lineage badge is carried into `renderRow` so it survives compact/dormant rows.

---

## 4. Iteration history

Four iterations, each starting from the prior commit and applying a synthesized cross-lens
critique — no rebuild. Satisfaction and average lens scores:

| Iter | Commit | Satisfaction | Lens avg | Converged | Headline of the pass |
| --- | --- | --- | --- | --- | --- |
| 1 | `96ef7dc` | 6 | 6.3 | no | Strong IA skeleton, but three load-bearing integrity failures: the ring rendered a hand-authored `progress` field contradicting its own criteria (fabrication); `cardLive` returned running before block so blockers hid; and "attention-sort on expand" did not exist in code. |
| 2 | `0507b7a` | 7 | 6.8 | no | DERIVED segmented ring landed (displayed === computed, gates excluded, auto sources never purple). Remaining: loop suite rested on a non-existent primitive; view models omitted ~70% of fields; needs-count restated 3-4×; tally rail was a 6-hue rainbow; sign-off buried in the Done accordion. |
| 3 | `61d7326` | 7 | 7.3 | no | needs===0 drops the whole section; attention-driven collapse; hero-owned count; honest k-of-n rings; rationed color/motion; answer-IS-continue. Six HIGH issues left: uncapped purple sign-off band; active-card cap only on the dormant half; bogus merge on no-git; stale-evidence percents. |
| 4 | `f419d7e` | 7 | 7 | no | Final form. Sign-off became a light capped to-do list; active full cards capped; honest calm hero + stalled-loop surfacing; merge affordance gated + disambiguated; glance-level progress honesty (never-run excluded, `allMet` requires fresh evidence); durable loop telemetry documented. |

The arc is integrity-first: iteration 1 fixed fabrication, iteration 2 made the ring derived,
iterations 3-4 spent their budget on calm discipline and de-noising rather than features. The
design was scored as a strong, honest mockup (all four lenses at 7) but **not formally converged**
— the dense scenario still strains the calm lens, and the loop telemetry + per-card ring map
remain the load-bearing feasibility bets (see risks below).

---

## 5. Open questions and risks before implementation

These are the things to settle before building, ordered by how much they move the design.

1. **`cardLive` one-liner skips needs (known tradeoff, verify in practice).** `cardLive`
   (`index.html` ~1394-1410) computes the card's live one-liner from non-need sessions only, so
   when a blocker and a running session coexist, the one-liner describes the running task. The
   design's intent is that the blocker is already surfaced louder in Needs-you and on the card's
   ring (amber hue + dashed outline + ↑ marker), so the one-liner should not restate it. The risk
   flagged across iterations is that a user scanning one-liners could miss the blocker. Decide
   whether the card face should name the blocker in text before the dashed-outline ring is quieted.

2. **Loop telemetry assumes an orchestrator that does not exist.** Budget caps, durable Pause, and
   "iteration" semantics all assume a loop runner that honors a registry `paused` flag and writes
   `CustomEntry('pi-web:loop-iter')`. pi has no such primitive today. Either ship that extension
   first, or render loops as a plain "running, no fixed end" state without budget/pause until it
   exists. Drawing budget meters against a non-existent runner is the biggest feasibility bet.

3. **Per-card dense ring map needs an authoring flow.** Only ~2 criteria per root are
   auto-derivable (git_clean + git_merged). A card showing 8 rich rings implies hand-authored DoD
   criteria that require a UI to create. Without that flow, dense cards under-populate. Decide the
   authoring path (inline criterion editor vs. an agent that proposes a DoD) before promising rich
   per-workstream rings.

4. **Merge is a separate, net-new capability.** The local-only git layer has no push/PR/merge.
   "Ask pi to merge" via `/api/prompt` is buildable today; a true one-click merge needs a net-new
   git-merge endpoint, and "real done = merged PR + green CI" needs a GitHub/CI integration that
   does not exist. Set expectations that "merged to mainline" means local merge-base, not shipped.

5. **Command-DoD evaluation is slow, side-effecting, and security-sensitive.** Running arbitrary
   `npm test` via `executeBash` must be on-demand, sandboxed, and time-bounded. Results go stale;
   the UI already asterisks stale/unrun evidence, but the eval policy (who triggers it, how often,
   with what guardrails) is unresolved.

6. **Block detection has false positives/negatives.** Without structured elicitation everywhere,
   "blocked" is heuristic. The design degrades non-elicited stops to a quiet "may be waiting", but
   broad reliability needs the `ask_user` tool or `extension_ui_request` to be standard in the
   agents Kevin runs.

7. **Realtime is a global firehose.** `/ws` emits every session's events to every client. The
   dashboard filters client-side and consumes a debounced, project-scoped `rollup_changed`, which
   is fine at current scale but will push noise on a busy multi-project server. Server-side
   per-project scoping is a larger change to defer.

8. **Git-DoD freshness for out-of-band merges.** A merge done outside pi (in a terminal) only goes
   live via a TTL git poll or an fs/git watcher emitting dirty-scoped `rollup_changed`. Decide poll
   interval vs. watcher before relying on the Done surface being current.
