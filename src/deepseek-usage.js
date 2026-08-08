"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_POLL_MS = 30000;
const MAX_BODY_BYTES = 32 * 1024;
const MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];
const DEFAULT_PRICING = {
  "deepseek-v4-flash": { prompt: 0.00000009, completion: 0.00000018, cacheRead: 0.0000000028 },
  "deepseek-v4-pro": { prompt: 0.000000435, completion: 0.00000087, cacheRead: 0.000000003625 },
};

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeModel(value) {
  const raw = String(value || "").trim().toLowerCase();
  const match = raw.match(/(?:^|\/)(deepseek-v4-(?:flash|pro))(?:-\d{8})?$/);
  return match ? match[1] : null;
}

function localDateKey(ms = Date.now()) {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sameUsageDate(value, date) {
  const left = String(value || "").trim().replace(/-/g, "");
  const right = String(date || "").trim().replace(/-/g, "");
  return left !== "" && left === right;
}

function startOfLocalDayMs(ms = Date.now()) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function parseTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function createEmptyStats(model) {
  return {
    model,
    calls: 0,
    inputTokens: 0,
    promptTokensTotal: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    currency: null,
    estimated: false,
    official: false,
    officialCostReported: false,
  };
}

function createStatsMap() {
  return new Map(MODELS.map((model) => [model, createEmptyStats(model)]));
}

function readPricing(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const metadataPath = options.openrouterMetadataPath
    || path.join(homeDir, ".hermes", "cache", "openrouter_model_metadata.json");
  const metadata = readJson(metadataPath);
  const pricing = { ...DEFAULT_PRICING };
  if (!metadata || typeof metadata !== "object") return pricing;
  for (const model of MODELS) {
    const record = metadata[model] || metadata[`deepseek/${model}`];
    const source = record && record.pricing;
    if (!source || typeof source !== "object") continue;
    pricing[model] = {
      prompt: numberOrZero(source.prompt) || DEFAULT_PRICING[model].prompt,
      completion: numberOrZero(source.completion) || DEFAULT_PRICING[model].completion,
      // Keep official DeepSeek cache-hit pricing as the source of truth.
      cacheRead: DEFAULT_PRICING[model].cacheRead,
    };
  }
  return pricing;
}

function costFromUsage(model, usage, pricing) {
  const cost = usage && usage.cost;
  const total = cost && numberOrZero(cost.total);
  if (total > 0) return { cost: total, estimated: false };
  const estimatedCost = numberOrZero(usage && usage.estimated_cost);
  if (estimatedCost > 0) return { cost: estimatedCost, estimated: true };

  const rates = pricing[model] || DEFAULT_PRICING[model];
  const input = numberOrZero(usage && (usage.input ?? usage.input_tokens));
  const output = numberOrZero(usage && (usage.output ?? usage.output_tokens));
  const cacheRead = numberOrZero(usage && (usage.cacheRead ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens));
  return {
    cost: input * rates.prompt + output * rates.completion + cacheRead * rates.cacheRead,
    estimated: true,
  };
}

function usageFromOpenClawMessage(message) {
  if (!message || typeof message !== "object") return null;
  const model = normalizeModel(message.model);
  if (!model) return null;
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return null;
  return {
    model,
    timestampMs: parseTimestampMs(message.timestamp),
    inputTokens: numberOrZero(usage.input ?? usage.input_tokens),
    promptTokensTotal: numberOrZero(usage.prompt_tokens),
    outputTokens: numberOrZero(usage.output ?? usage.output_tokens),
    cacheReadTokens: numberOrZero(usage.cacheRead ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens),
    cacheWriteTokens: numberOrZero(usage.cacheWrite ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens),
    cacheHitRate: Number.isFinite(Number(usage.cache_hit_percent)) ? Number(usage.cache_hit_percent) / 100 : null,
    usage,
  };
}

function usageFromHermesDoneEvent(entry) {
  if (!entry || typeof entry !== "object" || entry.event !== "done") return null;
  const payload = entry.payload || {};
  const session = payload.session || {};
  if (String(session.model_provider || "").toLowerCase() !== "deepseek") return null;
  const model = normalizeModel(session.model || payload.model);
  if (!model) return null;
  const usage = payload.usage || session;
  if (!usage || typeof usage !== "object") return null;
  return {
    model,
    timestampMs: parseTimestampMs(entry.created_at),
    inputTokens: numberOrZero(usage.input_tokens),
    promptTokensTotal: numberOrZero(usage.input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
    cacheReadTokens: numberOrZero(usage.cache_read_tokens),
    cacheWriteTokens: numberOrZero(usage.cache_write_tokens),
    cacheHitRate: Number.isFinite(Number(usage.cache_hit_percent)) ? Number(usage.cache_hit_percent) / 100 : null,
    usage,
  };
}

function usageFromCacheHitPayload(payload, now = Date.now()) {
  if (!payload || typeof payload !== "object") return null;
  if (String(payload.provider || "").toLowerCase() !== "deepseek") return null;
  const model = normalizeModel(payload.model);
  if (!model) return null;
  return {
    model,
    timestampMs: parseTimestampMs(payload.timestamp || payload.created_at) || now,
    inputTokens: numberOrZero(payload.input_tokens),
    promptTokensTotal: numberOrZero(payload.prompt_tokens || payload.input_tokens),
    outputTokens: numberOrZero(payload.output_tokens),
    cacheReadTokens: numberOrZero(payload.cache_read_tokens),
    cacheWriteTokens: numberOrZero(payload.cache_write_tokens),
    cacheHitRate: Number.isFinite(Number(payload.cache_hit_percent)) ? Number(payload.cache_hit_percent) / 100 : null,
    usage: payload,
  };
}

function addUsage(statsMap, record, options) {
  if (!record || !MODELS.includes(record.model)) return;
  const startMs = Number(options && options.startMs);
  const endMs = Number(options && options.endMs);
  if (!Number.isFinite(record.timestampMs)) return;
  if (Number.isFinite(startMs) && record.timestampMs < startMs) return;
  if (Number.isFinite(endMs) && record.timestampMs >= endMs) return;
  const stats = statsMap.get(record.model);
  if (!stats) return;
  if (stats.official) return;
  const pricing = options && options.pricing ? options.pricing : DEFAULT_PRICING;
  const priced = costFromUsage(record.model, {
    ...record.usage,
    input: record.inputTokens,
    output: record.outputTokens,
    cacheRead: record.cacheReadTokens,
  }, pricing);
  stats.calls += 1;
  stats.inputTokens += record.inputTokens;
  stats.promptTokensTotal += numberOrZero(record.promptTokensTotal);
  stats.outputTokens += record.outputTokens;
  stats.cacheReadTokens += record.cacheReadTokens;
  stats.cacheWriteTokens += record.cacheWriteTokens;
  stats.cost += priced.cost;
  stats.estimated = stats.estimated || priced.estimated;
}

function readJsonlRecords(filePath, visitor) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      visitor(JSON.parse(line));
    } catch {
      // Ignore partial or noisy lines; usage HUD should be best-effort.
    }
  }
}

