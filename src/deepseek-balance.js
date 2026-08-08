"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const DEFAULT_POLL_MS = 30000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveConfigValue(config) {
  if (typeof config !== "string" || !config.trim()) return undefined;
  const trimmed = config.trim();
  if (trimmed.startsWith("!")) {
    try {
      const output = execSync(trimmed.slice(1), {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return output || undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
    const envValue = process.env[trimmed];
    return typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
  }
  return process.env[trimmed] || trimmed;
}

function parseDeepseekApiKeyFromProxyScript(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const match = text.match(/\bDEEPSEEK_API_KEY\s*=\s*['"]([^'"]+)['"]/);
    return match && match[1] ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

function parseDeepseekApiKeyFromEnvFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key !== "DEEPSEEK_API_KEY") continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveDeepseekApiKey(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  if (typeof env.DEEPSEEK_API_KEY === "string" && env.DEEPSEEK_API_KEY.trim()) {
    return env.DEEPSEEK_API_KEY.trim();
  }

  // Hermes .env (primary config for this user)
  const hermesEnvKey = parseDeepseekApiKeyFromEnvFile(
    options.hermesEnvPath || path.join(homeDir, ".hermes", ".env")
  );
  if (hermesEnvKey) return hermesEnvKey;

  // Hermes proxy script (active in current multi-agent setup)
  const hermesProxyKey = parseDeepseekApiKeyFromProxyScript(
    options.hermesProxyPath || path.join(homeDir, ".hermes", "shared", "workspace", "scripts", "ai-pet-proxy.mjs")
  );
  if (hermesProxyKey) return hermesProxyKey;

  const openclawModels = readJson(options.openclawModelsPath || path.join(homeDir, ".openclaw", "agents", "main", "agent", "models.json"));
  const modelsApiKey = openclawModels
    && openclawModels.providers
    && openclawModels.providers.deepseek
    && typeof openclawModels.providers.deepseek.apiKey === "string"
    ? resolveConfigValue(openclawModels.providers.deepseek.apiKey)
    : undefined;
  if (modelsApiKey) return modelsApiKey;

  const openclawConfig = readJson(options.openclawConfigPath || path.join(homeDir, ".openclaw", "openclaw.json"));
  const configApiKey = openclawConfig
    && openclawConfig.models
    && openclawConfig.models.providers
    && openclawConfig.models.providers.deepseek
    && typeof openclawConfig.models.providers.deepseek.apiKey === "string"
    ? resolveConfigValue(openclawConfig.models.providers.deepseek.apiKey)
    : undefined;
  if (configApiKey) return configApiKey;

  // Legacy OpenClaw v1 proxy script
  const legacyProxyKey = parseDeepseekApiKeyFromProxyScript(
    options.aiPetProxyPath || path.join(homeDir, ".openclaw", "workspace", "scripts", "ai-pet-proxy.mjs")
  );
  if (legacyProxyKey) return legacyProxyKey;

  return undefined;
}

function parseAmount(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseDeepseekBalancePayload(payload) {
  const infos = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  const entries = infos.map((info) => {
    const total = parseAmount(info && info.total_balance);
    if (total === undefined) return null;
    const granted = parseAmount(info && info.granted_balance);
    const toppedUp = parseAmount(info && info.topped_up_balance);
    return {
      currency: typeof (info && info.currency) === "string" ? info.currency : "",
      total,
      granted: granted !== undefined ? granted : null,
      toppedUp: toppedUp !== undefined ? toppedUp : null,
    };
  }).filter(Boolean);

  if (!entries.length) {
    return {
      status: "error",
      error: "No balance data",
      available: payload && payload.is_available !== false,
      entries: [],
    };
  }

  return {
    status: "ok",
    error: null,
    available: payload && payload.is_available !== false,
    entries,
  };
}

async function fetchDeepseekBalance(apiKey, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(DEEPSEEK_BALANCE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: "error", error: `HTTP ${response.status}`, available: false, entries: [] };
    }
    const payload = await response.json();
    return parseDeepseekBalancePayload(payload);
  } catch (err) {
    return {
      status: "error",
      error: err && err.name === "AbortError" ? "Timed out" : (err && err.message ? err.message : "Request failed"),
      available: false,
      entries: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = function initDeepseekBalance(options = {}) {
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const onChange = typeof options.onChange === "function" ? options.onChange : null;
  let timer = null;
  let inflight = null;
  let stopped = false;
  let snapshot = {
    status: "unavailable",
    error: "DeepSeek API key not configured",
    available: false,
    entries: [],
    updatedAt: 0,
  };

  function publish(next) {
    const normalized = {
      ...next,
      updatedAt: Date.now(),
    };
    if (snapshotsEqual(snapshot, normalized)) return;
    snapshot = normalized;
    if (onChange) onChange(snapshot);
  }

  async function refresh() {
    if (stopped) return snapshot;
    if (inflight) return inflight;
    inflight = (async () => {
      const apiKey = resolveDeepseekApiKey(options);
      if (!apiKey) {
        publish({
          status: "unavailable",
          error: "DeepSeek API key not configured",
          available: false,
          entries: [],
        });
        return snapshot;
      }
      const next = await fetchDeepseekBalance(apiKey, {
        fetchFn: options.fetchFn,
        timeoutMs,
      });
      publish(next);
      return snapshot;
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  function start() {
    refresh().catch(() => {});
    if (pollMs > 0) {
      timer = setInterval(() => {
        refresh().catch(() => {});
      }, pollMs);
    }
  }

  function cleanup() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    refresh,
    cleanup,
    getSnapshot: () => snapshot,
  };
};

module.exports.__test = {
  parseDeepseekBalancePayload,
  resolveConfigValue,
  resolveDeepseekApiKey,
  parseDeepseekApiKeyFromProxyScript,
  parseDeepseekApiKeyFromEnvFile,
};
