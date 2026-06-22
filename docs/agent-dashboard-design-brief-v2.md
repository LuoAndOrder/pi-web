# pi-web Agent Dashboard — Round 2 Directives

> Builds on `agent-dashboard-design-brief.md`. Round 1 produced 7 archetypes
> (`docs/dashboard-designs/`). This round responds to feedback: calmer, progressive
> disclosure, a real "done" model, and "continue the conversation" as the obvious action.

## What round 1 taught us
- **Mission Control** = best at-a-glance comprehensiveness — but too busy.
- **Loop Timeline** = most novel; the Project→Workstream→Session hierarchy and *visualizing the work* were loved. But a **time-axis doesn't scale** — it assumes work is clustered in time, and horizontal scrolling is tedious. Keep the novelty, drop the timeline.
- **Activity Feed** = good, but as a **secondary view**, not the home.
- **Triage Inbox** = felt like an **overwhelming flat list**.
- **All of them were too visually busy**, and busier than pi-web actually is.

## Governing principles for round 2
1. **Calm by default; progressive disclosure.** The default screen shows the *few* things that need a human plus a one-line state-of-the-world. Everything else is summarized/collapsed and expands on demand. Inspiration: *"1 loop needs you. Everything else can wait."* Generous whitespace; detail is earned by a click.
2. **At-a-glance comprehensiveness without the busyness** (Mission Control's strength, made calm). Grok the whole world in ~3 seconds, then drill.
3. **Visualize the work — but make it scale.** Keep Project→Workstream→Session and a sense of progress, with **no horizontally-scrolling timeline**. Use compact, vertically-scalable signals: progress rings/bars, status dots, sparkbars, grouping, drill-down.
4. **Native to pi-web's actual restraint** — it is spare, dark, minimal. Match it. Be *more* novel/creative in the organizing idea, *less* busy in the pixels.

## New first-class concepts (must appear in every variant)
**A. Definition of Done (DoD) — per session AND per workstream.** "Done" is relative to a configurable criterion with a source:
- Workstream DoD examples: *merged to mainline*, or *user-reviewed & signed off*.
- Session DoD: *agent/orchestrator-defined*, *user-defined*, or *rule-based*.
- Surface it: each item shows its DoD and progress toward it. "Done **per its DoD** → awaiting your sign-off" is a distinct state from generic "needs review."

**B. A clear "Done / Completed" surface.** Round 1 hid this. Show what's finished, and distinguish **done-awaiting-sign-off** from **done-&-merged** (archived / celebrated).

**C. "Continue the conversation" is the obvious primary action.** In real pi-web you continue by opening a session → the composer ("Ask pi…") is right there. The dashboard's default action on any session must be **jump in and keep talking**; approve / reply / sign-off are *secondary*. Never bury the conversation behind action buttons.

## Real pi-web interaction model (observed live at localhost:8787)
- Sessions live in a **left drawer**, grouped by folder (cwd); each row = name + relative time + message count + color marker; 3-dot actions; search; per-folder "new session".
- Opening a session → **full conversation** (messages with collapsible thinking / tool cards) with the **composer pinned at the bottom**. Continuing = type into "Ask pi…".
- pi-web **renders rich HTML/markdown artifacts inline** in the conversation (so a "done" artifact can be a real rendered preview).
- Aesthetic is **spare, dark, minimal**.

## Fixed (unchanged)
Project→Workstream→Session model; status taxonomy (queued / running / blocked / done / merged / failed); verification-first (done items carry a checkable artifact); the four questions (a–d); the dark pi-web design system.

## The 5 round-2 concepts (distinct organizing principles, all sharing the above)
1. **Calm Console** — Mission Control reborn: the whole world on one surface, but collapsed by default to a calm summary + status dots; expand any rollup for detail.
2. **Focus** — one-thing-at-a-time. A serial attention queue that shows the single most important item in full context with the composer ready; "N more waiting" to step through. Radical calm.
3. **Project Rollups** — a calm grid of project cards (wealthlens / zippy / ai-education), each a small summary with a DoD progress ring per workstream and a "needs you" count; click to expand into workstreams → sessions. Scalable (cards wrap, no horizontal scroll).
4. **Status Lanes** — vertical, scalable sections (Needs you / In progress / Done — awaiting sign-off / Completed), each grouped by Project→Workstream and collapsed to a summary. The calm, scalable answer to kanban + timeline.
5. **Ambient Pulse** — a novel glanceable "health/pulse" visualization per project (think rings / a vitals readout): is anything blocking a human, and how close is each workstream to its DoD. Drill for detail. The most creative take.
