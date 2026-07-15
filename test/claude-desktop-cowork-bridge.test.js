"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  discoverSessions,
  latestTranscriptEvent,
} = require("../src/claude-desktop-cowork-bridge");

describe("Claude Desktop Cowork bridge", () => {
  it("discovers the current Cowork metadata and cli transcript layout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cowork-"));
    try {
      const org = path.join(root, "account", "00000000");
      const localId = "local_example";
      const cliId = "cli-example";
      const project = path.join(org, localId, ".claude", "projects", "demo");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(org, `${localId}.json`), JSON.stringify({
        sessionId: localId,
        cliSessionId: cliId,
        cwd: "/tmp/demo",
      }));
      fs.writeFileSync(path.join(project, `${cliId}.jsonl`), JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }));

      const sessions = discoverSessions(root);
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].meta.sessionId, localId);
      assert.strictEqual(path.basename(sessions[0].transcript), `${cliId}.jsonl`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mistake a tool result for a new user prompt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cowork-transcript-"));
    const transcript = path.join(root, "session.jsonl");
    try {
      fs.writeFileSync(transcript, [
        JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "go" }] } }),
        JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }),
        JSON.stringify({ message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
      ].join("\n"));
      assert.deepStrictEqual(latestTranscriptEvent(transcript), {
        state: "working", event: "PreToolUse", toolName: "Bash",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