function parseGatewayTimestampMs(value) {
  const match = String(value || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const milliseconds = Number(`0.${fraction}`) * 1000;
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Math.floor(milliseconds)
  ).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function usageFromGatewayUsageReportLine(line) {
  const match = String(line || "").match(
    /^\[([^\]]+)\]\s+\[USAGE_REPORT\]\s+(deepseek-v4-(?:flash|pro))\s+input=(\d+)\s+output=(\d+)\s+cache=(\d+)/i
  );
  if (!match) return null;
  const inputTokens = numberOrZero(match[3]);
  const outputTokens = numberOrZero(match[4]);
  const cacheReadTokens = numberOrZero(match[5]);
  return {
    model: normalizeModel(match[2]),
    timestampMs: parseGatewayTimestampMs(match[1]),
    inputTokens,
    promptTokensTotal: inputTokens + cacheReadTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    usage: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
    },
  };
}

function readGatewayUsageRecords(filePath, visitor) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const record = usageFromGatewayUsageReportLine(line);
    if (record) visitor(record);
  }
}

function listFilesModifiedSince(root, predicate, sinceMs) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (predicate && !predicate(name)) continue;
    const filePath = path.join(root, name);
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs < sinceMs) continue;
    files.push(filePath);
  }
  return files;
}

function listNestedJsonlModifiedSince(root, sinceMs) {
  const files = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return files;
  }
  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    let stat = null;
    try {
      stat = fs.statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of listFilesModifiedSince(dirPath, (name) => name.endsWith(".jsonl"), sinceMs)) {
      files.push(file);
    }
  }
  return files;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function readCsvRows(filePath) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map((cell) => cell.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = (cells[i] || "").trim();
    return row;
  });
}

