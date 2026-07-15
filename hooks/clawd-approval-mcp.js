#!/usr/bin/env node
// Opt-in MCP permission gate. It never wraps Claude Desktop native tools.
const { requestClawdApproval } = require("./clawd-approval-client");

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, message) { send({ jsonrpc: "2.0", id, error: { code: -32000, message } }); }
function requestApproval(args = {}) {
  return requestClawdApproval({
    sessionId: args.session_id,
    toolName: args.tool_name || "MCP automation",
    summary: args.summary || "Approval requested by MCP tool",
    cwd: args.cwd,
  }).then(({ allowed, sessionId }) => ({ allowed, session_id: sessionId }));
}
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    if (req.method === "initialize") reply(req.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "clawd-approval", version: "0.1.0" } });
    else if (req.method === "tools/list") reply(req.id, { tools: [{ name: "clawd_request_approval", description: "Request explicit Clawd approval before a local automation action.", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, summary: { type: "string" }, cwd: { type: "string" }, session_id: { type: "string" } }, required: ["tool_name", "summary"] } }] });
    else if (req.method === "tools/call" && req.params?.name === "clawd_request_approval") requestApproval(req.params.arguments).then((out) => reply(req.id, { content: [{ type: "text", text: JSON.stringify(out) }], isError: !out.allowed }));
    else if (req.id !== undefined) fail(req.id, "Unsupported request");
  }
});
