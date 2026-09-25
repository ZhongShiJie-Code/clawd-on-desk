"use strict";

// Claude Desktop runs Claude Code with an isolated config directory, so the
// normal user-level hook chain is not guaranteed to run. Its local-agent
// transcript is append-only and contains the real session id and turn/tool
// boundaries. Convert those records into normal Clawd /state events without
// changing Claude Desktop's files or permission authority.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { postStateToRunningServer } = require("../hooks/server-config");

const DEFAULT_ROOT = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude-3p",
  "local-agent-mode-sessions",
);
const AUDIT_INITIAL_READ_LIMIT = 512 * 1024;
const AUDIT_POLL_READ_LIMIT = 1024 * 1024;
const AUDIT_REMINDER_MAX_AGE_MS = 10 * 60 * 1000;

function listDirectories(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isToolResultMessage(message) {
  const content = Array.isArray(message && message.content) ? message.content : [];
  return content.some((block) => block && block.type === "tool_result");
}

function latestTranscriptEvent(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").trim().split("\n");
  } catch {
    return null;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = readJsonLine(lines[index]);
    if (!entry || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    const tool = content.find((block) => block && block.type === "tool_use");
    if (role === "assistant" && tool) {
      return { state: "working", event: "PreToolUse", toolName: tool.name || null };
    }
    // Claude Code serializes tool results as user messages. They are a
    // response to the preceding assistant tool call, not a new prompt.
    // Continue backwards until that tool call is found so the HUD remains
    // working while Claude processes the next step.
    if (role === "user" && isToolResultMessage(entry.message)) continue;
    return role === "assistant"
      ? { state: "attention", event: "Stop", toolName: null }
      : { state: "thinking", event: "UserPromptSubmit", toolName: null };
  }
  return null;
}

function findTranscript(claudeDir, meta) {
  const projectDir = path.join(claudeDir, "projects");
  const sessionIds = [meta.cliSessionId, meta.sessionId]
    .filter((value, index, values) => typeof value === "string" && value && values.indexOf(value) === index);
  for (const project of listDirectories(projectDir)) {
    for (const sessionId of sessionIds) {
      const candidate = path.join(project, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function mergeSessionMetadata(officialMeta, processMeta) {
  // The sibling local_<id>.json is the authoritative user-facing metadata.
  // Process metadata may contain pid/cwd, but must not overwrite its title.
  const merged = { ...(officialMeta || {}), ...(processMeta || {}) };
  if (typeof officialMeta?.title === "string" && officialMeta.title.trim()) {
    merged.title = officialMeta.title;
  }
  return merged;
}

function canonicalTranscriptKey(file) {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync(absolute);
  } catch {
    // The transcript can disappear between discovery and stat; keep a stable
    // normalized path so a transient filesystem race cannot crash discovery.
    return absolute;
  }
}

function mergePreferredSessionRecord(preferred, fallback) {
  const preferredMeta = preferred && preferred.meta ? preferred.meta : {};
  const fallbackMeta = fallback && fallback.meta ? fallback.meta : {};
  const mergedMeta = { ...fallbackMeta, ...preferredMeta };

  // Keep the modern local_<id>.json identity, title, cwd, and other
  // user-facing fields authoritative, while retaining process-only fields
  // such as pid when the modern metadata does not provide them.
  for (const [key, value] of Object.entries(fallbackMeta)) {
    if ((mergedMeta[key] === null || mergedMeta[key] === undefined || mergedMeta[key] === "")
      && value !== null && value !== undefined && value !== "") {
      mergedMeta[key] = value;
    }
  }

  return {
    meta: mergedMeta,
    transcript: preferred.transcript,
    auditFile: preferred.auditFile || fallback.auditFile || null,
  };
}

function discoverModernSessions(organization) {
  const sessions = [];
  let entries;
  try {
    entries = fs.readdirSync(organization, { withFileTypes: true });
  } catch {
    return sessions;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^local_[^/]+\.json$/.test(entry.name)) continue;
    const metadataFile = path.join(organization, entry.name);
    const officialMeta = readJson(metadataFile);
    if (!officialMeta || !officialMeta.sessionId || typeof officialMeta.cwd !== "string") continue;
    const sessionRoot = path.dirname(officialMeta.cwd);
    const claudeDir = path.join(sessionRoot, ".claude");
    if (!fs.existsSync(claudeDir)) continue;
    const transcript = findTranscript(claudeDir, officialMeta);
    if (!transcript) continue;
    sessions.push({
      meta: mergeSessionMetadata(officialMeta, null),
      transcript,
      auditFile: path.join(sessionRoot, "audit.jsonl"),
    });
  }
  return sessions;
}

function discoverSessions(root = DEFAULT_ROOT) {
  const byTranscript = new Map();

  function addCandidate(candidate, priority) {
    const transcriptKey = canonicalTranscriptKey(candidate.transcript);
    const current = byTranscript.get(transcriptKey);
    if (!current) {
      byTranscript.set(transcriptKey, { candidate, priority });
      return;
    }

    if (priority > current.priority) {
      byTranscript.set(transcriptKey, {
        candidate: mergePreferredSessionRecord(candidate, current.candidate),
        priority,
      });
    } else {
      // Keep the higher-priority identity, but still retain process-only
      // fields discovered by a lower-priority legacy record.
      byTranscript.set(transcriptKey, {
        candidate: mergePreferredSessionRecord(current.candidate, candidate),
        priority: current.priority,
      });
    }
  }

  for (const account of listDirectories(root)) {
    for (const organization of listDirectories(account)) {
      // Claude Desktop 1.3+ stores the official local_<id>.json metadata
      // beside a short-hash session directory. The old bridge only searched
      // for session process files inside that hash directory, so it missed
      // both the transcript and the user-facing title.
      for (const candidate of discoverModernSessions(organization)) {
        addCandidate(candidate, 2);
      }

      for (const localSession of listDirectories(organization)) {
        const claudeDir = path.join(localSession, ".claude");
        const sessionDir = path.join(claudeDir, "sessions");
        // The session process file contains the CLI id and PID, while the
        // sibling Cowork metadata file contains the user-facing title.
        const coworkMeta = readJson(`${localSession}.json`) || {};
        let sessionNames;
        try {
          sessionNames = fs.readdirSync(sessionDir);
        } catch {
          sessionNames = [];
        }
        for (const name of sessionNames) {
          if (!name.endsWith(".json")) continue;
          const processMeta = readJson(path.join(sessionDir, name));
          const meta = processMeta
            ? mergeSessionMetadata(coworkMeta, processMeta)
            : null;
          if (!meta || !meta.sessionId) continue;
          const projectDir = path.join(claudeDir, "projects");
          let transcript = null;
          for (const project of listDirectories(projectDir)) {
            const candidate = path.join(project, `${meta.sessionId}.jsonl`);
            if (fs.existsSync(candidate)) {
              transcript = candidate;
              break;
            }
          }
          if (transcript) addCandidate({
            meta,
            transcript,
            auditFile: path.join(localSession, "audit.jsonl"),
          }, 1);
        }
      }
    }
  }

  return Array.from(byTranscript.values(), ({ candidate }) => candidate);
}

function createClaudeDesktopCoworkBridge(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const postState = options.postState || ((body) => postStateToRunningServer(
    body,
    { timeoutMs: 500 },
    () => {},
  ));
  const intervalMs = options.intervalMs || 1200;
  // Track physical transcript revisions rather than raw session IDs. Modern
  // metadata and legacy process records can name one transcript differently.
  const seen = new Map();
  // Keep one stable raw ID if modern metadata appears after a legacy record.
  // This lets a title/metadata update refresh the existing state row instead
  // of creating a second row under the modern ID.
  const stableSessionIds = new Map();
  const auditOffsets = new Map();
  const activePermissionRequests = new Map();
  let timer = null;

  function processPermissionAudit(file, meta, stableSessionId) {
    if (!file || !fs.existsSync(file)) return;
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    let cursor = auditOffsets.get(file);
    let start = cursor ? cursor.offset : Math.max(0, stat.size - AUDIT_INITIAL_READ_LIMIT);
    let remainder = cursor ? cursor.remainder : "";
    if (start > stat.size) {
      start = 0;
      remainder = "";
    }
    const length = Math.min(Math.max(0, stat.size - start), AUDIT_POLL_READ_LIMIT);
    let chunk = Buffer.alloc(0);
    if (length > 0) {
      let fd;
      try {
        fd = fs.openSync(file, "r");
        chunk = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, chunk, 0, length, start);
        chunk = chunk.subarray(0, bytesRead);
      } catch {
        return;
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch {}
        }
      }
    }
    let text = chunk.toString("utf8");
    if (!cursor && start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
    }
    const lines = `${remainder}${text}`.split("\n");
    remainder = lines.pop() || "";
    auditOffsets.set(file, { offset: start + chunk.length, remainder });

    for (const line of lines) {
      const record = readJsonLine(line);
      if (!record || typeof record !== "object") continue;
      const subtype = typeof record.subtype === "string" ? record.subtype : "";
      const auditSessionId = record.session_id;
      if (auditSessionId && ![meta.cliSessionId, meta.sessionId].includes(auditSessionId)) continue;
      const requestId = typeof record.uuid === "string" ? record.uuid : "";
      if (!requestId || requestId.length > 128) continue;
      const requestKey = `${stableSessionId}:${requestId}`;
      if (subtype === "permission_request") {
        const timestamp = Date.parse(record.timestamp || "");
        if (Number.isFinite(timestamp) && Date.now() - timestamp > AUDIT_REMINDER_MAX_AGE_MS) continue;
        const toolName = typeof record.tool_name === "string" ? record.tool_name : "Tool";
        activePermissionRequests.set(requestKey, { sessionId: stableSessionId, requestId });
        if (typeof options.onPermissionRequest === "function") {
          try { options.onPermissionRequest({ sessionId: stableSessionId, requestId, toolName }); } catch {}
        }
        continue;
      }
      if (/^permission_(?:response|denied|auto_approved|granted|rejected|cancelled)$/.test(subtype)) {
        const active = activePermissionRequests.get(requestKey);
        activePermissionRequests.delete(requestKey);
        if (active && typeof options.onPermissionResolved === "function") {
          try { options.onPermissionResolved(active); } catch {}
        }
      }
    }
  }

  function poll() {
    for (const { meta, transcript, auditFile } of discoverSessions(root)) {
      let stat;
      try {
        stat = fs.statSync(transcript);
      } catch {
        continue;
      }
      const transcriptKey = canonicalTranscriptKey(transcript);
      const stableSessionId = stableSessionIds.get(transcriptKey) || meta.sessionId;
      stableSessionIds.set(transcriptKey, stableSessionId);
      processPermissionAudit(auditFile, meta, stableSessionId);
      const metadataRevision = JSON.stringify([
        meta.sessionId || "",
        meta.cliSessionId || "",
        meta.title || "",
        meta.cwd || "",
        meta.pid || null,
      ]);
      const revision = `${stat.mtimeMs}:${stat.size}:${metadataRevision}`;
      if (seen.get(transcriptKey) === revision) continue;
      seen.set(transcriptKey, revision);

      const event = latestTranscriptEvent(transcript);
      if (!event) continue;
      const body = {
        session_id: stableSessionId,
        state: event.state,
        event: event.event,
        // This is deliberately a registered Clawd agent identity. The
        // session cwd remains the reliable Claude Desktop discriminator.
        agent_id: "claude-code",
        hook_source: "claude-desktop-cowork",
        claude_desktop: true,
        cwd: meta.cwd || "",
        source_pid: meta.pid || null,
        agent_pid: meta.pid || null,
        claude_pid: meta.pid || null,
      };
      // Claude Desktop stores the user-facing Cowork name on the session
      // metadata, while cwd ends in the internal "outputs" directory.
      // Forward the official title so the HUD never falls back to "outputs".
      if (typeof meta.title === "string" && meta.title.trim()) {
        body.session_title = meta.title.trim();
      }
      if (event.toolName) body.tool_name = event.toolName;
      postState(body);
    }
  }

  return {
    start() {
      if (timer || process.platform !== "darwin") return;
      poll();
      timer = setInterval(poll, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    poll,
  };
}

module.exports = {
  createClaudeDesktopCoworkBridge,
  discoverSessions,
  isToolResultMessage,
  latestTranscriptEvent,
};
