"use strict";

// Claude Desktop Cowork deliberately launches Claude Code with an isolated
// CLAUDE_CONFIG_DIR, so user-level hooks are not loaded. Its local-agent
// transcript is, however, an append-only record with the real session id and
// tool/completion boundaries. This monitor turns those records into normal
// Clawd /state events without modifying or injecting into Claude Desktop.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { postStateToRunningServer } = require("../hooks/server-config");

const DEFAULT_ROOT = path.join(os.homedir(), "Library", "Application Support", "Claude-3p", "local-agent-mode-sessions");

function listDirectories(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch { return []; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function latestTranscriptEvent(file) {
  let lines;
  try { lines = fs.readFileSync(file, "utf8").trim().split("\n"); } catch { return null; }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = readJsonLine(lines[index]);
    if (!entry || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    // Tool results are represented as role=user. They are not a new user
    // prompt, so keep scanning back to the preceding tool boundary.
    if (role === "user" && (entry.message.tool_use_id || content.some((block) => block && block.type === "tool_result"))) continue;
    const tool = content.find((block) => block && block.type === "tool_use");
    if (role === "assistant" && tool) {
      const toolName = tool.name || null;
      return toolName === "Task"
        ? { state: "juggling", event: "SubagentStart", toolName }
        : { state: "working", event: "PreToolUse", toolName };
    }
    return role === "assistant"
      ? { state: "attention", event: "Stop", toolName: null }
      : { state: "thinking", event: "UserPromptSubmit", toolName: null };
  }
  return null;
}

function readJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// Cowork writes the authoritative selected model and context window to its
// per-session audit log. The transcript can be routed through a proxy, so its
// message.model is not a reliable display value. modelUsage's token totals are
// lifetime counters, though, and must not be shown as the current context.
function latestAuditContextWindow(file, selectedModel) {
  let lines;
  try { lines = fs.readFileSync(file, "utf8").trim().split("\n"); } catch { return null; }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const usageByModel = readJsonLine(lines[index])?.modelUsage;
    if (!usageByModel || typeof usageByModel !== "object") continue;
    const usage = usageByModel[selectedModel]
      || (Object.keys(usageByModel).length === 1 ? usageByModel[Object.keys(usageByModel)[0]] : null);
    if (!usage || typeof usage !== "object") continue;
    const limit = Number(usage.contextWindow);
    if (Number.isFinite(limit) && limit > 0) return limit;
  }
  return null;
}

function latestTranscriptContextUsage(file, contextWindow) {
  let lines;
  try { lines = fs.readFileSync(file, "utf8").trim().split("\n"); } catch { return null; }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const usage = readJsonLine(lines[index])?.message?.usage;
    if (!usage || typeof usage !== "object") continue;
    const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
      .map(Number)
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (!parts.length) continue;
    const used = parts.reduce((total, value) => total + value, 0);
    const contextUsage = { used };
    if (Number.isFinite(Number(contextWindow)) && Number(contextWindow) > 0) {
      contextUsage.limit = Number(contextWindow);
      contextUsage.percent = Math.round((used / Number(contextWindow)) * 100);
    }
    return contextUsage;
  }
  return null;
}

function discoverSessions(root = DEFAULT_ROOT) {
  const sessions = [];
  const transcriptPaths = new Set();
  const addSession = (meta, transcript, audit) => {
    // Newer Cowork releases write both a parent local_<id>.json and a
    // compatibility .claude/sessions record for one transcript. Prefer the
    // parent record (added first) so Clawd gets one stable session id.
    if (!transcript || transcriptPaths.has(transcript)) return;
    transcriptPaths.add(transcript);
    sessions.push({ meta, transcript, audit });
  };
  for (const account of listDirectories(root)) {
    for (const organization of listDirectories(account)) {
      // Current Cowork stores metadata next to each local session directory:
      //   <org>/local_<id>.json
      //   <org>/local_<id>/.claude/projects/.../<cliSessionId>.jsonl
      // The transcript uses cliSessionId (not the local_ session id).
      let names = [];
      try { names = fs.readdirSync(organization); } catch { names = []; }
      for (const name of names) {
        if (!/^local_.+\.json$/.test(name)) continue;
        const meta = readJson(path.join(organization, name));
        if (!meta || !meta.sessionId) continue;
        const localSession = path.join(organization, name.slice(0, -5));
        const transcriptId = meta.cliSessionId || meta.sessionId;
        const projectDir = path.join(localSession, ".claude", "projects");
        let transcript = null;
        for (const project of listDirectories(projectDir)) {
          const candidate = path.join(project, `${transcriptId}.jsonl`);
          if (fs.existsSync(candidate)) { transcript = candidate; break; }
        }
        addSession(meta, transcript, path.join(localSession, "audit.jsonl"));
      }

      // Keep supporting the older layout in case Desktop reverts it:
      //   <org>/<local-session>/.claude/sessions/<id>.json
      for (const localSession of listDirectories(organization)) {
        const claudeDir = path.join(localSession, ".claude");
        const sessionDir = path.join(claudeDir, "sessions");
        for (const name of (() => { try { return fs.readdirSync(sessionDir); } catch { return []; } })()) {
          if (!name.endsWith(".json")) continue;
          const meta = readJson(path.join(sessionDir, name));
          if (!meta || !meta.sessionId) continue;
          const projectDir = path.join(claudeDir, "projects");
          let transcript = null;
          for (const project of listDirectories(projectDir)) {
            const candidate = path.join(project, `${meta.sessionId}.jsonl`);
            if (fs.existsSync(candidate)) { transcript = candidate; break; }
          }
          addSession(meta, transcript, path.join(localSession, "audit.jsonl"));
        }
      }
    }
  }
  return sessions;
}

