"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { WebSocketServer } = require("ws");

const {
  buildDecisionExpression,
  chooseTarget,
  createClaudeDesktopPermissionDirect,
  isLocalUrl,
} = require("../src/claude-desktop-permission-direct");

describe("Claude Desktop direct permission protocol", () => {
  it("only accepts loopback CDP endpoints", () => {
    assert.strictEqual(isLocalUrl("http://127.0.0.1:9229/json/list"), true);
    assert.strictEqual(isLocalUrl("ws://localhost:9229/devtools/page/1"), true);
    assert.strictEqual(isLocalUrl("http://192.168.1.10:9229/json/list"), false);
    assert.strictEqual(isLocalUrl("https://example.com/json/list"), false);
  });

  it("selects a Claude page and ignores unrelated targets", () => {
    const target = chooseTarget([
      { type: "page", title: "Other", url: "https://example.com", webSocketDebuggerUrl: "ws://127.0.0.1:1/other" },
      { type: "page", title: "Claude", url: "app://localhost", webSocketDebuggerUrl: "ws://127.0.0.1:2/claude" },
      { type: "service_worker", title: "Claude worker", url: "app://localhost", webSocketDebuggerUrl: "ws://127.0.0.1:3/worker" },
    ]);
    assert.strictEqual(target.title, "Claude");
  });

  it("builds a request-id-bound renderer call without UI actions", () => {
    const expression = buildDecisionExpression("req-1", "once", undefined);
    assert.match(expression, /LocalAgentModeSessions/);
    assert.match(expression, /respondToToolPermission/);
    assert.match(expression, /"req-1"/);
    assert.match(expression, /"once"/);
    assert.doesNotMatch(expression, /click|osascript|Accessibility/i);
  });

  it("fails closed when no direct endpoint is configured", async () => {
    const direct = createClaudeDesktopPermissionDirect({ env: {} });
    assert.strictEqual(direct.isConfigured(), false);
    const result = await direct.respond("req-1", "once");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "Claude direct protocol is not configured");
    direct.close();
  });

  it("discovers a loopback target and sends a request-id-bound CDP evaluation", async () => {
    const server = http.createServer((request, response) => {
      if (request.url !== "/json/list") {
        response.writeHead(404);
        response.end();
        return;
      }
      const port = server.address().port;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([
        {
          type: "page",
          title: "Claude",
          url: "app://localhost",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/claude`,
        },
      ]));
    });
    const wss = new WebSocketServer({ server, path: "/devtools/page/claude" });
    let expression = "";
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        expression = message.params.expression;
        socket.send(JSON.stringify({
          id: message.id,
          result: { result: { type: "object", value: { ok: true } } },
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const direct = createClaudeDesktopPermissionDirect({
      port: server.address().port,
      timeoutMs: 1000,
    });
    const result = await direct.respond("req-cdp-1", "deny");
    assert.strictEqual(result.ok, true);
    assert.match(expression, /respondToToolPermission/);
    assert.match(expression, /req-cdp-1/);
    assert.match(expression, /deny/);
    direct.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
});
