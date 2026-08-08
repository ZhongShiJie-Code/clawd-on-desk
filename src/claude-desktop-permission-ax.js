"use strict";

const { execFile } = require("child_process");

const AX_TIMEOUT_MS = 5000;

// Claude Desktop owns the real permission decision. This helper only presses
// an already-rendered native button through macOS Accessibility; it never
// edits Claude.app or writes to Claude's session/config files.
const APPLESCRIPT = String.raw`
on hasText(value, candidates)
  repeat with candidate in candidates
    ignoring case
      if value contains (contents of candidate) then return true
    end ignoring
  end repeat
  return false
end hasText

on buttonMatches(buttonName, decisionKind, allowGeneric)
  set value to ""
  try
    set value to buttonName as text
  end try
  if decisionKind is "deny" then
    return my hasText(value, {"Deny", "拒绝", "拒絕", "拒否"})
  end if
  if decisionKind is "always" then
    return my hasText(value, {"Always Allow", "Always allow", "始终允许", "始終允許", "總是允許", "总是允许", "永远允许", "永遠允許"})
  end if
  if decisionKind is "once" then
    if my hasText(value, {"Allow Once", "Allow once", "允许一次", "允許一次", "一次允许", "一次許可"}) then return true
    if allowGeneric then return my hasText(value, {"Allow", "允许", "允許", "許可", "Permit"})
  end if
  return false
end buttonMatches

on axChildren(container)
  tell application "System Events" to return UI elements of container
end axChildren

on axRole(elementRef)
  tell application "System Events" to return role of elementRef
end axRole

on axName(elementRef)
  tell application "System Events" to return name of elementRef
end axName

on axClick(elementRef)
  tell application "System Events"
    try
      perform action "AXPress" of elementRef
    on error
      click elementRef
    end try
  end tell
end axClick

on getArgument(values, index)
  return item index of values
end getArgument

on collectButtonNames(container, names)
  local children
  try
    set children to my axChildren(container)
  on error
    return names
  end try
  repeat with childRef in children
    set child to contents of childRef
    try
      set roleName to (my axRole(child)) as text
      ignoring case
        set isButton to roleName contains "button"
      end ignoring
      if isButton then
        try
          set buttonName to (my axName(child)) as text
          if buttonName is not "" then set end of names to buttonName
        end try
      end if
    end try
    set names to my collectButtonNames(child, names)
  end repeat
  return names
end collectButtonNames

on pressButton(container, decisionKind, allowGeneric)
  local children
  try
    set children to my axChildren(container)
  on error
    return ""
  end try
  repeat with childRef in children
    set child to contents of childRef
    try
      set roleName to (my axRole(child)) as text
      ignoring case
        set isButton to roleName contains "button"
      end ignoring
      if isButton then
        set buttonName to ""
        try
          set buttonName to (my axName(child)) as text
        end try
        if my buttonMatches(buttonName, decisionKind, allowGeneric) then
          try
            my axClick(child)
            return buttonName
          end try
        end if
      end if
    end try
    set clickedName to my pressButton(child, decisionKind, allowGeneric)
    if clickedName is not "" then return clickedName
  end repeat
  return ""
end pressButton

on hasMatchingButton(container, decisionKind, allowGeneric)
  local children
  try
    set children to my axChildren(container)
  on error
    return false
  end try
  repeat with childRef in children
    set child to contents of childRef
    try
      set roleName to (my axRole(child)) as text
      ignoring case
        set isButton to roleName contains "button"
      end ignoring
      if isButton then
        set buttonName to ""
        try
          set buttonName to (my axName(child)) as text
        end try
        if my buttonMatches(buttonName, decisionKind, allowGeneric) then return true
      end if
    end try
    if my hasMatchingButton(child, decisionKind, allowGeneric) then return true
  end repeat
  return false
end hasMatchingButton

on run argv
  set args to argv
  set argCount to count of args
  if argCount < 1 then return "error:missing-mode"
  set mode to my getArgument(args, 1)
  tell application "System Events"
    if not (exists application process "Claude") then return "error:claude-not-running"
    tell application process "Claude"
      set wasVisible to visible
      if not wasVisible then set visible to true
      set restoredWindows to {}
      repeat with windowRef in windows
        try
          if value of attribute "AXMinimized" of windowRef is true then
            set value of attribute "AXMinimized" of windowRef to false
            set end of restoredWindows to contents of windowRef
          end if
        end try
      end repeat
      delay 0.12
      if mode is "inspect" then
        set names to {}
        repeat with windowRef in windows
          set names to my collectButtonNames(contents of windowRef, names)
        end repeat
        repeat with windowRef in restoredWindows
          try
            set value of attribute "AXMinimized" of windowRef to true
          end try
        end repeat
        if not wasVisible then set visible to false
        set AppleScript's text item delimiters to ", "
        set output to names as text
        set AppleScript's text item delimiters to ""
        return output
      end if
      if argCount < 2 then return "error:missing-action"
      set decisionKind to my getArgument(args, 2)
      repeat with windowRef in windows
        set clickedName to my pressButton(contents of windowRef, decisionKind, false)
        if clickedName is not "" then
          repeat with restoredWindow in restoredWindows
            try
              set value of attribute "AXMinimized" of restoredWindow to true
            end try
          end repeat
          if not wasVisible then set visible to false
          return "clicked:" & clickedName
        end if
      end repeat
      -- Generic Allow is only a fallback for the once action. We do not use
      -- it for Always Allow, which prevents a broad approval by mistake.
      if decisionKind is "once" then
        repeat with windowRef in windows
          set candidateWindow to contents of windowRef
          -- Generic Allow is accepted only when the same window also has a
          -- Deny button. This prevents a settings dialog's unrelated Allow
          -- control from being mistaken for the permission card.
          if my hasMatchingButton(candidateWindow, "deny", false) then
            set clickedName to my pressButton(candidateWindow, decisionKind, true)
            if clickedName is not "" then
              repeat with restoredWindow in restoredWindows
                try
                  set value of attribute "AXMinimized" of restoredWindow to true
                end try
              end repeat
              if not wasVisible then set visible to false
              return "clicked:" & clickedName
            end if
          end if
        end repeat
      end if
      repeat with windowRef in restoredWindows
        try
          set value of attribute "AXMinimized" of windowRef to true
        end try
      end repeat
      if not wasVisible then set visible to false
      return "not-found"
    end tell
  end tell
end run
`;