function findOfficialUsageExports(options = {}) {
  const downloadsDir = options.downloadsDir || path.join(options.homeDir || os.homedir(), "Downloads");
  let names = [];
  try {
    names = fs.readdirSync(downloadsDir);
  } catch {
    return [];
  }
  const dirs = [];
  for (const name of names) {
    if (!/^usage_data_/i.test(name)) continue;
    const fullPath = path.join(downloadsDir, name);
    let stat = null;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    dirs.push({ path: fullPath, mtimeMs: stat.mtimeMs });
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dirs.map((entry) => entry.path);
}

function aggregateOfficialUsage(options = {}) {
  const date = options.date || localDateKey(options.now);
  const hasExplicitExportDirs = Array.isArray(options.officialExportDirs) && options.officialExportDirs.length > 0;
  const shouldAutoFindExports = !hasExplicitExportDirs
    && !options.openclawSessionsDir
    && !options.hermesRunJournalDir;
  const exportDirs = hasExplicitExportDirs
    ? options.officialExportDirs
    : (shouldAutoFindExports ? findOfficialUsageExports(options) : []);
  const statsMap = createStatsMap();
  let found = false;

  for (const dir of exportDirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const amountFile = files.find((name) => /^amount-.*\.csv$/i.test(name));
    const costFile = files.find((name) => /^cost-.*\.csv$/i.test(name));
    if (!amountFile && !costFile) continue;

    if (amountFile) {
      for (const row of readCsvRows(path.join(dir, amountFile))) {
        if (!sameUsageDate(row.utc_date, date)) continue;
        const model = normalizeModel(row.model);
        if (!model) continue;
        const stats = statsMap.get(model);
        if (!stats) continue;
        const amount = numberOrZero(row.amount);
        const type = String(row.type || "").trim();
        found = true;
        stats.official = true;
        if (type === "request_count") stats.calls += amount;
        else if (type === "input_cache_hit_tokens") stats.cacheReadTokens += amount;
        else if (type === "input_cache_miss_tokens") stats.inputTokens += amount;
        else if (type === "output_tokens") stats.outputTokens += amount;
      }
    }

    if (costFile) {
      for (const row of readCsvRows(path.join(dir, costFile))) {
        if (!sameUsageDate(row.utc_date, date)) continue;
        const model = normalizeModel(row.model);
        if (!model) continue;
        const stats = statsMap.get(model);
        if (!stats) continue;
        found = true;
        stats.official = true;
        stats.officialCostReported = true;
        stats.cost += numberOrZero(row.cost);
        if (!stats.currency && row.currency) stats.currency = String(row.currency).trim().toUpperCase();
      }
    }
  }

  if (!found) return null;
  for (const stats of statsMap.values()) {
    if (!stats.official) continue;
    stats.promptTokensTotal = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
    if (stats.officialCostReported) {
      stats.estimated = false;
      if (!stats.currency) stats.currency = "CNY";
      continue;
    }

    // The amount export can arrive before the cost export. Keep the official
    // token totals, but do not let an amount-only snapshot hide a usable
    // estimate from the live pricing table.
    const rates = options.pricing && options.pricing[stats.model]
      ? options.pricing[stats.model]
      : DEFAULT_PRICING[stats.model];
    stats.cost = stats.inputTokens * rates.prompt
      + stats.outputTokens * rates.completion
      + stats.cacheReadTokens * rates.cacheRead;
    stats.estimated = stats.cost > 0;
  }
  return statsMap;
}

function aggregateDailyUsage(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const startMs = Number.isFinite(options.startMs) ? options.startMs : startOfLocalDayMs(now);
  const endMs = Number.isFinite(options.endMs) ? options.endMs : startMs + 24 * 60 * 60 * 1000;
  const homeDir = options.homeDir || os.homedir();
  const pricing = options.pricing || readPricing({ ...options, homeDir });
  const officialStatsMap = aggregateOfficialUsage({ ...options, now, date: localDateKey(startMs), homeDir });
  const statsMap = officialStatsMap || createStatsMap();
  const add = (record) => addUsage(statsMap, record, { startMs, endMs, pricing });

  const openclawSessionsDir = options.openclawSessionsDir
    || path.join(homeDir, ".openclaw", "agents", "main", "sessions");
  for (const filePath of listFilesModifiedSince(openclawSessionsDir, (name) => name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl"), startMs)) {
    readJsonlRecords(filePath, (entry) => {
      if (entry && entry.type === "message") add(usageFromOpenClawMessage(entry.message));
    });
  }

  const hermesRunJournalDir = options.hermesRunJournalDir
    || path.join(homeDir, ".hermes", "webui", "sessions", "_run_journal");
  for (const filePath of listNestedJsonlModifiedSince(hermesRunJournalDir, startMs)) {
    readJsonlRecords(filePath, (entry) => add(usageFromHermesDoneEvent(entry)));
  }

  const liveRecords = Array.isArray(options.liveRecords) ? options.liveRecords : [];
  for (const record of liveRecords) add(record);

  // The gateway posts the raw Anthropic usage back to Clawd immediately, and
  // also writes a compact USAGE_REPORT line. Use it only as a live fallback:
  // addUsage skips any model already populated by the official CSV export.
  const gatewayLogPath = options.gatewayLogPath
    || path.join(homeDir, ".claude", "logs", "vertex-gemini-gateway.err.log");
  readGatewayUsageRecords(gatewayLogPath, (record) => add(record));

  return buildSnapshot(statsMap, { now, date: localDateKey(startMs), currency: "USD" });
}

function buildSnapshot(statsMap, options = {}) {
  const models = MODELS.map((model) => {
    const stats = statsMap.get(model) || createEmptyStats(model);
    const denominator = stats.promptTokensTotal > 0
      ? stats.promptTokensTotal
      : (stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens);
    const cacheHitRate = denominator > 0 ? stats.cacheReadTokens / denominator : null;
    return {
      model,
      label: model === "deepseek-v4-flash" ? "V4 Flash" : "V4 Pro",
      calls: stats.calls,
      cost: Number(stats.cost.toFixed(8)),
      currency: stats.currency || options.currency || "USD",
      estimated: stats.estimated,
      official: stats.official,
      cacheHitRate,
      hasData: stats.calls > 0
        || stats.inputTokens > 0
        || stats.outputTokens > 0
        || stats.cacheReadTokens > 0
        || stats.cacheWriteTokens > 0,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cacheReadTokens: stats.cacheReadTokens,
      cacheWriteTokens: stats.cacheWriteTokens,
    };
  });
  return {
    status: "ok",
    date: options.date || localDateKey(),
    models,
    updatedAt: Number.isFinite(options.now) ? options.now : Date.now(),
  };
}

function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readRequestJson(req, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

module.exports = function initDeepseekUsage(options = {}) {
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS;
  const onChange = typeof options.onChange === "function" ? options.onChange : null;
  const nowFn = typeof options.now === "function" ? options.now : Date.now;
  let timer = null;
  let inflight = null;
  let stopped = false;
  let liveRecords = [];
  let snapshot = buildSnapshot(createStatsMap(), { now: nowFn(), date: localDateKey(nowFn()) });

  function publish(next) {
    if (snapshotsEqual(snapshot, next)) return;
    snapshot = next;
    if (onChange) onChange(snapshot);
  }

  async function refresh() {
    if (stopped) return snapshot;
    if (inflight) return inflight;
    inflight = Promise.resolve().then(() => {
      const now = nowFn();
      const startMs = startOfLocalDayMs(now);
      liveRecords = liveRecords.filter((record) => Number(record.timestampMs) >= startMs);
      const next = aggregateDailyUsage({
        ...options,
        now,
        startMs,
        liveRecords,
      });
      publish(next);
      return snapshot;
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function recordUsage(payload) {
    const record = usageFromCacheHitPayload(payload, nowFn());
    if (!record) return false;
    liveRecords.push(record);
    refresh().catch(() => {});
    return true;
  }

  async function handleCacheHitPost(req, res) {
    try {
      const payload = await readRequestJson(req);
      const ok = recordUsage(payload);
      res.writeHead(ok ? 200 : 202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: ok ? "ok" : "ignored" }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", message: err && err.message ? err.message : "Invalid JSON" }));
    }
  }

  function start() {
    refresh().catch(() => {});
    if (pollMs > 0) {
      timer = setInterval(() => {
        refresh().catch(() => {});
      }, pollMs);
    }
  }

  function cleanup() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    refresh,
    cleanup,
    recordUsage,
    handleCacheHitPost,
    getSnapshot: () => snapshot,
  };
};

module.exports.__test = {
  MODELS,
  aggregateDailyUsage,
  aggregateOfficialUsage,
  buildSnapshot,
  findOfficialUsageExports,
  readCsvRows,
  readPricing,
  parseGatewayTimestampMs,
  usageFromGatewayUsageReportLine,
  readGatewayUsageRecords,
  normalizeModel,
  sameUsageDate,
  usageFromOpenClawMessage,
  usageFromHermesDoneEvent,
  usageFromCacheHitPayload,
  localDateKey,
  startOfLocalDayMs,
};
