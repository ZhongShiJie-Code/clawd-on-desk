"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const createAntigravityQuotaMonitor = require("../src/antigravity-quota-monitor");

describe("Antigravity account quota monitor", () => {
  it("queries the official read-only usage command and forwards only normalized quota", async () => {
    const forwarded = [];
    let commandCall = null;
    let intervalCallback = null;
    let clearedTimer = null;
    const timer = { unref() {} };
    const monitor = createAntigravityQuotaMonitor({
      cliPath: "/fake/agy",
      pollIntervalMs: 300000,
      now: () => 1780000000000,
      setIntervalImpl(callback, ms) {
        assert.strictEqual(ms, 300000);
        intervalCallback = callback;
        return timer;
      },
      clearIntervalImpl(value) { clearedTimer = value; },
      execFileImpl(file, args, opts, callback) {
        commandCall = { file, args, opts };
        setImmediate(() => callback(null, JSON.stringify({
          command: { data: { groups: [{ buckets: [
            { id: "gemini-5h", window: "5h", remaining_fraction: 0.6, reset_time: "2026-09-25T11:00:00Z" },
          ] }] } },
          response: "must not be persisted or logged",
        })));
        return { kill() {} };
      },
      onQuota: (quota) => forwarded.push(quota),
    });

    monitor.start();
    const quota = await monitor.refreshNow();
    assert.deepStrictEqual(commandCall, {
      file: "/fake/agy",
      args: ["-p", "/usage", "--output-format", "json"],
      opts: { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
    });
    assert.strictEqual(quota.geminiFiveHour.usedPercent, 40);
    assert.strictEqual(quota.geminiFiveHour.windowMinutes, 300);
    assert.deepStrictEqual(forwarded, [quota]);
    assert.strictEqual(typeof intervalCallback, "function");

    monitor.stop();
    assert.strictEqual(clearedTimer, timer);
  });

  it("finds the standard per-user agy install before PATH candidates", () => {
    const found = createAntigravityQuotaMonitor.resolveAntigravityCli({
      homeDir: "/Users/tester",
      env: { PATH: "/custom/bin" },
      platform: "darwin",
      existsSync: (candidate) => candidate === "/Users/tester/.local/bin/agy",
      accessSync: () => {},
    });
    assert.strictEqual(found, "/Users/tester/.local/bin/agy");
  });
});
