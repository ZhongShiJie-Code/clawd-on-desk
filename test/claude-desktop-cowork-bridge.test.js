"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createClaudeDesktopCoworkBridge,
  discoverSessions,
  latestTranscriptEvent,
  latestAuditContextWindow,
  latestTranscriptContextUsage,
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
        title: "Build dashboard",
        model: "claude-opus-4-7",
        userSelectedFolders: ["/tmp/project"],
      }));
      fs.writeFileSync(path.join(project, `${cliId}.jsonl`), JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 48000, cache_read_input_tokens: 2000 },
        },
      }));
      const legacySessions = path.join(org, localId, ".claude", "sessions");
      fs.mkdirSync(legacySessions, { recursive: true });
      fs.writeFileSync(path.join(legacySessions, "1.json"), JSON.stringify({ sessionId: cliId }));

      const sessions = discoverSessions(root);
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].meta.sessionId, localId);
      assert.strictEqual(path.basename(sessions[0].transcript), `${cliId}.jsonl`);
      assert.strictEqual(path.basename(sessions[0].audit), "audit.jsonl");
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

  it("retries a transcript revision when Clawd is not ready at startup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cowork-retry-"));
    try {
      const org = path.join(root, "account", "00000000");
      const localId = "local_retry";
      const cliId = "cli-retry";
      const project = path.join(org, localId, ".claude", "projects", "demo");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(org, `${localId}.json`), JSON.stringify({ sessionId: localId, cliSessionId: cliId }));
      fs.writeFileSync(path.join(project, `${cliId}.jsonl`), JSON.stringify({
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      }));
      const outcomes = [false, true];
      let posts = 0;
      const bridge = createClaudeDesktopCoworkBridge({
        root,
        postState: () => { posts += 1; return outcomes.shift(); },
      });

      bridge.poll();
      bridge.poll();
      bridge.poll();
      assert.strictEqual(posts, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("posts the Cowork title, selected model, selected folder, and audit context", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cowork-fields-"));
    try {
      const org = path.join(root, "account", "00000000");
      const localId = "local_fields";
      const cliId = "cli-fields";
      const localSession = path.join(org, localId);
      const project = path.join(localSession, ".claude", "projects", "demo");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(org, `${localId}.json`), JSON.stringify({
        sessionId: localId,
        cliSessionId: cliId,
        cwd: "/internal/outputs",
        title: "Fix Claude mapping",
        model: "claude-opus-4-7",
        userSelectedFolders: ["/Users/tom/workspace/clawd-on-desk"],
      }));
      fs.writeFileSync(path.join(project, `${cliId}.jsonl`), JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 48000, cache_read_input_tokens: 2000 },
        },
      }));
      fs.writeFileSync(path.join(localSession, "audit.jsonl"), JSON.stringify({
        modelUsage: {
          "claude-opus-4-7": { inputTokens: 48000, cacheReadInputTokens: 2000, contextWindow: 200000 },
        },
      }));
      const posted = [];
      createClaudeDesktopCoworkBridge({ root, postState: (body) => { posted.push(body); return true; } }).poll();
      assert.deepStrictEqual(posted[0].context_usage, { used: 50000, limit: 200000, percent: 25 });
      assert.strictEqual(posted[0].session_title, "Fix Claude mapping");
      assert.strictEqual(posted[0].model, "claude-opus-4-7");
      assert.strictEqual(posted[0].cwd, "/Users/tom/workspace/clawd-on-desk");
      assert.strictEqual(latestAuditContextWindow(path.join(localSession, "audit.jsonl"), "claude-opus-4-7"), 200000);
      assert.deepStrictEqual(
        latestTranscriptContextUsage(path.join(project, `${cliId}.jsonl`), 200000),
        posted[0].context_usage
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not replay an archived Cowork session as live work", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cowork-archived-"));
    try {
      const org = path.join(root, "account", "00000000");
      const localId = "local_archived";
      const cliId = "cli-archived";
      const project = path.join(org, localId, ".claude", "projects", "demo");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(org, `${localId}.json`), JSON.stringify({
        sessionId: localId, cliSessionId: cliId, isArchived: true,
      }));
      fs.writeFileSync(path.join(project, `${cliId}.jsonl`), JSON.stringify({
        message: { role: "user", content: [{ type: "text", text: "old prompt" }] },
      }));
      let posts = 0;
      createClaudeDesktopCoworkBridge({ root, postState: () => { posts += 1; return true; } }).poll();
      assert.strictEqual(posts, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
