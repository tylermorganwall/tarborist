"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectDefaultTimeZone,
  formatTimestampInTimeZone,
  parseTargetsMeta,
  resolveDisplayTimeZone
} = require("../../src/index/targetsMeta");

const META_HEADER = "name|type|data|command|depend|seed|path|time|size|bytes|format|repository|iteration|parent|children|seconds|warnings|error";

function metaRow(name, time) {
  return `${name}|stem||||||${time}||100|rds|local|vector||||0.1||`;
}

function target(name, pattern = false) {
  return {
    name,
    patternRange: pattern ? { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } : null
  };
}

test("formatTimestampInTimeZone() uses the fast UTC display format", () => {
  const timestampMs = Date.parse("2025-10-10T15:56:12.925Z");
  const originalDateTimeFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function dateTimeFormatShouldNotBeCalled() {
    throw new Error("UTC formatting should not construct Intl.DateTimeFormat");
  };

  try {
    assert.equal(
      formatTimestampInTimeZone(timestampMs, "UTC"),
      "2025-10-10 15:56:12.925 UTC"
    );
  } finally {
    Intl.DateTimeFormat = originalDateTimeFormat;
  }
});

test("formatTimestampInTimeZone() formats non-UTC timestamps in the configured timezone", () => {
  assert.equal(
    formatTimestampInTimeZone(Date.parse("2025-10-10T15:56:12.925Z"), "America/New_York"),
    "2025-10-10 11:56:12.925 EDT"
  );
});

test("formatTimestampInTimeZone() falls back for empty or invalid configured timezones", () => {
  const timestampMs = Date.parse("2025-10-10T15:56:12.925Z");
  const detected = resolveDisplayTimeZone(detectDefaultTimeZone());
  const expected = formatTimestampInTimeZone(timestampMs, detected);

  assert.equal(formatTimestampInTimeZone(timestampMs, ""), expected);
  assert.equal(formatTimestampInTimeZone(timestampMs, "Not/A_TimeZone"), expected);
});

test("parseTargetsMeta() preserves timestampMs without eagerly formatting metadata time", () => {
  const meta = parseTargetsMeta([
    META_HEADER,
    metaRow("x", "t20371.6640384838s")
  ].join("\n")).get("x");

  assert.ok(meta);
  assert.equal(meta.timestampMs, Date.parse("2025-10-10T15:56:12.925Z"));
  assert.equal(meta.time, null);
});

test("parseTargetsMeta() ignores stale branch metadata for current stem targets", () => {
  const meta = parseTargetsMeta([
    META_HEADER,
    "mapped|stem|||||||s0b|0|rds|local|vector||mapped_branch_1,mapped_branch_2|0||",
    "mapped_branch_1|branch||||||t20371.664038489s|s100b|100|rds|local|vector|mapped||0.500|old warning|",
    "mapped_branch_2|branch||||||t20371.700000000s|s300b|300|rds|local|vector|mapped||1.250||"
  ].join("\n"), new Map([
    ["mapped", target("mapped")]
  ]));

  assert.equal(meta.has("mapped"), false);
});

test("parseTargetsMeta() ignores stale stem metadata for current pattern targets", () => {
  const meta = parseTargetsMeta([
    META_HEADER,
    "mapped|stem||||||t20371.664038489s|s100b|100|rds|local|vector|||0.500|old warning|"
  ].join("\n"), new Map([
    ["mapped", target("mapped", true)]
  ]));

  assert.equal(meta.has("mapped"), false);
});
