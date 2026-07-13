module.exports = {
  id: "claude-desktop-mcp",
  name: "Claude Desktop MCP",
  processNames: { win: [], mac: [], linux: [] },
  eventSource: "mcp",
  // The MCP server only creates approval requests; it does not observe the
  // Desktop session lifecycle (that remains the responsibility of hooks).
  eventMap: { PermissionRequest: "permission" },
  capabilities: { httpHook: false, permissionApproval: true, notificationHook: false, sessionEnd: false, subagent: false },
  pidField: "claude_pid",
};
