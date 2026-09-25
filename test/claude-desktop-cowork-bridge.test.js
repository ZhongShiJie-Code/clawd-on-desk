"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { it } = require("node:test");

const { createClaudeDesktopCoworkBridge, discoverSessions } = require("../src/claude-desktop-cowork-bridge");

it("maps Cowork metadata and surfaces only unresolved permission reminders", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cowork-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const organization = path.join(root, "account", "organization");
  const sessionRoot = path.join(organization, "a1b2c3d4");
  const project = path.join(sessionRoot, ".claude", "projects", "-Users-test-project");
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, "cli-session.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
  })}\n`);
  fs.writeFileSync(path.join(organization, "local_session.json"), JSON.stringify({
    sessionId: "local_session",
    cliSessionId: "cli-session",
    cwd: path.join(sessionRoot, "outputs"),
    title: "Cowork title",
  }));
  const auditFile = path.join(sessionRoot, "audit.jsonl");
  fs.writeFileSync(auditFile, `${JSON.stringify({
    type: "system",
    subtype: "permission_request",
    uuid: "request-1",
    session_id: "cli-session",
    timestamp: new Date().toISOString(),
    tool_name: "Bash",
    tool_input: { command: "must-not-leak" },
  })}\n`);

  const requested = [];
  const resolved = [];
  const states = [];
  const bridge = createClaudeDesktopCoworkBridge({
    root,
    postState: (body) => states.push(body),
    onPermissionRequest: (item) => requested.push(item),
    onPermissionResolved: (item) => resolved.push(item),
  });

  const sessions = discoverSessions(root);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].meta.title, "Cowork title");
  assert.strictEqual(sessions[0].auditFile, auditFile);

  bridge.poll();
  bridge.poll();
  assert.deepStrictEqual(requested, [{
    sessionId: "local_session",
    requestId: "request-1",
    toolName: "Bash",
  }]);
  assert.strictEqual(states[0].session_title, "Cowork title");

  fs.appendFileSync(auditFile, `${JSON.stringify({
    type: "system",
    subtype: "permission_response",
    uuid: "request-1",
    session_id: "cli-session",
    timestamp: new Date().toISOString(),
  })}\n`);
  bridge.poll();
  assert.deepStrictEqual(resolved, [{ sessionId: "local_session", requestId: "request-1" }]);
});
