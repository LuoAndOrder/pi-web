// S8 — Debounced, dirty-project-scoped rollup_changed realtime.
//
// Subprocess harness (mock mode, isolated PI_WEB_PROJECTS_FILE) mirroring
// tests/rollups-api.test.ts. A /ws collector drains realtime envelopes so we can
// assert the server's coalescing contract:
//
//   1. A streaming mock prompt that ENDS emits <=1 coalesced rollup_changed per
//      project within the debounce window after the terminal event — and the
//      interim pi_event flood (message_update / tool_execution_update /
//      tool_execution_start) does NOT each emit one.
//   2. A registry POST emits EXACTLY one project_registry_changed (immediately,
//      not debounced) and schedules one coalesced rollup_changed.
//   3. Reconnecting with ?lastSeq= replays the missed envelopes (replay:true).
//
// The window is widened via PI_WEB_ROLLUP_DEBOUNCE_MS so the test is deterministic
// against the mock prompt's ~hundreds-of-ms streaming timeline.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  openRealtime,
  startServer,
  waitForCondition,
  type RealtimeCollector,
  type RollupServer,
} from "./helpers/rollupHarness.js";
import type { ProjectRegistry } from "../server/rollups/types.js";

const NOW = new Date().toISOString();

// A project whose workstream EXPLICITLY owns mock-current, so the session→project
// mapping is cwd-independent and deterministic regardless of the server's cwd.
function seedRegistry(): ProjectRegistry {
  return {
    version: 1,
    projects: [
      {
        id: "proj-rt",
        name: "Realtime Project",
        roots: ["/tmp/rollups-realtime-seed"],
        workstreamIds: ["ws-rt"],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    workstreams: [
      {
        id: "ws-rt",
        projectId: "proj-rt",
        name: "Stream",
        status: "in_progress",
        sessionIds: ["mock-current"],
        order: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

const DEBOUNCE_MS = 600;

describe("rollups realtime (S8)", () => {
  let server: RollupServer;
  let realtime: RealtimeCollector;

  beforeAll(async () => {
    server = await startServer({
      registry: seedRegistry(),
      extraEnv: { PI_WEB_ROLLUP_DEBOUNCE_MS: String(DEBOUNCE_MS) },
    });
    realtime = await openRealtime(server);
  }, 20_000);

  afterAll(async () => {
    realtime?.close();
    await server?.stop();
  });

  it("coalesces a streaming session's terminal events into <=1 rollup_changed per project (interim floods emit none)", async () => {
    realtime.clear();

    // "tool" drives the mock prompt's interleaved path: agent_start, a text
    // message_update, tool_execution_start, tool_execution_update,
    // tool_execution_end, another message_update, then agent_end — i.e. a flood of
    // interim pi_events bracketed by terminal events on ONE session/project.
    const res = await server.api("POST", "/api/prompt", {
      sessionId: "mock-current",
      message: "use a tool to inspect things",
    });
    expect(res.status).toBe(202);

    // Wait until the prompt has fully ended (agent_end pi_event observed).
    await waitForCondition(
      () => realtime.messages.some((m) => m.type === "pi_event" && m.event?.type === "agent_end"),
      10_000,
    );

    // The interim updates must NOT each produce a rollup_changed.
    const interimUpdates = realtime.messages.filter(
      (m) =>
        m.type === "pi_event" &&
        (m.event?.type === "message_update" || m.event?.type === "tool_execution_update"),
    );
    expect(interimUpdates.length).toBeGreaterThan(0); // the prompt really did flood

    // Allow the full debounce window to elapse after the last terminal event so any
    // pending flush has fired, then assert the coalesced count.
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 2));

    const rollupChanges = realtime.messages.filter((m) => m.type === "rollup_changed");
    expect(rollupChanges.length).toBe(1);
    expect(rollupChanges[0]?.projectId).toBe("proj-rt");
    // The envelope is id-only (client refetches) and carries a monotonic seq.
    expect(typeof rollupChanges[0]?.seq).toBe("number");
    expect(Object.keys(rollupChanges[0] ?? {}).sort()).toEqual(["projectId", "seq", "type"]);
  }, 20_000);

  it("a registry POST emits exactly one project_registry_changed", async () => {
    realtime.clear();
    const before = realtime.typeCount("project_registry_changed");
    const res = await server.api("POST", "/api/projects", {
      name: "Second Project",
      roots: ["/tmp/rollups-realtime-second"],
    });
    expect(res.status).toBe(201);
    await realtime.waitForType("project_registry_changed", before + 1);
    // Settle: no SECOND project_registry_changed sneaks in from the same mutation.
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 2));
    expect(realtime.typeCount("project_registry_changed")).toBe(before + 1);
  }, 20_000);

  it("does not emit rollup_changed for a session matched to no project", async () => {
    realtime.clear();
    // mock-older lives at the server cwd but is NOT explicitly attached to any
    // workstream and the seed project's root does not contain it → unassigned →
    // marking it dirty resolves to zero projects → zero rollup_changed.
    const res = await server.api("POST", "/api/prompt", {
      sessionId: "mock-older",
      message: "plain reply",
    });
    expect(res.status).toBe(202);
    await waitForCondition(
      () => realtime.messages.some((m) => m.type === "pi_event" && m.event?.type === "agent_end"),
      10_000,
    );
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 2));
    expect(realtime.typeCount("rollup_changed")).toBe(0);
  }, 20_000);

  it("replays missed envelopes on reconnect with ?lastSeq=", async () => {
    // Capture a seq cutoff BEFORE a mutation, then reconnect from it and assert the
    // mutation's envelope replays (replay:true) on the fresh socket.
    realtime.clear();
    const res = await server.api("POST", "/api/projects", {
      name: "Replay Project",
      roots: ["/tmp/rollups-realtime-replay"],
    });
    expect(res.status).toBe(201);
    await realtime.waitForType("project_registry_changed", 1);
    const marker = realtime.messages.find((m) => m.type === "project_registry_changed");
    const markerSeq = Number(marker?.seq);
    expect(Number.isFinite(markerSeq)).toBe(true);

    // Reconnect just BEFORE the marker; the server should replay every envelope
    // with seq > lastSeq, including the registry change, flagged replay:true.
    const wsBase = server.baseUrl.replace(/^http/, "ws");
    const replayed: Array<Record<string, any>> = [];
    const ws = new WebSocket(`${wsBase}/ws?clientId=replay-test&lastSeq=${markerSeq - 1}`);
    ws.on("message", (data) => {
      try {
        replayed.push(JSON.parse(String(data)));
      } catch {
        // ignore non-JSON
      }
    });
    try {
      await waitForCondition(
        () => replayed.some((m) => m.type === "project_registry_changed" && m.replay === true && m.seq === markerSeq),
        5_000,
      );
    } finally {
      ws.terminate();
    }
    const replayedMarker = replayed.find((m) => m.type === "project_registry_changed" && m.seq === markerSeq);
    expect(replayedMarker?.replay).toBe(true);
  }, 20_000);
});
