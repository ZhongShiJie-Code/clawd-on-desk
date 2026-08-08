"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;
const EXPORT_DIR_PREFIX = "usage_data_auto_";
const KNOWN_PLAYWRIGHT_ROOTS = [
  "/Users/tom/.npm/_npx/9833c18b2d85bc59/node_modules",
  "/Users/tom/.openclaw/tools/node-v22.22.0/node_modules",
  "/Users/tom/.openclaw/npm/node_modules/openclaw/node_modules",
];

function utcYearMonthParts(ms = Date.now()) {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
  };
}

function exportMonthLabel(ms = Date.now()) {
  const { year, month } = utcYearMonthParts(ms);
  return `${year} - ${month}月`;
}

function autoExportDir(downloadsDir, ms = Date.now()) {
  const { year, month } = utcYearMonthParts(ms);
  return path.join(downloadsDir, `${EXPORT_DIR_PREFIX}${year}_${month}`);
}

function defaultTempPath(prefix, pid = process.pid, tempDir = os.tmpdir()) {
  return path.join(tempDir, `${prefix}-${pid}`);
}

function isDirFresh(dirPath, now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  try {
    const stat = fs.statSync(dirPath);
    return stat.isDirectory() && (now - stat.mtimeMs) < staleAfterMs;
  } catch {
    return false;
  }
}

function resolvePlaywrightModulePath(extraRoots = []) {
  for (const root of [...extraRoots, ...KNOWN_PLAYWRIGHT_ROOTS]) {
    if (!root) continue;
    const pkgPath = path.join(root, "playwright", "package.json");
    if (fs.existsSync(pkgPath)) return path.join(root, "playwright");
  }
  throw new Error("playwright module not found");
}

function copyChromeProfile(sourceRoot, targetRoot, profileName = "Default") {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  const localState = path.join(sourceRoot, "Local State");
  if (!fs.existsSync(localState)) throw new Error("Chrome Local State not found");
  fs.copyFileSync(localState, path.join(targetRoot, "Local State"));
  if (!profileName || path.isAbsolute(profileName) || profileName.includes("..")) {
    throw new Error("Invalid Chrome profile name");
  }
  const sourceProfile = path.join(sourceRoot, profileName);
  if (!fs.existsSync(sourceProfile)) throw new Error(`Chrome profile not found: ${profileName}`);
  // Keep the source profile directory name. Chrome's macOS cookie protection
  // can reject a copied login when Profile 1 is renamed to Default.
  const targetProfile = path.join(targetRoot, profileName);
  fs.cpSync(sourceProfile, targetProfile, {
    recursive: true,
    force: true,
    filter: (src) => {
      const base = path.basename(src);
      return ![
        "Cache",
        "Code Cache",
        "GPUCache",
        "GrShaderCache",
        "GraphiteDawnCache",
        "DawnCache",
      ].includes(base);
    },
  });
}

function extractUsageZip(zipPath, destinationDir) {
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });
  execFileSync("/usr/bin/unzip", ["-oq", zipPath, "-d", destinationDir], { stdio: "ignore" });
  const entries = fs.readdirSync(destinationDir);
  const nestedDir = entries.find((name) => /^usage_data_/i.test(name) && fs.statSync(path.join(destinationDir, name)).isDirectory());
  return nestedDir ? path.join(destinationDir, nestedDir) : destinationDir;
}

// DeepSeek replaced the native month <select> with a custom control. The
// export action still defaults to a usable recent range, so month selection
// must be best-effort rather than a prerequisite for every scheduled export.
async function selectUsageMonthIfAvailable(page, monthLabel) {
  try {
    const monthSelect = page.locator("select.ds-native-select__select");
    if (await monthSelect.count() === 0) return false;
    await monthSelect.selectOption({ label: monthLabel });
    await page.waitForTimeout(1500);
    return true;
  } catch {
    return false;
  }
}

