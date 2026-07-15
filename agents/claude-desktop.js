// Claude Desktop Code/Cowork runs Claude Code in stream-json mode.
module.exports = {
  id: "claude-desktop",
  name: "Claude Desktop",
  // Cowork's embedded CLI has the same process name as ordinary Claude Code.
  // Its identity must therefore come from the read-only bridge, not PID
  // autodetection; this entry is solely for focusing the Desktop app.
  processNames: { win: ["Claude.exe"], mac: ["Claude"], linux: [] },
  eventSource: "hook",
  eventMap: require("./claude-code").eventMap,
  capabilities: { httpHook: true, permissionApproval: false, notificationHook: true, sessionEnd: true, subagent: true, desktopFocus: true },
  pidField: "claude_pid",
};
