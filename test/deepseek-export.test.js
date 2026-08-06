const { describe, it } = require("node:test");
const assert = require("node:assert");

const { defaultTempPath, selectUsageMonthIfAvailable } = require("../src/deepseek-export").__test;

describe("DeepSeek scheduled export", () => {
  it("uses process-specific temporary directories so overlapping exporters cannot collide", () => {
    assert.strictEqual(
      defaultTempPath("clawd-deepseek-export-profile", 101, "/tmp"),
      "/tmp/clawd-deepseek-export-profile-101"
    );
    assert.notStrictEqual(
      defaultTempPath("clawd-deepseek-export-profile", 101, "/tmp"),
      defaultTempPath("clawd-deepseek-export-profile", 202, "/tmp")
    );
  });

  it("does not block export when DeepSeek has removed the legacy month selector", async () => {
    let selected = false;
    const result = await selectUsageMonthIfAvailable({
      locator: () => ({
        count: async () => 0,
        selectOption: async () => { selected = true; },
      }),
      waitForTimeout: async () => { throw new Error("should not wait for a missing selector"); },
    }, "2026 - 7月");

    assert.strictEqual(result, false);
    assert.strictEqual(selected, false);
  });

  it("uses the legacy selector when an older DeepSeek page still exposes it", async () => {
    let selectedLabel = null;
    let waitedMs = 0;
    const result = await selectUsageMonthIfAvailable({
      locator: () => ({
        count: async () => 1,
        selectOption: async ({ label }) => { selectedLabel = label; },
      }),
      waitForTimeout: async (ms) => { waitedMs = ms; },
    }, "2026 - 7月");

    assert.strictEqual(result, true);
    assert.strictEqual(selectedLabel, "2026 - 7月");
    assert.strictEqual(waitedMs, 1500);
  });
});
