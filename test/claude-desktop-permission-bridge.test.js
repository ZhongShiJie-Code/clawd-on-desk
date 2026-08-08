"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createClaudeDesktopPermissionBridge,
  readNewAuditLines,
} = require("../src/claude-desktop-permission-bridge");
const { detectAvailableActions } = require("../src/claude-desktop-permission-ax");

function makeCoworkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-desktop-perm-"));
  const org = path.join(root, "account", "00000000");
  const localId = "local_permission";
  const cliId = "cli-permission";
  const localDir = path.join(org, localId);
  const project = path.join(localDir, ".claude", "projects", "demo");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(org, `${localId}.json`), JSON.stringify({
    sessionId: localId,
    cliSessionId: cliId,
    title: "Approve a Desktop tool",
    cwd: "/tmp/demo",
  }));
  fs.writeFileSync(path.join(project, `${cliId}.jsonl`), JSON.stringify({
    message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] },
  }) + "\n");
  return {
    root,
    audit: path.join(localDir, "audit.jsonl"),
    localId,
    cliId,
  };
}

describe("Claude Desktop permission bridge", () => {
  it("only exposes native actions that are actually present", () => {
    assert.deepStrictEqual(
      detectAvailableActions(["Allow Once", "Always Allow", "Deny"]),
      ["deny", "once", "always"],
    );
    assert.deepStrictEqual(
      detectAvailableActions(["Allow", "Deny"]),
      ["deny", "once"],
    );
    assert.deepStrictEqual(detectAvailableActions(["Cancel", "Close"]), ["deny"]);
  });

  it("tails appended JSONL without replaying a request", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-audit-tail-")), "audit.jsonl");
    try {
      fs.writeFileSync(file, JSON.stringify({ type: "permission_request", uuid: "one" }) + "\n");
      const state = { offset: 0, carry: "", initialized: false };
      assert.deepStrictEqual(readNewAuditLines(file, state), [{ type: "permission_request", uuid: "one" }]);
      assert.deepStrictEqual(readNewAuditLines(file, state), []);
      fs.appendFileSync(file, JSON.stringify({ type: "permission_response", uuid: "one" }) + "\n");
      assert.deepStrictEqual(readNewAuditLines(file, state), [{ type: "permission_response", uuid: "one" }]);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("mirrors a request, then clears it when Claude's native response is logged", async () => {
    const tree = makeCoworkTree();
    try {
      const pending = [];
      const resolved = [];
      const shown = [];
      const permission = {
        pendingPermissions: pending,
        addPendingPermission(entry) { pending.push(entry); },
        showPermissionBubble(entry) { shown.push(entry); },
        resolvePermissionEntry(entry, behavior, message) {
          resolved.push({ entry, behavior, message });
          const index = pending.indexOf(entry);
          if (index !== -1) pending.splice(index, 1);
        },
      };
      const bridge = createClaudeDesktopPermissionBridge({
        root: tree.root,
        permission,
        intervalMs: 700,
        ax: {
          inspect: async () => ({ ok: true, actions: ["deny", "once", "always"] }),
          press: async () => ({ ok: true }),
        },
      });
      fs.writeFileSync(tree.audit, JSON.stringify({
        _audit_timestamp: new Date().toISOString(),
        type: "permission_request",
        uuid: "request-1",
        session_id: tree.cliId,
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
      }) + "\n");
      bridge.poll();
      bridge.poll();
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(shown.length, 1);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].isClaudeDesktop, true);
      assert.deepStrictEqual(pending[0].claudeDesktopActions, ["deny", "once", "open", "always"]);

      fs.appendFileSync(tree.audit, JSON.stringify({
        _audit_timestamp: new Date().toISOString(),
        type: "permission_response",
        uuid: "request-1",
        session_id: tree.cliId,
        tool_name: "Bash",
        decision: "allow",
        granted: true,
      }) + "\n");
      bridge.poll();
      assert.strictEqual(pending.length, 0);
      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(resolved[0].behavior, "no-decision");
      assert.strictEqual(bridge.pendingByKey.size, 0);
    } finally {
      fs.rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it("supports reminder-only mode without invoking native authorization", async () => {
    const tree = makeCoworkTree();
    let bridge;
    let axInspectCalls = 0;
    let focused = 0;
    const pending = [];
    const permission = {
      pendingPermissions: pending,
      addPendingPermission(entry) { pending.push(entry); },
      showPermissionBubble() {},
      resolvePermissionEntry(entry) {
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
      },
    };
    try {
      bridge = createClaudeDesktopPermissionBridge({
        root: tree.root,
        permission,
        reminderOnly: true,
        focusClaude: () => { focused += 1; return true; },
        ax: {
          inspect: async () => {
            axInspectCalls += 1;
            return { ok: true, actions: ["deny", "once"] };
          },
          press: async () => ({ ok: true }),
        },
      });
      fs.writeFileSync(tree.audit, JSON.stringify({
        _audit_timestamp: new Date().toISOString(),
        type: "permission_request",
        uuid: "request-reminder-only",
        session_id: tree.cliId,
        tool_name: "Bash",
        tool_input: { command: "echo reminder" },
      }) + "\n");
      bridge.poll();
      assert.strictEqual(pending.length, 1);
      assert.deepStrictEqual(pending[0].claudeDesktopActions, ["open"]);
      assert.strictEqual(pending[0].claudeDesktopTransport, "reminder-only");
      assert.strictEqual(axInspectCalls, 0);

      assert.strictEqual(await bridge.handleDecision(pending[0], "allow"), false);
      assert.strictEqual(await bridge.handleDecision(pending[0], "claude-desktop:open"), true);
      assert.strictEqual(focused, 1);
      assert.strictEqual(pending.length, 1);
    } finally {
      bridge?.stop();
      fs.rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it("uses the direct protocol and waits for the matching audit response", async () => {
    const tree = makeCoworkTree();
    let bridge;
    let axInspectCalls = 0;
    const pending = [];
    const resolved = [];
    const permission = {
      pendingPermissions: pending,
      addPendingPermission(entry) { pending.push(entry); },
      showPermissionBubble() {},
      resolvePermissionEntry(entry, behavior, message) {
        resolved.push({ entry, behavior, message });
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
      },
    };
    const direct = {
      isConfigured: () => true,
      supportsDecision: (decision) => decision === "once" || decision === "deny",
      async respond(requestId, decision) {
        assert.strictEqual(requestId, "request-direct");
        assert.strictEqual(decision, "once");
        fs.appendFileSync(tree.audit, JSON.stringify({
          _audit_timestamp: new Date().toISOString(),
          type: "permission_response",
          uuid: requestId,
          session_id: tree.cliId,
          decision: "once",
          granted: true,
        }) + "\n");
        bridge.poll();
        return { ok: true, requestId, decision };
      },
      close() {},
    };
    try {
      bridge = createClaudeDesktopPermissionBridge({
        root: tree.root,
        permission,
        direct,
        directMode: true,
        ax: {
          inspect: async () => {
            axInspectCalls += 1;
            return { ok: true, actions: ["deny", "once", "always"] };
          },
          press: async () => ({ ok: true }),
        },
      });
      fs.writeFileSync(tree.audit, JSON.stringify({
        _audit_timestamp: new Date().toISOString(),
        type: "permission_request",
        uuid: "request-direct",
        session_id: tree.cliId,
        tool_name: "Bash",
        tool_input: { command: "echo direct" },
      }) + "\n");
      bridge.poll();
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].claudeDesktopTransport, "direct");
      assert.deepStrictEqual(pending[0].claudeDesktopActions, ["deny", "once", "open"]);
      assert.strictEqual(axInspectCalls, 0);

      const result = await bridge.handleDecision(pending[0], "allow");
      assert.strictEqual(result, true);
      assert.strictEqual(pending.length, 0);
      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(resolved[0].behavior, "no-decision");
    } finally {
      bridge?.stop();
      fs.rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it("uses Accessibility and only reports success after Claude confirms the decision", async () => {
    const tree = makeCoworkTree();
    let bridge;
    const pending = [];
    const resolved = [];
    const permission = {
      pendingPermissions: pending,
      addPendingPermission(entry) { pending.push(entry); },
      showPermissionBubble() {},
      resolvePermissionEntry(entry, behavior, message) {
        resolved.push({ entry, behavior, message });
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
      },
    };
    try {
      bridge = createClaudeDesktopPermissionBridge({
        root: tree.root,
        permission,
        confirmTimeoutMs: 500,
        ax: {
          inspect: async () => ({ ok: true, actions: ["deny", "once"] }),
          async press(decision) {
            assert.strictEqual(decision, "once");
            fs.appendFileSync(tree.audit, JSON.stringify({
              _audit_timestamp: new Date().toISOString(),
              type: "permission_response",
              uuid: "request-ax",
              session_id: tree.cliId,
              decision: "allow",
              granted: true,
            }) + "\n");
            bridge.poll();
            return { ok: true, button: "Allow" };
          },
        },
      });
      fs.writeFileSync(tree.audit, JSON.stringify({
        _audit_timestamp: new Date().toISOString(),
        type: "permission_request",
        uuid: "request-ax",
        session_id: tree.cliId,
        tool_name: "Bash",
        tool_input: { command: "echo ax" },
      }) + "\n");
      bridge.poll();
      assert.strictEqual(pending.length, 1);

      const result = await bridge.handleDecision(pending[0], "allow");
      assert.strictEqual(result, true);
      assert.strictEqual(pending.length, 0);
      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(resolved[0].entry._claudeDesktopNativeMatched, true);
    } finally {
      bridge?.stop();
      fs.rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it("keeps the HUD request pending when Accessibility has no audit confirmation", async () => {
    const tree = makeCoworkTree();
    const pending = [];
    const focused = [];
    const permission = {
      pendingPermissions: pending,
      addPendingPermission(entry) { pending.push(entry); },
      showPermissionBubble() {},
      resolvePermissionEntry(entry) {
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
      },
    };
    const bridge = createClaudeDesktopPermissionBridge({
      root: tree.root,
      permission,
      confirmTimeoutMs: 120,
      focusClaude(sessionId) { focused.push(sessionId); },
      ax: {
        inspect: async () => ({ ok: true, actions: ["deny", "once"] }),
        press: async () => ({ ok: true, button: "Allow" }),
      },
    });
    try {
      fs.writeFileSync(tree.audit, JSON.stringify({
        _audit_timestamp: new Date().toISOString(),
        type: "permission_request",
        uuid: "request-timeout",
        session_id: tree.cliId,
        tool_name: "Bash",
        tool_input: { command: "echo timeout" },
      }) + "\n");
      bridge.poll();
      const entry = pending[0];
      const result = await bridge.handleDecision(entry, "allow");
      assert.strictEqual(result, false);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(entry._claudeDesktopResolving, false);
      assert.deepStrictEqual(focused, [tree.localId]);
    } finally {
      bridge.stop();
      fs.rmSync(tree.root, { recursive: true, force: true });
    }
  });
});