async function runExport(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const homeDir = options.homeDir || os.homedir();
  const downloadsDir = options.downloadsDir || path.join(homeDir, "Downloads");
  const chromeUserDataDir = options.chromeUserDataDir || path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
  const chromeProfileName = options.chromeProfileName || "Default";
  const playwrightPath = options.playwrightPath || resolvePlaywrightModulePath(options.playwrightRoots);
  const chromeExecutablePath = options.chromeExecutablePath || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  // Separate concurrent Clawd processes (for example, an app restart plus a
  // manual recovery export) so one cannot remove the other process's Chrome
  // profile while it is in use.
  const profileCloneDir = options.profileCloneDir || defaultTempPath("clawd-deepseek-export-profile");
  const downloadDir = options.downloadDir || defaultTempPath("clawd-deepseek-export-download");
  const extractDir = options.extractDir || defaultTempPath("clawd-deepseek-export-extract");
  const finalDir = options.finalDir || autoExportDir(downloadsDir, now);
  const zipPath = options.zipPath || path.join(downloadDir, "usage_data_latest.zip");
  const monthLabel = exportMonthLabel(now);

  fs.mkdirSync(downloadDir, { recursive: true });
  fs.rmSync(zipPath, { force: true });
  copyChromeProfile(chromeUserDataDir, profileCloneDir, chromeProfileName);

  const { chromium } = require(playwrightPath);
  const context = await chromium.launchPersistentContext(profileCloneDir, {
    channel: options.chromeChannel || "chrome",
    executablePath: fs.existsSync(chromeExecutablePath) ? chromeExecutablePath : undefined,
    headless: options.headless !== false,
    acceptDownloads: true,
    args: ["--disable-dev-shm-usage", `--profile-directory=${chromeProfileName}`],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://platform.deepseek.com/usage", {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs || 60000,
    });
    await page.waitForLoadState("networkidle", { timeout: options.timeoutMs || 60000 }).catch(() => {});
    await selectUsageMonthIfAvailable(page, monthLabel);
    const exportButton = page.getByText("导出", { exact: true }).first();
    await exportButton.waitFor({ timeout: 30000 });
    const downloadPromise = page.waitForEvent("download", { timeout: options.timeoutMs || 60000 });
    await exportButton.click();
    const download = await downloadPromise;
    await download.saveAs(zipPath);
    const extractedRoot = extractUsageZip(zipPath, extractDir);
    const stagingDir = `${finalDir}.staging`;
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.cpSync(extractedRoot, stagingDir, { recursive: true, force: true });
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, finalDir);
    return {
      status: "ok",
      finalDir,
      zipPath,
      monthLabel,
    };
  } finally {
    try { await context.close(); } catch {}
    try { fs.rmSync(profileCloneDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = function initDeepseekExport(options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? options.staleAfterMs : DEFAULT_STALE_AFTER_MS;
  const nowFn = typeof options.now === "function" ? options.now : Date.now;
  const onExported = typeof options.onExported === "function" ? options.onExported : null;
  let timer = null;
  let inflight = null;
  let stopped = false;

  async function maybeExport(force = false) {
    if (stopped) return { status: "stopped" };
    if (inflight) return inflight;
    inflight = Promise.resolve().then(async () => {
      const downloadsDir = options.downloadsDir || path.join(options.homeDir || os.homedir(), "Downloads");
      const finalDir = options.finalDir || autoExportDir(downloadsDir, nowFn());
      if (!force && isDirFresh(finalDir, nowFn(), staleAfterMs)) {
        return { status: "fresh", finalDir };
      }
      const result = await runExport({ ...options, now: nowFn(), finalDir });
      if (result && result.status === "ok" && onExported) {
        try { onExported(result); } catch {}
      }
      return result;
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function start() {
    void maybeExport(false).catch(() => {});
    if (intervalMs > 0) {
      timer = setInterval(() => {
        void maybeExport(false).catch(() => {});
      }, intervalMs);
    }
  }

  function cleanup() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    cleanup,
    runNow: () => maybeExport(true),
  };
};

module.exports.__test = {
  autoExportDir,
  defaultTempPath,
  exportMonthLabel,
  isDirFresh,
  resolvePlaywrightModulePath,
  copyChromeProfile,
  selectUsageMonthIfAvailable,
  utcYearMonthParts,
};
