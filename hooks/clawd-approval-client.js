"use strict";

const crypto = require("node:crypto");
const { postPermissionToRunningServer } = require("./server-config");

function decisionFrom(body) {
  try {
    const parsed = JSON.parse(body || "{}");
    return parsed?.hookSpecificOutput?.permissionDecision?.behavior === "allow";
  } catch { return false; }
}

// Use from a self-built MCP/local automation immediately before its
// side-effect. The caller must fail closed when `allowed` is false.
function requestClawdApproval(options = {}) {
  return new Promise((resolve) => {
    const sessionId = typeof options.sessionId === "string" && options.sessionId
      ? options.sessionId : `local-automation:${crypto.randomUUID()}`;
    const payload = {
      session_id: sessionId,
      agent_id: "claude-desktop-mcp",
      tool_name: typeof options.toolName === "string" && options.toolName ? options.toolName.slice(0, 120) : "Local automation",
      tool_input: { summary: typeof options.summary === "string" ? options.summary.slice(0, 1000) : "Approval requested" },
      cwd: typeof options.cwd === "string" ? options.cwd.slice(0, 1024) : "",
    };
    postPermissionToRunningServer(payload, { timeoutMs: 590000 }, (ok, _port, body) => {
      resolve({ allowed: ok && decisionFrom(body), sessionId });
    });
  });
}

module.exports = { requestClawdApproval };
