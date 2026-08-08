"use strict";

const http = require("http");
const WebSocket = require("ws");

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_CDP_PORT = 19222;
const DEFAULT_PROBE_INTERVAL_MS = 2500;
const ALLOWED_DECISIONS = new Set(["once", "deny"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const API_EXPRESSION = "globalThis?.claude?.web?.LocalAgentModeSessions";

function asPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function isLocalUrl(value) {
  try {
    const parsed = new URL(value);
    return LOCAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function requestJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const parsed = new URL(url);
    if (!isLocalUrl(url)) {
      finish(reject, new Error("CDP endpoint must be loopback-only"));
      return;
    }
    const req = http.get({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: `${parsed.pathname}${parsed.search}`,
      timeout: timeoutMs,
      family: parsed.hostname === "::1" ? 6 : 4,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 256 * 1024) body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          finish(reject, new Error(`CDP target discovery returned HTTP ${res.statusCode}`));
          return;
        }
        try { finish(resolve, JSON.parse(body)); }
        catch { finish(reject, new Error("CDP target discovery returned invalid JSON")); }
      });
    });
    req.on("error", (error) => finish(reject, error));
    req.on("timeout", () => {
      req.destroy();
      finish(reject, new Error("CDP target discovery timed out"));
    });
  });
}

function chooseTarget(targets) {
  if (!Array.isArray(targets)) return null;
  const candidates = targets.filter((target) => {
    if (!target || typeof target.webSocketDebuggerUrl !== "string") return false;
    if (target.type && target.type !== "page") return false;
    const url = String(target.url || "");
    return url.startsWith("app://")
      || url.startsWith("file:")
      || url.startsWith("https://claude.ai")
      || url.startsWith("https://claude.com")
      || url.startsWith("https://preview.claude.ai")
      || url.startsWith("https://preview.claude.com")
      || url.includes("claude");
  });
  return candidates.find((target) => /claude/i.test(`${target.title || ""} ${target.url || ""}`))
    || candidates[0]
    || null;
}

function buildDecisionExpression(requestId, decision, updatedInput) {
  const id = JSON.stringify(String(requestId));
  const action = JSON.stringify(String(decision));
  const input = updatedInput === undefined ? "undefined" : JSON.stringify(updatedInput);
  return `(() => {
    const api = ${API_EXPRESSION};
    if (!api || typeof api.respondToToolPermission !== "function") {
      return { ok: false, reason: "claude-permission-api-unavailable" };
    }
    return Promise.resolve(api.respondToToolPermission(${id}, ${action}, ${input}))
      .then(() => ({ ok: true }));
  })()`;
}

class CdpConnection {
  constructor(url, timeoutMs) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.url, { handshakeTimeout: this.timeoutMs });
      this.socket = socket;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      socket.once("open", () => finish(resolve));
      socket.once("error", (error) => finish(reject, error));
      socket.on("message", (raw) => this.handleMessage(raw));
      socket.on("close", () => this.failPending(new Error("CDP connection closed")));
      socket.on("error", () => {});
    });
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || !Number.isInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "CDP command failed"));
      return;
    }
    pending.resolve(message.result || {});
  }

  failPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  command(method, params = {}) {
    return this.connect().then(() => new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    }));
  }

  async evaluate(expression) {
    const response = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.text || "Claude renderer evaluation failed";
      throw new Error(description);
    }
    const value = response.result && response.result.value;
    if (!value || typeof value !== "object") throw new Error("Claude renderer returned no result");
    return value;
  }

  close() {
    this.failPending(new Error("CDP connection closed"));
    if (this.socket) {
      try { this.socket.close(); } catch {}
    }
    this.socket = null;
  }
}

function createClaudeDesktopPermissionDirect(options = {}) {
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(500, options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const environment = options.env && typeof options.env === "object" ? options.env : process.env;
  const configuredPort = asPort(options.port || environment.CLAWD_CLAUDE_CDP_PORT
    || (options.env ? null : DEFAULT_CDP_PORT));
  const configuredWsEndpoint = typeof options.wsEndpoint === "string"
    && isLocalUrl(options.wsEndpoint)
    ? options.wsEndpoint
    : "";
  const inFlight = new Map();
  let connection = null;
  let probeTimer = null;
  let probePromise = null;
  let ready = false;

  function isConfigured() {
    return !!(configuredPort || configuredWsEndpoint);
  }

  function isReady() {
    return ready;
  }

  async function discoverTarget() {
    if (configuredWsEndpoint) return { webSocketDebuggerUrl: configuredWsEndpoint };
    if (!configuredPort) throw new Error("Claude direct protocol is not configured");
    const targets = await requestJson(`http://127.0.0.1:${configuredPort}/json/list`, timeoutMs);
    const target = chooseTarget(targets);
    if (!target) throw new Error("No Claude renderer target found on the loopback CDP endpoint");
    return target;
  }

  async function refresh() {
    if (!isConfigured()) {
      ready = false;
      return false;
    }
    if (probePromise) return probePromise;
    probePromise = discoverTarget().then(() => {
      if (!ready) debugLog("Claude direct permission endpoint ready");
      ready = true;
      return true;
    }).catch((error) => {
      if (ready) debugLog(`Claude direct permission endpoint unavailable reason=${error.message}`);
      ready = false;
      connection?.close();
      connection = null;
      return false;
    }).finally(() => {
      probePromise = null;
    });
    return probePromise;
  }

  async function respond(requestId, decision, updatedInput) {
    const id = String(requestId || "");
    if (!id) return { ok: false, reason: "missing-request-id" };
    if (!ALLOWED_DECISIONS.has(decision)) return { ok: false, reason: "unsupported-decision" };
    const existing = inFlight.get(id);
    if (existing) return existing;
    const task = (async () => {
      try {
        const target = await discoverTarget();
        if (!target || !isLocalUrl(target.webSocketDebuggerUrl)) {
          return { ok: false, reason: "non-loopback-cdp-target" };
        }
        if (!connection || connection.url !== target.webSocketDebuggerUrl) {
          connection?.close();
          connection = new CdpConnection(target.webSocketDebuggerUrl, timeoutMs);
        }
        const result = await connection.evaluate(buildDecisionExpression(id, decision, updatedInput));
        if (!result.ok) return result;
        ready = true;
        debugLog(`Claude direct permission sent request=${id} decision=${decision}`);
        return { ok: true, requestId: id, decision };
      } catch (error) {
        ready = false;
        connection?.close();
        connection = null;
        const reason = error && error.message ? error.message : "direct-protocol-failed";
        debugLog(`Claude direct permission failed request=${id} decision=${decision} reason=${reason}`);
        return { ok: false, reason };
      } finally {
        inFlight.delete(id);
      }
    })();
    inFlight.set(id, task);
    return task;
  }

  return {
    isConfigured,
    isReady,
    supportsDecision: (decision) => ALLOWED_DECISIONS.has(decision),
    respond,
    start() {
      if (probeTimer || !isConfigured()) return;
      void refresh();
      probeTimer = setInterval(() => { void refresh(); }, DEFAULT_PROBE_INTERVAL_MS);
      probeTimer.unref?.();
    },
    close() {
      if (probeTimer) clearInterval(probeTimer);
      probeTimer = null;
      ready = false;
      for (const task of inFlight.values()) void task.catch(() => {});
      inFlight.clear();
      connection?.close();
      connection = null;
    },
  };
}

module.exports = {
  ALLOWED_DECISIONS,
  DEFAULT_CDP_PORT,
  buildDecisionExpression,
  chooseTarget,
  createClaudeDesktopPermissionDirect,
  isLocalUrl,
};
