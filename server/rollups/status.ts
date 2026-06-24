// Project Rollups — status derivation (pure, unit-testable).
//
// Two taxonomies travel together so the ported render logic has its input without
// a lossy collapse (tech-lead decision): `uiStatus` is the 9 render-states the
// mockup's STATUS_RANK / badge logic consumes, `status` is the 5-value canonical
// WorkItemStatus. `toWorkItemStatus` collapses one to the other.
//
// Block honesty (DATA-MODEL §5.3, mockup L1546-1547) is the hard quality bar:
//   - `block` arises ONLY from a real blocker — git `conflicted` OR a structured
//     elicitation (a structured ask). A non-elicited free-text idle stop is NOT a
//     block here; it degrades to a quiet "may be waiting" the caller surfaces via
//     `isSoftWait`, never a fabricated amber alarm.
//   - `fail` arises ONLY from a tool error / abnormal agent_end / git conflicted —
//     never from a dashboard-initiated command-DoD eval.
//   - a hard "need" (enters Needs-you) is a `fail`, an ELICITED `block`, OR a
//     git-conflict `block` (`isHardNeed`); a non-elicited, non-git-conflict
//     `block` is a soft wait (`isSoftWait`).

import type {
  ProgressSnapshot,
  SessionGitInfo,
  SessionRuntime,
  UiStatus,
  WorkItemStatus,
} from "./types.js";

export interface UiStatusInput {
  runtime?: SessionRuntime | null;
  git?: SessionGitInfo | null;
  progress?: ProgressSnapshot | null;
  /** A not-yet-met sign-off gate exists (status promotes to "sign" at 100%). */
  pendingGate?: boolean;
  /** A structured ask is pending (chips); the only thing that makes a block a hard need. */
  elicitation?: boolean;
  /** A tool error / abnormal agent_end was observed. */
  fail?: boolean;
  /** The session/workstream is an autonomous loop (renders ∞ "running"). */
  isLoop?: boolean;
  /** Whether a DoD targets this item at all. false → "unset" = MANUAL mode (no DoD):
   *  the item is tracked by hand (Mark done), a CALM state — NOT "broken"/"needs setup". */
  hasDoD?: boolean;
  /** A non-elicited idle stop that may be waiting on a human (quiet, never amber). */
  softWait?: boolean;
}

/**
 * Derive the 9-state render status. Order encodes precedence: a real failure or
 * blocker outranks liveness, which outranks done-ness, which outranks idle states.
 */
export function deriveUiStatus(input: UiStatusInput): UiStatus {
  if (input.fail) return "fail";
  if (input.git?.blocked) return "block"; // git conflicted is a real blocker
  if (input.elicitation) return "block"; // a structured ask needs input
  if (input.runtime?.isRunning) return input.isLoop ? "loop" : "run";
  // A non-elicited idle stop: surfaced as "block" render-state but split out by
  // isSoftWait (so it never enters the hard Needs-you count).
  if (input.softWait) return "block";
  if (input.progress?.allMet) return input.pendingGate ? "sign" : "merge";
  // No DoD → MANUAL mode: tracked by hand (Mark done). "unset" is a CALM manual token
  // here, NOT a "needs setup"/broken gate — a DoD is an optional auto-track add-on.
  if (!input.hasDoD) return "unset";
  if (input.progress && (input.progress.metWeight > 0 || input.progress.unrun > 0)) return "queued";
  return "planned";
}

/** Collapse a 9-state render status to the 5-value canonical WorkItemStatus. */
export function toWorkItemStatus(ui: UiStatus): WorkItemStatus {
  switch (ui) {
    case "run":
    case "loop":
      return "in_progress";
    case "block":
    case "fail":
      return "blocked";
    case "sign":
    case "merge":
      return "done";
    case "queued":
    case "planned":
    case "unset":
      return "planned";
    default:
      return "planned";
  }
}

/** Convenience: the canonical WorkItemStatus straight from the same inputs. */
export function deriveStatus(input: UiStatusInput): WorkItemStatus {
  return toWorkItemStatus(deriveUiStatus(input));
}

/** A HARD need (enters Needs-you / the hero obligation count): a failure, an
 *  ELICITED block (a structured ask), OR a git-conflict block (§5.3 lists git
 *  `conflicted` as a hard blocker). A `block` render-state collapses git conflicts
 *  and non-elicited idle stops together, so `gitBlocked` is what tells a genuine
 *  obligation apart from a quiet "maybe waiting". Mirrors the mockup `isNeed`
 *  (L1546). */
export function isHardNeed(
  uiStatus: UiStatus,
  elicitation?: boolean,
  gitBlocked?: boolean,
): boolean {
  return uiStatus === "fail" || (uiStatus === "block" && (!!elicitation || !!gitBlocked));
}

/** A SOFT wait ("Idle · may be waiting") — a non-elicited, non-git-conflict block.
 *  The inverse of `isHardNeed` for blocks; never amber. Mirrors the mockup
 *  `isSoftWait` (L1547). */
export function isSoftWait(
  uiStatus: UiStatus,
  elicitation?: boolean,
  gitBlocked?: boolean,
): boolean {
  return uiStatus === "block" && !elicitation && !gitBlocked;
}

/** A "sign" status resting on unrun / stale evidence can't be signed off yet
 *  (it shows "done — pending recheck"). Mirrors the mockup `signPending` (L967). */
export function signPending(
  uiStatus: UiStatus,
  progress: ProgressSnapshot | null | undefined,
): boolean {
  return uiStatus === "sign" && !!progress && (progress.unrun > 0 || progress.stale > 0);
}
