"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { redactSecrets } = require("./secret-redact");
const { createClaudeDesktopPermissionAx } = require("./claude-desktop-permission-ax");

const DEFAULT_ROOT = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude-3p",
  "local-agent-mode-sessions",
);
const DEFAULT_INTERVAL_MS = 700;
const INITIAL_SCAN_BYTES = 512 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_TOOL_INPUT_CHARS = 3500;
const MAX_PENDING_AGE_MS = 10 * 60 * 1000;
const NATIVE_CONFIRM_TIMEOUT_MS = 7000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listDirectories(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

// v0.14 already maps Claude Desktop workspaces into the HUD. Permission
// mirroring only needs the same local session metadata and audit path; it does
// not depend on the v0.13 Cowork bridge.
function discoverSessions(root) {
  const sessions = [];
  for (const account of listDirectories(root)) {
    for (const organization of listDirectories(account)) {
      let names = [];
      try { names = fs.readdirSync(organization); } catch { names = []; }
      for (const name of names) {
        if (!/^local_.+\.json$/.test(name)) continue;
        const meta = readJson(path.join(organization, name));
        if (!meta || !meta.sessionId) continue;
        const localSession = path.join(organization, name.slice(0, -5));
        const audit = path.join(localSession, "audit.jsonl");
        if (fs.existsSync(audit)) sessions.push({ meta, audit });
      }
    }
  }
  return sessions;
}

function normalizePath(value) {
  return typeof value === "string" ? value.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

function normalizeActiveSessions(value) {
  if (value && typeof value.entries === "function") {
    return Array.from(value.entries()).map(([id, session]) => ({ id: String(id), session }));
  }
  if (Array.isArray(value)) {
    return value.map((session, index) => ({
      id: String(session && (session.id || session.sessionId) || index),
      session,
    }));
  }
  return [];
}


function parseJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function isRequest(entry) {
  return entry && (entry.type === "permission_request" || entry.subtype === "permission_request");
}

function isResponse(entry) {
  return entry && (entry.type === "permission_response" || entry.subtype === "permission_response");
}

function normalizeDecision(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_-]+/g, "") : "";
}

function nativeDecisionMatches(expected, audit) {
  const decision = normalizeDecision(audit && audit.decision);
  const granted = audit && typeof audit.granted === "boolean" ? audit.granted : null;
  if (expected === "deny") {
    return granted === false || ["deny", "denied", "reject", "rejected"].includes(decision);
  }
  if (granted === false) return false;
  if (expected === "always") {
    return ["always", "alwaysallow", "allow", "allowed", "approve", "approved"].includes(decision)
      || granted === true;
  }
  return ["once", "allowonce", "allow", "allowed", "approve", "approved"].includes(decision)
    || granted === true;
}

