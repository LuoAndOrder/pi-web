// Subprocess harness for the rollup API suites (S2 CRUD, S3 /api/rollups).
//
// Mirrors the proven boilerplate in tests/api.test.ts: spawn `node --import tsx
// server.ts` in mock mode with isolated PI_WEB_* sidecar files so a test run
// never clobbers the real ~/.pi/agent/*.json. The key addition over the session
// suite is PI_WEB_PROJECTS_FILE — each server gets its own temp registry file.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import type { ProjectRegistry } from "../../server/rollups/types.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") throw new Error("Could not allocate port");
  return address.port;
}

export async function waitForServer(baseUrl: string, token = ""): Promise<void> {
  const deadline = Date.now() + 15_000;
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/state${suffix}`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${baseUrl}`);
}

export async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

/** Pre-seed a registry file on disk before boot (deterministic, no API churn). */
export async function seedRegistry(file: string, registry: ProjectRegistry): Promise<void> {
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
}

export interface StartServerOptions {
  token?: string;
  /** Seed registry written to PI_WEB_PROJECTS_FILE before boot. */
  registry?: ProjectRegistry;
  extraEnv?: Record<string, string>;
}

export interface JsonResponse {
  status: number;
  body: any;
}

export interface RollupServer {
  baseUrl: string;
  port: number;
  token: string;
  projectsFile: string;
  /** Authorized JSON request helper (attaches the Bearer token when configured). */
  api: (method: string, path: string, body?: unknown) => Promise<JsonResponse>;
  /** Raw request that skips the Authorization header (for 401 assertions). */
  apiNoAuth: (method: string, path: string, body?: unknown) => Promise<JsonResponse>;
  stop: () => Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<RollupServer> {
  const token = options.token ?? "";
  const dir = await mkdtemp(join(tmpdir(), "rollups-api-"));
  const projectsFile = join(dir, "pi-web-projects.json");
  if (options.registry) await seedRegistry(projectsFile, options.registry);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_WEB_MOCK: "1",
      PI_WEB_DEV: "1",
      HOST: "127.0.0.1",
      PORT: String(port),
      PI_WEB_TOKEN: token,
      PI_WEB_SETTINGS_FILE: join(dir, "settings.json"),
      PI_WEB_SESSION_UI_STATE_FILE: join(dir, "session-ui-state.json"),
      PI_WEB_PROJECTS_FILE: projectsFile,
      ...options.extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (data) => process.stderr.write(data));
  await waitForServer(baseUrl, token);

  async function request(method: string, path: string, body: unknown, auth: boolean): Promise<JsonResponse> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth && token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  return {
    baseUrl,
    port,
    token,
    projectsFile,
    api: (method, path, body) => request(method, path, body, true),
    apiNoAuth: (method, path, body) => request(method, path, body, false),
    async stop() {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Collects realtime envelopes off the global /ws socket for assertions. */
export interface RealtimeCollector {
  messages: Array<Record<string, any>>;
  typeCount: (type: string) => number;
  waitForType: (type: string, minCount?: number, timeoutMs?: number) => Promise<void>;
  clear: () => void;
  close: () => void;
}

export async function openRealtime(server: RollupServer): Promise<RealtimeCollector> {
  const wsBase = server.baseUrl.replace(/^http/, "ws");
  const tokenSuffix = server.token ? `&token=${encodeURIComponent(server.token)}` : "";
  const ws = new WebSocket(`${wsBase}/ws?clientId=rollup-test${tokenSuffix}`);
  const messages: Array<Record<string, any>> = [];
  ws.on("message", (data) => {
    try {
      messages.push(JSON.parse(String(data)));
    } catch {
      // ignore non-JSON frames
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket hello timed out")), 5_000);
    ws.on("message", (data) => {
      try {
        if (JSON.parse(String(data))?.type === "hello") {
          clearTimeout(timer);
          resolve();
        }
      } catch {
        // ignore
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const typeCount = (type: string) => messages.filter((msg) => msg.type === type).length;

  return {
    messages,
    typeCount,
    async waitForType(type, minCount = 1, timeoutMs = 5_000) {
      await waitForCondition(() => typeCount(type) >= minCount, timeoutMs);
    },
    clear() {
      messages.length = 0;
    },
    close() {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
    },
  };
}
