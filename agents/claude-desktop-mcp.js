module.exports = {
  id: "claude-desktop-mcp",
  name: "Claude Desktop MCP",
  processNames: { win: [], mac: [], linux: [] },
  eventSource: "mcp",
  eventMap: {},
  capabilities: { httpHook: false, permissionApproval: true, notificationHook: false, sessionEnd: false, subagent: false },
  pidField: "claude_pid",
};
