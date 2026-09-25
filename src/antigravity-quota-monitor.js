"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const { resolveAntigravityCommandQuota } = require("../hooks/antigravity-context-usage");

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function resolveAntigravityCli({
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  accessSync = fs.accessSync,
} = {}) {
  const executable = platform === "win32" ? "agy.exe" : "agy";
  const candidates = [
    path.join(homeDir, ".local", "bin", executable),
    path.join(homeDir, "bin", executable),
    ...(platform === "darwin" ? ["/opt/homebrew/bin/agy", "/usr/local/bin/agy"] : []),
    ...String(env.PATH || "").split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, executable)),
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (!existsSync(candidate)) continue;
      if (platform !== "win32") accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_err) {
      // Ignore missing and non-executable candidates; continue through PATH.
    }
  }
  return null;
}

function createAntigravityQuotaMonitor(options = {}) {
  const cliPath = options.cliPath || null;
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const execFileImpl = options.execFileImpl || execFile;
  const existsSync = options.existsSync || fs.existsSync;
  const accessSync = options.accessSync || fs.accessSync;
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? options.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const onQuota = typeof options.onQuota === "function" ? options.onQuota : () => {};
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};

  let running = false;
  let pollTimer = null;
  let child = null;
  let refreshPromise = null;

  function refreshNow() {
    if (!running) return Promise.resolve(null);
    if (refreshPromise) return refreshPromise;

    const executable = cliPath || resolveAntigravityCli({ homeDir, env, platform, existsSync, accessSync });
    if (!executable) {
      debugLog("antigravity-quota: official CLI not found");
      return Promise.resolve(null);
    }

    refreshPromise = new Promise((resolve) => {
      try {
        child = execFileImpl(executable, ["-p", "/usage", "--output-format", "json"], {
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        }, (err, stdout) => {
          child = null;
          if (!running) return resolve(null);
          if (err) {
            const safeCode = typeof err.code === "string" && /^[A-Z0-9_]+$/.test(err.code)
              ? err.code
              : (err.killed ? "timeout-or-stopped" : "command-error");
            debugLog(`antigravity-quota: command failed (${safeCode})`);
            return resolve(null);
          }

          let payload;
          try {
            payload = JSON.parse(String(stdout || ""));
          } catch (_parseError) {
            debugLog("antigravity-quota: invalid JSON response");
            return resolve(null);
          }
          const quota = resolveAntigravityCommandQuota(payload, Number(now()));
          if (!quota) {
            debugLog("antigravity-quota: response contained no recognized quota buckets");
            return resolve(null);
          }
          onQuota(quota);
          debugLog(`antigravity-quota: updated ${Object.keys(quota).join(",")}`);
          resolve(quota);
        });
      } catch (_err) {
        child = null;
        debugLog("antigravity-quota: unable to start official CLI");
        resolve(null);
      }
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function start() {
    if (running) return;
    running = true;
    void refreshNow();
    pollTimer = setIntervalImpl(() => { void refreshNow(); }, pollIntervalMs);
    if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
  }

  function stop() {
    running = false;
    if (pollTimer) clearIntervalImpl(pollTimer);
    pollTimer = null;
    if (child && typeof child.kill === "function") child.kill("SIGTERM");
    child = null;
  }

  return { start, stop, refreshNow };
}

createAntigravityQuotaMonitor.resolveAntigravityCli = resolveAntigravityCli;
createAntigravityQuotaMonitor.DEFAULT_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
createAntigravityQuotaMonitor.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

module.exports = createAntigravityQuotaMonitor;
