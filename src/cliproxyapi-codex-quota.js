"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeQuotaGroup, anchorRelativeResetAt } = require("../hooks/quota-bucket");
const { CODEX_QUOTA_FIELDS } = require("../hooks/codex-rate-limits");

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "cliproxyapi", "config.yaml");
const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_LOG_PATH = path.join(os.homedir(), ".cli-proxy-api", "logs", "main.log");
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 15000;
const DEFAULT_PERIODIC_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const LONG_WINDOW_THRESHOLD_MINUTES = 24 * 60;

function expandHome(value, homeDir = os.homedir()) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/")) return path.join(homeDir, trimmed.slice(2));
  return trimmed;
}

// CLIProxyAPI's config is YAML, but auth-dir is a scalar and reading just that
// line keeps this monitor independent from a YAML package in the Electron app.
function parseCliProxyApiConfig(configText, homeDir = os.homedir()) {
  if (typeof configText !== "string") return {};
  const match = configText.match(/^\s*auth-dir\s*:\s*(.*?)\s*(?:#.*)?$/m);
  if (!match) return {};
  const authDir = expandHome(match[1], homeDir);
  return authDir ? { authDir } : {};
}

function resolveAuthDir({ configPath = DEFAULT_CONFIG_PATH, homeDir = os.homedir(), readFileImpl = fs.readFileSync } = {}) {
  try {
    const configText = readFileImpl(configPath, "utf8");
    const parsed = parseCliProxyApiConfig(configText, homeDir);
    return parsed.authDir || path.join(homeDir, ".cli-proxy-api");
  } catch (_err) {
    return path.join(homeDir, ".cli-proxy-api");
  }
}

function selectCodexCredential(files, { statImpl = fs.statSync, readFileImpl = fs.readFileSync } = {}) {
  const candidates = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (typeof file !== "string" || !file.endsWith(".json")) continue;
    try {
      const fullPath = file;
      const credential = JSON.parse(readFileImpl(fullPath, "utf8"));
      if (credential.disabled === true || credential.type !== "codex") continue;
      if (typeof credential.access_token !== "string" || !credential.access_token) continue;
      if (typeof credential.account_id !== "string" || !credential.account_id) continue;
      let mtimeMs = 0;
      try {
        const stat = statImpl(fullPath);
        mtimeMs = Number(stat && stat.mtimeMs) || 0;
      } catch (_err) {
        // A credential can still be usable when its stat call races a refresh.
      }
      candidates.push({ credential, mtimeMs, fullPath });
    } catch (_err) {
      // Ignore partially-written or non-credential JSON files.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.fullPath.localeCompare(b.fullPath));
  return candidates.length ? candidates[0].credential : null;
}

function readCodexCredential({ authDir, readdirImpl = fs.readdirSync, statImpl = fs.statSync, readFileImpl = fs.readFileSync } = {}) {
  if (!authDir) return null;
  try {
    const names = readdirImpl(authDir).map((name) => path.join(authDir, name));
    return selectCodexCredential(names, { statImpl, readFileImpl });
  } catch (_err) {
    return null;
  }
}

function parseUsageBucket(bucket, nowMs) {
  if (!bucket || typeof bucket !== "object") return null;
  const usedPercent = Number(bucket.used_percent);
  if (!Number.isFinite(usedPercent)) return null;

  const entry = { usedPercent };
  const limitWindowSeconds = Number(bucket.limit_window_seconds);
  if (Number.isFinite(limitWindowSeconds) && limitWindowSeconds > 0) {
    entry.windowMinutes = limitWindowSeconds / 60;
  }

  const resetAtSeconds = Number(bucket.reset_at);
  if (Number.isFinite(resetAtSeconds) && resetAtSeconds > 0) {
    entry.resetAt = resetAtSeconds * 1000;
  } else {
    const resetAt = anchorRelativeResetAt(bucket.reset_after_seconds, nowMs);
    if (resetAt !== null) entry.resetAt = resetAt;
  }
  entry.capturedAt = nowMs;
  return entry;
}

function parseOfficialUsage(payload, nowMs = Date.now()) {
  const rateLimit = payload && typeof payload.rate_limit === "object" ? payload.rate_limit : null;
  if (!rateLimit) return null;

  const out = {};
  for (const key of ["primary_window", "secondary_window"]) {
    const entry = parseUsageBucket(rateLimit[key], nowMs);
    if (!entry) continue;
    let field = Number(entry.windowMinutes) >= LONG_WINDOW_THRESHOLD_MINUTES
      ? "codexWeekly"
      : "codexFiveHour";
    if (out[field]) field = field === "codexFiveHour" ? "codexWeekly" : "codexFiveHour";
    out[field] = entry;
  }
  return normalizeQuotaGroup(out, CODEX_QUOTA_FIELDS);
}

function createAbortTimeout(timeoutMs, setTimeoutImpl, clearTimeoutImpl) {
  const controller = new AbortController();
  const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel() {
      clearTimeoutImpl(timer);
    },
  };
}

function createCliProxyApiCodexQuotaMonitor(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const configPath = options.configPath || path.join(homeDir, ".config", "cliproxyapi", "config.yaml");
  const usageUrl = options.usageUrl || DEFAULT_USAGE_URL;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
  const minRefreshIntervalMs = Number.isFinite(options.minRefreshIntervalMs)
    ? options.minRefreshIntervalMs
    : DEFAULT_MIN_REFRESH_INTERVAL_MS;
  const periodicRefreshMs = Number.isFinite(options.periodicRefreshMs)
    ? options.periodicRefreshMs
    : DEFAULT_PERIODIC_REFRESH_MS;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? options.requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const statImpl = options.statImpl || fs.statSync;
  const readFileImpl = options.readFileImpl || fs.readFileSync;
  const readdirImpl = options.readdirImpl || fs.readdirSync;
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  const onQuota = typeof options.onQuota === "function" ? options.onQuota : () => {};
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const logPath = options.logPath || DEFAULT_LOG_PATH;

  let running = false;
  let pollTimer = null;
  let periodicTimer = null;
  let debounceTimer = null;
  let lastLogSignature = null;
  let lastRefreshAt = -Infinity;
  let refreshPromise = null;

  function readLogSignature() {
    try {
      const stat = statImpl(logPath);
      return `${Number(stat && stat.mtimeMs) || 0}:${Number(stat && stat.size) || 0}`;
    } catch (_err) {
      return null;
    }
  }

  async function refreshNow(force = false) {
    const timestamp = Number(now());
    if (!force && timestamp - lastRefreshAt < minRefreshIntervalMs) return null;
    if (refreshPromise) return refreshPromise;
    lastRefreshAt = timestamp;
    refreshPromise = (async () => {
      if (typeof fetchImpl !== "function") return null;
      const authDir = resolveAuthDir({ configPath, homeDir, readFileImpl });
      const credential = readCodexCredential({ authDir, readdirImpl, statImpl, readFileImpl });
      if (!credential) {
        debugLog("cliproxy-quota: no active Codex credential");
        return null;
      }

      const timeout = createAbortTimeout(requestTimeoutMs, setTimeoutImpl, clearTimeoutImpl);
      try {
        const response = await fetchImpl(usageUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.access_token}`,
            "ChatGPT-Account-ID": credential.account_id,
            "User-Agent": "Codex/1.0",
          },
          signal: timeout.signal,
        });
        if (!response || !response.ok) {
          debugLog(`cliproxy-quota: official usage returned ${response && response.status ? response.status : "no-status"}`);
          return null;
        }
        const payload = await response.json();
        const quota = parseOfficialUsage(payload, Number(now()));
        if (!quota) {
          debugLog("cliproxy-quota: official usage contained no rate limit window");
          return null;
        }
        onQuota(quota);
        debugLog(`cliproxy-quota: updated ${Object.keys(quota).join(",")}`);
        return quota;
      } catch (err) {
        debugLog(`cliproxy-quota: refresh failed ${err && err.name === "AbortError" ? "timeout" : "request-error"}`);
        return null;
      } finally {
        timeout.cancel();
      }
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function scheduleRefresh() {
    if (!running) return;
    if (debounceTimer) clearTimeoutImpl(debounceTimer);
    debounceTimer = setTimeoutImpl(() => {
      debounceTimer = null;
      void refreshNow(false);
    }, debounceMs);
  }

  function poll() {
    const signature = readLogSignature();
    if (signature && signature !== lastLogSignature) {
      lastLogSignature = signature;
      // If the gateway log was absent at startup and appears later, that is
      // also a real activity edge and should not wait for the periodic poll.
      scheduleRefresh();
    }
  }

  function start() {
    if (running) return monitor;
    running = true;
    lastLogSignature = readLogSignature();
    void refreshNow(true);
    pollTimer = setIntervalImpl(poll, pollIntervalMs);
    periodicTimer = setIntervalImpl(() => { void refreshNow(false); }, periodicRefreshMs);
    return monitor;
  }

  function stop() {
    running = false;
    if (pollTimer) clearIntervalImpl(pollTimer);
    if (periodicTimer) clearIntervalImpl(periodicTimer);
    if (debounceTimer) clearTimeoutImpl(debounceTimer);
    pollTimer = null;
    periodicTimer = null;
    debounceTimer = null;
  }

  const monitor = { start, stop, poll, refreshNow, parseOfficialUsage };
  return monitor;
}

module.exports = createCliProxyApiCodexQuotaMonitor;
module.exports.createCliProxyApiCodexQuotaMonitor = createCliProxyApiCodexQuotaMonitor;
module.exports.expandHome = expandHome;
module.exports.parseCliProxyApiConfig = parseCliProxyApiConfig;
module.exports.resolveAuthDir = resolveAuthDir;
module.exports.selectCodexCredential = selectCodexCredential;
module.exports.readCodexCredential = readCodexCredential;
module.exports.parseUsageBucket = parseUsageBucket;
module.exports.parseOfficialUsage = parseOfficialUsage;
