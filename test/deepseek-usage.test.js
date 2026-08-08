"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, describe, it } = require("node:test");
const assert = require("node:assert");

const { __test } = require("../src/deepseek-usage");

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("DeepSeek official usage parsing", () => {
  it("matches official ISO timestamps to the local usage date", () => {
    assert.strictEqual(__test.usageDateKey("2026-08-08T00:00:00+08:00"), "2026-08-08");
    assert.strictEqual(__test.usageDateKey("20260808"), "2026-08-08");
    assert.strictEqual(__test.sameUsageDate("2026-08-08T00:00:00+08:00", "2026-08-08"), true);
    assert.strictEqual(__test.sameUsageDate("20260808", "2026-08-08"), true);
    assert.strictEqual(__test.sameUsageDate("2026-08-07T16:00:00Z", "2026-08-08"), false);
    assert.strictEqual(__test.sameUsageDate("2026-08-08", "2026-08-08"), true);
  });

  it("loads cache tokens, cost, and cache hit rate from official exports", () => {
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-deepseek-usage-"));
    tempDirs.push(exportDir);
    fs.writeFileSync(path.join(exportDir, "amount-test.csv"), [
      "user_id,start_time_iso,end_time_iso,model,type,amount",
      "user,2026-08-08T00:00:00+08:00,2026-08-09T00:00:00+08:00,deepseek-v4-flash,input_cache_hit_tokens,970",
      "user,2026-08-08T00:00:00+08:00,2026-08-09T00:00:00+08:00,deepseek-v4-flash,input_cache_miss_tokens,30",
      "user,2026-08-08T00:00:00+08:00,2026-08-09T00:00:00+08:00,deepseek-v4-flash,output_tokens,10",
      "user,2026-08-08T00:00:00+08:00,2026-08-09T00:00:00+08:00,deepseek-v4-flash,request_count,2",
    ].join("\n"));
    fs.writeFileSync(path.join(exportDir, "cost-test.csv"), [
      "user_id,start_time_iso,end_time_iso,model,cost,currency",
      "user,2026-08-08T00:00:00+08:00,2026-08-09T00:00:00+08:00,deepseek-v4-flash,1.23,CNY",
    ].join("\n"));

    const snapshot = __test.aggregateDailyUsage({
      now: new Date("2026-08-08T12:00:00+08:00").getTime(),
      officialExportDirs: [exportDir],
      openclawSessionsDir: path.join(exportDir, "no-openclaw"),
      hermesRunJournalDir: path.join(exportDir, "no-hermes"),
    });
    const flash = snapshot.models.find((entry) => entry.model === "deepseek-v4-flash");

    assert.strictEqual(flash.official, true);
    assert.strictEqual(flash.hasData, true);
    assert.strictEqual(flash.cost, 1.23);
    assert.strictEqual(flash.currency, "CNY");
    assert.strictEqual(flash.cacheReadTokens, 970);
    assert.strictEqual(flash.inputTokens, 30);
    assert.strictEqual(flash.outputTokens, 10);
    assert.strictEqual(flash.calls, 2);
    assert.strictEqual(flash.cacheHitRate, 0.97);
  });
});
