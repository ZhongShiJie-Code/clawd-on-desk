"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const deepseekUsage = require("../src/deepseek-usage").__test;

function makeExportDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-deepseek-"));
  const dir = path.join(root, "usage_data_test");
  fs.mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { root, dir };
}

describe("DeepSeek usage aggregation", () => {
  it("accepts the official export date format with or without hyphens", () => {
    assert.equal(deepseekUsage.sameUsageDate("20260715", "2026-07-15"), true);
    assert.equal(deepseekUsage.sameUsageDate("2026-07-15", "20260715"), true);
    assert.equal(deepseekUsage.sameUsageDate("20260714", "2026-07-15"), false);
  });

  it("reads official CNY cost rows instead of returning zero", () => {
    const { root, dir } = makeExportDir({
      "amount-2026-07-15.csv": [
        "user_id,utc_date,model,type,amount",
        "u,20260715,deepseek-v4-flash,input_cache_hit_tokens,1000000",
        "u,20260715,deepseek-v4-flash,input_cache_miss_tokens,100000",
        "u,20260715,deepseek-v4-flash,output_tokens,20000",
      ].join("\n"),
      "cost-2026-07-15.csv": [
        "user_id,utc_date,model,cost,currency",
        "u,20260715,deepseek-v4-flash,1.2345,CNY",
      ].join("\n"),
    });

    try {
      const snapshot = deepseekUsage.aggregateDailyUsage({
        now: new Date("2026-07-15T12:00:00+08:00").getTime(),
        officialExportDirs: [dir],
        openclawSessionsDir: path.join(root, "openclaw"),
        hermesRunJournalDir: path.join(root, "hermes"),
      });
      const flash = snapshot.models.find((entry) => entry.model === "deepseek-v4-flash");
      assert.equal(flash.cost, 1.2345);
      assert.equal(flash.currency, "CNY");
      assert.equal(flash.official, true);
      assert.equal(flash.estimated, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("estimates an amount-only export while the cost export is pending", () => {
    const { root, dir } = makeExportDir({
      "amount-2026-07-15.csv": [
        "user_id,utc_date,model,type,amount",
        "u,20260715,deepseek-v4-flash,input_cache_hit_tokens,1000000",
        "u,20260715,deepseek-v4-flash,input_cache_miss_tokens,100000",
        "u,20260715,deepseek-v4-flash,output_tokens,20000",
      ].join("\n"),
    });

    try {
      const snapshot = deepseekUsage.aggregateDailyUsage({
        now: new Date("2026-07-15T12:00:00+08:00").getTime(),
        officialExportDirs: [dir],
        openclawSessionsDir: path.join(root, "openclaw"),
        hermesRunJournalDir: path.join(root, "hermes"),
      });
      const flash = snapshot.models.find((entry) => entry.model === "deepseek-v4-flash");
      assert.ok(flash.cost > 0);
      assert.equal(flash.currency, "USD");
      assert.equal(flash.official, true);
      assert.equal(flash.estimated, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not discard Hermes usage when the partition directory mtime is old", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hermes-"));
    const openclawDir = path.join(root, "openclaw");
    const hermesDir = path.join(root, "hermes");
    const partitionDir = path.join(hermesDir, "partition");
    fs.mkdirSync(openclawDir);
    fs.mkdirSync(partitionDir, { recursive: true });
    const now = new Date("2026-07-15T12:00:00+08:00").getTime();
    const journal = {
      event: "done",
      created_at: now / 1000,
      payload: {
        session: { model_provider: "deepseek", model: "deepseek-v4-flash" },
        usage: { input_tokens: 100000, output_tokens: 10000, cache_read_tokens: 50000 },
      },
    };
    const filePath = path.join(partitionDir, "run.jsonl");
    fs.writeFileSync(filePath, `${JSON.stringify(journal)}\n`);
    const old = new Date("2026-07-01T00:00:00+08:00");
    fs.utimesSync(partitionDir, old, old);

    try {
      const snapshot = deepseekUsage.aggregateDailyUsage({
        now,
        openclawSessionsDir: openclawDir,
        hermesRunJournalDir: hermesDir,
      });
      const flash = snapshot.models.find((entry) => entry.model === "deepseek-v4-flash");
      assert.ok(flash.cost > 0);
      assert.equal(flash.calls, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