function auditTimestamp(entry, fallback = Date.now()) {
  const raw = entry && (entry._audit_timestamp || entry.timestamp || entry.created_at);
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeToolInput(input) {
  if (input == null) return {};
  let serialized;
  try { serialized = JSON.stringify(input); } catch { serialized = String(input); }
  serialized = redactSecrets(serialized);
  if (serialized.length > MAX_TOOL_INPUT_CHARS) {
    serialized = `${serialized.slice(0, MAX_TOOL_INPUT_CHARS - 3)}...`;
  }
  try { return JSON.parse(serialized); } catch { return { value: serialized }; }
}

function buildSessionIndex(sessions, activeSessions) {
  const byCliSessionId = new Map();
  const byLocalSessionId = new Map();
  const active = normalizeActiveSessions(activeSessions);
  for (const session of sessions || []) {
    const meta = session && session.meta;
    if (!meta || meta.isArchived === true || !meta.sessionId) continue;
    const local = String(meta.sessionId);
    const ids = new Set([
      local,
      local.replace(/^local_/, ""),
      meta.cliSessionId && String(meta.cliSessionId),
    ].filter(Boolean));
    const activeMatch = active.find(({ id, session: value }) => {
      const sessionIds = [
        id,
        value && value.id,
        value && value.sessionId,
        value && value.rawSessionId,
        value && value.cliSessionId,
      ].filter(Boolean).map(String);
      if (sessionIds.some((idValue) => ids.has(idValue))) return true;
      return normalizePath(value && value.cwd) === normalizePath(meta.cwd);
    });
    const localSessionId = activeMatch ? activeMatch.id : local;
    const enriched = {
      ...session,
      localSessionId,
      activeSessionId: activeMatch ? activeMatch.id : null,
      activeSession: activeMatch ? activeMatch.session : null,
    };
    byLocalSessionId.set(localSessionId, enriched);
    byLocalSessionId.set(local, enriched);
    if (meta.cliSessionId) byCliSessionId.set(String(meta.cliSessionId), enriched);
  }
  return { byCliSessionId, byLocalSessionId };
}

function findSessionForAudit(index, audit) {
  const cliId = audit && audit.session_id ? String(audit.session_id) : "";
  const localId = audit && audit.local_session_id ? String(audit.local_session_id) : "";
  return index.byCliSessionId.get(cliId) || index.byLocalSessionId.get(localId) || null;
}

function readNewAuditLines(file, state) {
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  if (!stat.isFile()) return [];
  if (state.offset > stat.size) {
    state.offset = 0;
    state.carry = "";
    state.initialized = true;
  }
  if (!state.initialized) {
    state.offset = Math.max(0, stat.size - INITIAL_SCAN_BYTES);
    state.initialized = true;
  }
  if (state.offset >= stat.size) return [];

  const length = Math.min(MAX_READ_BYTES, stat.size - state.offset);
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  try {
    const fd = fs.openSync(file, "r");
    try { bytesRead = fs.readSync(fd, buffer, 0, length, state.offset); }
    finally { fs.closeSync(fd); }
  } catch { return []; }
  state.offset += bytesRead;
  const text = state.carry + buffer.subarray(0, bytesRead).toString("utf8");
  const lines = text.split(/\r?\n/);
  state.carry = lines.pop() || "";
  return lines.map(parseJsonLine).filter(Boolean);
}

function createClaudeDesktopPermissionBridge(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const permission = options.permission;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(250, options.intervalMs) : DEFAULT_INTERVAL_MS;
  const maxPendingAgeMs = Number.isFinite(options.maxPendingAgeMs)
    ? Math.max(30_000, options.maxPendingAgeMs)
    : MAX_PENDING_AGE_MS;
  const confirmTimeoutMs = Number.isFinite(options.confirmTimeoutMs)
    ? Math.max(100, options.confirmTimeoutMs)
    : NATIVE_CONFIRM_TIMEOUT_MS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const focusClaude = typeof options.focusClaude === "function" ? options.focusClaude : () => false;
  const getSessions = typeof options.getSessions === "function" ? options.getSessions : () => null;
  const ax = options.ax || createClaudeDesktopPermissionAx({ debugLog });
  const direct = options.direct || null;
  const directMode = options.directMode === true;
  const reminderOnly = options.reminderOnly === true;
  const fileStates = new Map();
  const pendingByKey = new Map();
  let timer = null;

  function usesDirectProtocol() {
    if (!direct || typeof direct.respond !== "function") return false;
    if (directMode) return true;
    if (typeof direct.isReady === "function") return direct.isReady();
    return typeof direct.isConfigured !== "function" || direct.isConfigured();
  }

  function pendingKey(auditPath, uuid) {
    return `${auditPath}:${uuid}`;
  }

  function isStillPending(entry) {
    return !!(permission && Array.isArray(permission.pendingPermissions)
      && permission.pendingPermissions.includes(entry));
  }

  function removeStaleReferences() {
    for (const [key, entry] of pendingByKey) {
      if (!isStillPending(entry)) pendingByKey.delete(key);
    }
  }

  function resolveNativeEvent(auditPath, audit) {
    const uuid = audit && audit.uuid ? String(audit.uuid) : "";
    if (!uuid) return;
    const key = pendingKey(auditPath, uuid);
    const entry = pendingByKey.get(key);
    if (!entry || !isStillPending(entry)) {
      pendingByKey.delete(key);
      return;
    }
    pendingByKey.delete(key);
    entry._claudeDesktopNativeResolved = true;
    entry._claudeDesktopNativeDecision = typeof audit.decision === "string" ? audit.decision : "unknown";
    entry._claudeDesktopNativeGranted = typeof audit.granted === "boolean" ? audit.granted : null;
    entry._claudeDesktopNativeMatched = entry._claudeDesktopExpectedDecision
      ? nativeDecisionMatches(entry._claudeDesktopExpectedDecision, audit)
      : null;
    debugLog(
      `Claude Desktop permission resolved sid=${entry.sessionId} tool=${entry.toolName}`
      + ` decision=${entry._claudeDesktopNativeDecision} granted=${entry._claudeDesktopNativeGranted}`
      + ` expected=${entry._claudeDesktopExpectedDecision || "native"}`
      + ` matched=${entry._claudeDesktopNativeMatched}`,
    );
    permission.resolvePermissionEntry(entry, "no-decision", "Claude Desktop native permission resolved");
  }

  function createPendingEntry(auditPath, audit, session) {
    const uuid = audit && audit.uuid ? String(audit.uuid) : "";
    if (!uuid || !session || !permission) return null;
    const meta = session.meta || {};
    const toolName = typeof audit.tool_name === "string" && audit.tool_name.trim()
      ? audit.tool_name.trim()
      : "Unknown";
    const entry = {
      res: null,
      abortHandler: null,
      suggestions: [],
      sessionId: session.localSessionId,
      sessionTitle: typeof meta.title === "string" ? meta.title : "",
      bubble: null,
      hideTimer: null,
      toolName,
      toolInput: safeToolInput(audit.tool_input),
      createdAt: now(),
      agentId: "claude-desktop",
      cwd: Array.isArray(meta.userSelectedFolders) && meta.userSelectedFolders[0]
        ? meta.userSelectedFolders[0]
        : meta.cwd || "",
      sourcePid: meta.pid || null,
      agentPid: meta.pid || null,
      claudeDesktopRequestId: uuid,
      claudeDesktopAuditPath: auditPath,
      claudeDesktopActions: reminderOnly ? ["open"] : ["deny", "once", "open"],
      claudeDesktopTransport: reminderOnly
        ? "reminder-only"
        : (usesDirectProtocol() ? "direct" : "accessibility"),
      isClaudeDesktop: true,
      _claudeDesktopPermissionBridge: api,
    };
    pendingByKey.set(pendingKey(auditPath, uuid), entry);
    permission.addPendingPermission(entry, "claude-desktop-permission-added");
    permission.showPermissionBubble(entry);
    debugLog(`Claude Desktop permission request sid=${entry.sessionId} tool=${entry.toolName}`);
    if (reminderOnly) return entry;
    // Direct protocol has a fixed, narrow action set. AX inspection is only a
    // compatibility path for installations that have not enabled direct mode.
    if (usesDirectProtocol()) return entry;
    // Button inventory is best effort. The native card remains the source of
    // truth, so an unavailable AX tree never turns into an automatic decision.
    Promise.resolve(ax.inspect()).then((snapshot) => {
      if (!isStillPending(entry) || !snapshot || !snapshot.ok) return;
      const actions = new Set(["deny", "once", "open"]);
      if (Array.isArray(snapshot.actions) && snapshot.actions.includes("always")) actions.add("always");
      entry.claudeDesktopActions = [...actions];
      if (typeof permission.syncPermissionBubbleContent === "function") {
        permission.syncPermissionBubbleContent(entry);
      }
    }).catch(() => {});
    return entry;
  }

  async function waitForNativeConfirmation(entry) {
    const deadline = now() + confirmTimeoutMs;
    while (now() < deadline) {
      if (entry._claudeDesktopNativeResolved) {
        return {
          confirmed: true,
          matched: entry._claudeDesktopNativeMatched !== false,
          decision: entry._claudeDesktopNativeDecision,
          granted: entry._claudeDesktopNativeGranted,
        };
      }
      if (!isStillPending(entry)) return { confirmed: false, matched: false, reason: "entry-removed" };
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    if (entry._claudeDesktopNativeResolved) {
      return {
        confirmed: true,
        matched: entry._claudeDesktopNativeMatched !== false,
        decision: entry._claudeDesktopNativeDecision,
        granted: entry._claudeDesktopNativeGranted,
      };
    }
    return { confirmed: false, matched: false, reason: "timeout" };
  }

  function prepareNativeDecision(entry, decision) {
    entry._claudeDesktopExpectedDecision = decision;
    entry._claudeDesktopNativeResolved = false;
    entry._claudeDesktopNativeDecision = null;
    entry._claudeDesktopNativeGranted = null;
    entry._claudeDesktopNativeMatched = null;
  }

  function clearNativeDecision(entry) {
    entry._claudeDesktopExpectedDecision = null;
    entry._claudeDesktopResolving = false;
  }

  function processAuditEvent(auditPath, audit, index) {
    if (!audit || typeof audit !== "object" || !audit.uuid) return;
    if (isResponse(audit)) {
      resolveNativeEvent(auditPath, audit);
      return;
    }
    if (!isRequest(audit)) return;
    const eventAge = now() - auditTimestamp(audit, now());
    if (eventAge > maxPendingAgeMs || eventAge < -60_000) return;
    const key = pendingKey(auditPath, String(audit.uuid));
    if (pendingByKey.has(key)) return;
    const session = findSessionForAudit(index, audit);
    if (!session) return;
    createPendingEntry(auditPath, audit, session);
  }

  function poll() {
    removeStaleReferences();
    let activeSessions = null;
    try { activeSessions = getSessions(); } catch {}
    const index = buildSessionIndex(discoverSessions(root), activeSessions);
    const auditPaths = new Set();
    for (const session of index.byLocalSessionId.values()) {
      if (!session.audit) continue;
      const auditPath = path.resolve(session.audit);
      auditPaths.add(auditPath);
      const state = fileStates.get(auditPath) || { offset: 0, carry: "", initialized: false };
      fileStates.set(auditPath, state);
      const events = readNewAuditLines(auditPath, state);
      const resolvedUuids = new Set(
        events.filter(isResponse).map((event) => String(event.uuid)),
      );
      for (const audit of events) {
        if (isRequest(audit) && resolvedUuids.has(String(audit.uuid))) continue;
        processAuditEvent(auditPath, audit, index);
      }
    }
    for (const auditPath of fileStates.keys()) {
      if (!auditPaths.has(auditPath)) fileStates.delete(auditPath);
    }
    const cutoff = now() - maxPendingAgeMs;
    for (const [key, entry] of pendingByKey) {
      if (entry.createdAt >= cutoff || !isStillPending(entry)) continue;
      pendingByKey.delete(key);
      permission.resolvePermissionEntry(entry, "no-decision", "Claude Desktop permission expired");
    }
  }

  async function handleDecision(entry, behavior) {
    if (!entry || !entry.isClaudeDesktop || !isStillPending(entry)) return false;
    if (behavior === "claude-desktop:open" || behavior === "deny-and-focus") {
      focusClaude(entry.sessionId);
      return true;
    }
    if (reminderOnly) {
      debugLog(
        `Claude Desktop reminder ignored authorization decision sid=${entry.sessionId}`
        + ` tool=${entry.toolName} behavior=${String(behavior || "")}`,
      );
      return false;
    }
    const decision = behavior === "claude-desktop:deny" || behavior === "deny"
      ? "deny"
      : behavior === "claude-desktop:always"
        ? "always"
        : "once";
    if (decision === "always" && !entry.claudeDesktopActions.includes("always")) {
      debugLog(`Claude Desktop always decision unavailable transport=${entry.claudeDesktopTransport} sid=${entry.sessionId} tool=${entry.toolName}`);
      focusClaude(entry.sessionId);
      return false;
    }
    if (entry._claudeDesktopResolving) return true;
    entry._claudeDesktopResolving = true;
    prepareNativeDecision(entry, decision);
    if (usesDirectProtocol()) {
      if (!direct.supportsDecision || !direct.supportsDecision(decision)) {
        clearNativeDecision(entry);
        debugLog(`Claude direct permission unsupported decision=${decision} sid=${entry.sessionId} tool=${entry.toolName}`);
        focusClaude(entry.sessionId);
        return false;
      }
      const result = await direct.respond(entry.claudeDesktopRequestId, decision);
      if (!result || !result.ok) {
        clearNativeDecision(entry);
        const reason = result && result.reason ? result.reason : "direct-protocol-failed";
        debugLog(`Claude direct permission failed sid=${entry.sessionId} tool=${entry.toolName} decision=${decision} reason=${reason}`);
        focusClaude(entry.sessionId);
        return false;
      }
      entry._claudeDesktopResponseSent = true;
      const confirmation = await waitForNativeConfirmation(entry);
      clearNativeDecision(entry);
      if (confirmation.confirmed && confirmation.matched) return true;
      if (confirmation.confirmed) {
        debugLog(
          `Claude direct permission mismatch sid=${entry.sessionId} tool=${entry.toolName}`
          + ` expected=${decision} actual=${confirmation.decision} granted=${confirmation.granted}`,
        );
        focusClaude(entry.sessionId);
        return false;
      }
      debugLog(`Claude direct permission confirmation timed out sid=${entry.sessionId} tool=${entry.toolName} decision=${decision}`);
      focusClaude(entry.sessionId);
      return false;
    }
    const result = await ax.press(decision);
    if (!result || !result.ok) {
      clearNativeDecision(entry);
      debugLog(`Claude Desktop AX decision failed sid=${entry.sessionId} tool=${entry.toolName} decision=${decision} reason=${result && result.reason || "unknown"}`);
      focusClaude(entry.sessionId);
      return false;
    }
    entry._claudeDesktopResponseSent = true;
    const confirmation = await waitForNativeConfirmation(entry);
    clearNativeDecision(entry);
    if (confirmation.confirmed && confirmation.matched) {
      debugLog(
        `Claude Desktop AX decision confirmed sid=${entry.sessionId} tool=${entry.toolName}`
        + ` expected=${decision} actual=${confirmation.decision} granted=${confirmation.granted}`,
      );
      return true;
    }
    if (confirmation.confirmed) {
      debugLog(
        `Claude Desktop AX decision mismatch sid=${entry.sessionId} tool=${entry.toolName}`
        + ` expected=${decision} actual=${confirmation.decision} granted=${confirmation.granted}`,
      );
      focusClaude(entry.sessionId);
      return false;
    }
    debugLog(`Claude Desktop AX confirmation timed out sid=${entry.sessionId} tool=${entry.toolName} decision=${decision}`);
    focusClaude(entry.sessionId);
    return false;
  }

  const api = {
    start() {
      if (timer) return;
      debugLog(`Claude Desktop permission bridge start root=${root}`);
      try { direct?.start?.(); } catch (error) {
        debugLog(`Claude direct permission probe start failed reason=${error && error.message || "unknown"}`);
      }
      poll();
      timer = setInterval(poll, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      try { direct?.close?.(); } catch {}
    },
    poll,
    handleDecision,
    pendingByKey,
  };
  return api;
}

module.exports = {
  createClaudeDesktopPermissionBridge,
  parseJsonLine,
  safeToolInput,
  buildSessionIndex,
  readNewAuditLines,
};