function runAppleScript(args) {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", APPLESCRIPT, "--", ...args.map((value) => String(value || ""))],
      { timeout: AX_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
          error,
        });
      },
    );
  });
}

function detectAvailableActions(buttonNames) {
  const names = Array.isArray(buttonNames) ? buttonNames : [];
  const has = (patterns) => names.some((name) => patterns.some((pattern) => pattern.test(String(name))));
  const actions = ["deny"];
  if (has([/allow\s*once/i, /允许一次/, /允許一次/, /一次允许/, /一次許可/])) actions.push("once");
  else if (has([/^\s*allow\s*$/i, /^\s*允许\s*$/, /^\s*允許\s*$/, /^\s*許可\s*$/])) actions.push("once");
  if (has([/always\s*allow/i, /始终允许/, /始終允許/, /總是允許/, /总是允许/, /永远允许/, /永遠允許/])) actions.push("always");
  return actions;
}

function createClaudeDesktopPermissionAx(options = {}) {
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  let queue = Promise.resolve();

  function serialized(task) {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  }

  async function inspect() {
    if (process.platform !== "darwin") return { ok: false, actions: [], reason: "not-macos" };
    const result = await serialized(() => runAppleScript(["inspect"]));
    if (!result.ok) {
      debugLog(`Claude Desktop AX inspect failed: ${result.stderr || result.error?.message || "unknown"}`);
      return { ok: false, actions: [], reason: result.stderr || "osascript-failed" };
    }
    const buttonNames = result.stdout ? result.stdout.split(", ").filter(Boolean) : [];
    return { ok: true, actions: detectAvailableActions(buttonNames), buttonNames };
  }

  async function press(decision) {
    if (process.platform !== "darwin") return { ok: false, reason: "not-macos" };
    if (!["deny", "once", "always"].includes(decision)) {
      return { ok: false, reason: "unsupported-decision" };
    }
    const result = await serialized(() => runAppleScript(["press", decision]));
    if (!result.ok) {
      debugLog(`Claude Desktop AX press failed decision=${decision}: ${result.stderr || result.error?.message || "unknown"}`);
      return { ok: false, reason: result.stderr || "osascript-failed" };
    }
    if (!result.stdout.startsWith("clicked:")) {
      return { ok: false, reason: result.stdout || "button-not-found" };
    }
    return { ok: true, button: result.stdout.slice("clicked:".length) };
  }

  return { inspect, press, detectAvailableActions };
}

module.exports = {
  createClaudeDesktopPermissionAx,
  detectAvailableActions,
  __test: { APPLESCRIPT },
};
