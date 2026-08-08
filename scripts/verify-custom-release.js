"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "release-manifest.json"), "utf8")
);

const requiredFiles = [
  "src/deepseek-balance.js",
  "src/deepseek-export.js",
  "src/deepseek-usage.js",
  "src/codex-official-quota.js",
  "src/quota-ring-renderer.js",
  "src/session-hud.html",
  "src/dashboard.html",
  "assets/icons/agents/claude-code.png",
  "assets/icons/agents/codex.png",
  "assets/icons/deepseek.svg",
];

const forbiddenPath = /(?:^|\/)(?:node_modules|app\.asar(?:\.unpacked)?|.*backup.*|.*staging.*)(?:\/|$)/i;
// Build the detector at runtime so this verifier does not match its own
// prefix literals while scanning the release files.
const secretPrefixes = ["ghp_", "github_pat_", "sk-", "AIza"];
const secretText = new RegExp(
  `(?:${secretPrefixes.join("|")})[A-Za-z0-9_-]{20,}`,
);
const failures = [];
const customFiles = new Set([
  ...requiredFiles,
  "package.json",
  "release-manifest.json",
  "docs/releases/release-custom-v0.14.0.md",
  "docs/project/custom-release-workflow.md",
  "scripts/verify-custom-release.js",
]);

if (pkg.version !== manifest.version) {
  failures.push(`package version ${pkg.version} does not match manifest ${manifest.version}`);
}

for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(root, relative))) failures.push(`missing ${relative}`);
}

let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
} catch (error) {
  failures.push(`git ls-files failed: ${error.message}`);
}

for (const relative of tracked) {
  if (forbiddenPath.test(relative)) failures.push(`forbidden tracked path ${relative}`);
  const filePath = path.join(root, relative);
  if (!customFiles.has(relative)) continue;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size > 2 * 1024 * 1024) continue;
  const text = fs.readFileSync(filePath, "utf8");
  if (secretText.test(text)) failures.push(`possible credential in ${relative}`);
}

if (failures.length) {
  console.error("Custom release verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Custom release contract OK: ${manifest.channel} v${manifest.version}`);
}