function createClaudeDesktopCoworkBridge(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const hasCustomPostState = typeof options.postState === "function";
  const postState = options.postState || ((body, callback) => postStateToRunningServer(
    body,
    { timeoutMs: 500 },
    callback
  ));
  const intervalMs = options.intervalMs || 1200;
  const seen = new Map();
  let timer = null;

  function poll() {
    const sessions = discoverSessions(root);
    for (const { meta, transcript, audit } of sessions) {
      let stat;
      try { stat = fs.statSync(transcript); } catch { continue; }
      const revision = `${stat.mtimeMs}:${stat.size}`;
      const key = `${meta.sessionId}:${revision}`;
      if (seen.has(key)) continue;
      const event = latestTranscriptEvent(transcript);
      if (!event) continue;
      const body = {
        session_id: meta.sessionId,
        state: event.state,
        event: event.event,
        agent_id: "claude-desktop",
        claude_desktop: true,
        // Desktop's internal cwd points at Claude-3p/.../outputs. Prefer the
        // folder the user actually attached to the Cowork conversation.
        cwd: Array.isArray(meta.userSelectedFolders) && meta.userSelectedFolders[0]
          ? meta.userSelectedFolders[0]
          : meta.cwd,
        source_pid: meta.pid,
        agent_pid: meta.pid,
        claude_pid: meta.pid,
      };
      if (typeof meta.title === "string" && meta.title.trim()) body.session_title = meta.title.trim();
      if (typeof meta.model === "string" && meta.model.trim()) body.model = meta.model.trim();
      const contextWindow = latestAuditContextWindow(audit, meta.model);
      const contextUsage = latestTranscriptContextUsage(transcript, contextWindow);
      if (contextUsage) body.context_usage = contextUsage;
      if (event.toolName) body.tool_name = event.toolName;
      debugLog(`Cowork bridge post sid=${meta.sessionId} title=${body.session_title || "-"} event=${event.event}`);
      // Server startup races this monitor by a short interval.  Do not poison
      // the revision cache until the local Clawd server acknowledges it;
      // otherwise the first Cowork state after app launch is silently lost.
      let completed = false;
      const acknowledge = (accepted) => {
        if (completed || accepted === false) {
          if (accepted === false) debugLog(`Cowork bridge rejected sid=${meta.sessionId}`);
          return;
        }
        completed = true;
        for (const existing of seen.keys()) {
          if (existing.startsWith(`${meta.sessionId}:`)) seen.delete(existing);
        }
        seen.set(key, true);
        debugLog(`Cowork bridge accepted sid=${meta.sessionId}`);
      };
      const result = postState(body, acknowledge);
      if (hasCustomPostState) {
        if (result && typeof result.then === "function") result.then(acknowledge, () => {});
        else acknowledge(result);
      }
    }
  }

  return {
    start() {
      // The session root is macOS-only, but avoiding a platform gate here keeps
      // the monitor live in packaged Electron variants where the host runtime
      // can differ from the shell that launched the app. On other platforms the
      // missing root simply discovers zero sessions.
      if (timer) return;
      debugLog(`Cowork bridge start root=${root}`);
      poll();
      timer = setInterval(poll, intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    poll,
  };
}

module.exports = {
  createClaudeDesktopCoworkBridge,
  discoverSessions,
  latestTranscriptEvent,
  latestAuditContextWindow,
  latestTranscriptContextUsage,
};
