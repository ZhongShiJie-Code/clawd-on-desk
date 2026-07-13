// Claude Desktop Code/Cowork runs Claude Code in stream-json mode.
module.exports = {
  id: "claude-desktop",
  name: "Claude Desktop",
  processNames: { win: ["Claude.exe"], mac: ["Claude"], linux: [] },
  eventSource: "hook",
  eventMap: require("./claude-code").eventMap,
  capabilities: { httpHook: true, permissionApproval: false, notificationHook: true, sessionEnd: true, subagent: true, desktopFocus: true },
  pidField: "claude_pid",
};
