import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySettingsPatch, createSettingsStore, normalizeSettings } from "../server/settings.js";

let tempDirs: string[] = [];

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-settings-"));
  tempDirs.push(dir);
  return join(dir, "settings.json");
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("pi-web settings", () => {
  it("normalizes missing and invalid values to safe defaults", () => {
    expect(normalizeSettings({
      version: 999,
      appearance: { density: "tiny" },
      composer: { queueMode: "bad", expanded: "yes" },
      dashboard: { openOnLaunch: "nope" },
      defaults: { model: { provider: "", id: "model" }, thinkingLevel: "", sessionBucketColor: "orange" },
    })).toEqual({
      version: 1,
      appearance: { density: "comfortable" },
      composer: { queueMode: "steer", expanded: false },
      dashboard: { openOnLaunch: false },
      defaults: {},
    });
  });

  it("applies partial patches without accepting unrelated keys", () => {
    const next = applySettingsPatch(normalizeSettings(undefined), {
      appearance: { density: "compact" },
      composer: { queueMode: "followUp", expanded: true },
      dashboard: { openOnLaunch: true },
      defaults: { model: { provider: "mock", id: "model" }, thinkingLevel: "low", sessionBucketColor: "purple" },
      unknown: true,
    });

    expect(next).toEqual({
      version: 1,
      appearance: { density: "compact" },
      composer: { queueMode: "followUp", expanded: true },
      dashboard: { openOnLaunch: true },
      defaults: { model: { provider: "mock", id: "model" }, thinkingLevel: "low", sessionBucketColor: "purple" },
    });
  });

  it("toggles the open-dashboard-on-launch flag and ignores non-boolean patches", () => {
    const enabled = applySettingsPatch(normalizeSettings(undefined), { dashboard: { openOnLaunch: true } });
    expect(enabled.dashboard.openOnLaunch).toBe(true);

    const disabled = applySettingsPatch(enabled, { dashboard: { openOnLaunch: false } });
    expect(disabled.dashboard.openOnLaunch).toBe(false);

    // A non-boolean value is ignored (the prior value is preserved, never coerced).
    const untouched = applySettingsPatch(enabled, { dashboard: { openOnLaunch: "yes" } });
    expect(untouched.dashboard.openOnLaunch).toBe(true);
  });

  it("persists settings atomically as JSON", async () => {
    const file = await tempFile();
    const store = createSettingsStore(file);

    expect(await store.read()).toEqual(normalizeSettings(undefined));
    const saved = await store.patch({ composer: { queueMode: "followUp" } });
    expect(saved.composer.queueMode).toBe("followUp");

    const fromDisk = JSON.parse(await readFile(file, "utf-8"));
    expect(fromDisk.composer.queueMode).toBe("followUp");

    const reloaded = createSettingsStore(file);
    expect((await reloaded.read()).composer.queueMode).toBe("followUp");
  });
});
