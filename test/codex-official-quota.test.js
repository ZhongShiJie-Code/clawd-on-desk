"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { __test } = require("../src/codex-official-quota");

describe("Codex official quota parsing", () => {
  it("keeps official used_percent values as percentages", () => {
    const capturedAt = Date.now();
    const group = __test.parseUsage({
      rate_limit: {
        primary_window: {
          used_percent: 1,
          limit_window_seconds: 604800,
          reset_at: Math.floor((capturedAt + 86400000) / 1000),
        },
      },
    }, capturedAt);

    assert.strictEqual(group.codexWeekly.usedPercent, 1);
    assert.strictEqual(group.codexWeekly.windowMinutes, 10080);
  });

  it("does not rescale normal percentage values", () => {
    const capturedAt = Date.now();
    const window = __test.parseWindow({
      used_percent: 58,
      limit_window_seconds: 604800,
      reset_at: Math.floor((capturedAt + 86400000) / 1000),
    }, capturedAt);

    assert.strictEqual(window.usedPercent, 58);
  });
});
