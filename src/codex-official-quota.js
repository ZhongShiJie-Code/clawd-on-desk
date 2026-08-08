"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_POLL_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 1000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function readAuth(homeDir) {
  try {
    const filePath = path.join(homeDir, ".codex", "auth.json");
    const authData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const tokens = authData && typeof authData.tokens === "object" ? authData.tokens : {};
    return {
      authPath: filePath,
      authData,
      accessToken: typeof tokens.access_token === "string" ? tokens.access_token.trim() : "",
      refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : "",
      accountId: typeof tokens.account_id === "string" ? tokens.account_id.trim() : "",
    };
  } catch {
    return null;
  }
}

function parseResetAt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number > 1e12 ? number : number * 1000;
}

function parseWindow(window, capturedAt) {
  if (!window || typeof window !== "object") return null;
  const rawUsed = Number(window.used_percent);
  if (!Number.isFinite(rawUsed)) return null;
  const usedPercent = Math.max(0, Math.min(100, rawUsed >= 0 && rawUsed <= 1 ? rawUsed * 100 : rawUsed));
  const seconds = Number(window.limit_window_seconds);
  const windowMinutes = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : null;
  const resetAt = parseResetAt(window.reset_at);
  if (!windowMinutes || !resetAt || resetAt <= capturedAt) return null;
  return { usedPercent, windowMinutes, resetAt, capturedAt };
}

function parseUsage(payload, capturedAt) {
  const rateLimit = payload && typeof payload === "object" ? payload.rate_limit : null;
  if (!rateLimit || typeof rateLimit !== "object") return null;
  const group = {};
  for (const key of ["primary_window", "secondary_window"]) {
    const bucket = parseWindow(rateLimit[key], capturedAt);
    if (!bucket) continue;
    const field = bucket.windowMinutes >= 24 * 60 ? "codexWeekly" : "codexFiveHour";
    group[field] = bucket;
  }
  return Object.keys(group).length ? group : null;
}

function writeRefreshedAuth(auth, payload) {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken || !auth.authPath) return auth;
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim()
    ? payload.refresh_token.trim()
    : auth.refreshToken;
  const next = {
    ...(auth.authData || {}),
    last_refresh: new Date().toISOString(),
    tokens: {
      ...((auth.authData && auth.authData.tokens) || {}),
      access_token: accessToken,
      refresh_token: refreshToken,
    },
  };
  try {
    fs.writeFileSync(auth.authPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {}
  return { ...auth, authData: next, accessToken, refreshToken };
}

async function refreshAuth(auth, fetchFn) {
  if (!auth || !auth.refreshToken) return auth;
  try {
    const response = await fetchFn(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "clawd-on-desk/codex-quota",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (!response.ok) return auth;
    return writeRefreshedAuth(auth, await response.json());
  } catch {
    return auth;
  }
}

function initOfficialCodexQuota(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const onQuota = typeof options.onQuota === "function" ? options.onQuota : () => {};
  let timer = null;
  let inflight = null;
  let stopped = false;

  async function refresh() {
    if (stopped) return null;
    if (inflight) return inflight;
    inflight = (async () => {
      let auth = readAuth(homeDir);
      if (!auth || !auth.accessToken) return null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const request = (currentAuth) => {
          const headers = {
            Authorization: `Bearer ${currentAuth.accessToken}`,
            Accept: "application/json",
            "User-Agent": "codex-cli",
          };
          if (currentAuth.accountId) headers["ChatGPT-Account-Id"] = currentAuth.accountId;
          return fetch(USAGE_URL, { headers, signal: controller.signal });
        };
        let response = await request(auth);
        if ((response.status === 401 || response.status === 403) && auth.refreshToken) {
          auth = await refreshAuth(auth, fetch);
          response = await request(auth);
        }
        if (!response.ok) return null;
        const group = parseUsage(await response.json(), Date.now());
        if (group) onQuota(group);
        return group;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  function start() {
    refresh().catch(() => {});
    if (pollMs > 0) timer = setInterval(() => refresh().catch(() => {}), pollMs);
  }

  function cleanup() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, refresh, cleanup };
}

module.exports = initOfficialCodexQuota;
