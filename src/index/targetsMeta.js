"use strict";

// Parse the _targets metadata store so hovers can show recent runtime state
// without having to execute any R code.
const path = require("path");

const { normalizeFile, pathExists } = require("../util/paths");

const META_COLUMNS = [
  "name",
  "type",
  "data",
  "command",
  "depend",
  "seed",
  "path",
  "time",
  "size",
  "bytes",
  "format",
  "repository",
  "iteration",
  "parent",
  "children",
  "seconds",
  "warnings",
  "error"
];

function splitMetaLine(line, columnCount) {
  const parts = line.split("|");
  if (parts.length <= columnCount) {
    return parts;
  }

  const head = parts.slice(0, columnCount - 1);
  head.push(parts.slice(columnCount - 1).join("|"));
  return head;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function pad3(value) {
  return String(value).padStart(3, "0");
}

const VALID_TIME_ZONE_CACHE = new Map();
const TIMESTAMP_FORMATTER_CACHE = new Map();
let detectedDefaultTimeZone = null;

function detectDefaultTimeZone() {
  if (detectedDefaultTimeZone) {
    return detectedDefaultTimeZone;
  }

  try {
    detectedDefaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (_error) {
    detectedDefaultTimeZone = "UTC";
  }

  return detectedDefaultTimeZone;
}

function isValidTimeZone(timeZone) {
  if (!timeZone) {
    return false;
  }

  if (timeZone === "UTC") {
    return true;
  }

  if (VALID_TIME_ZONE_CACHE.has(timeZone)) {
    return VALID_TIME_ZONE_CACHE.get(timeZone);
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    VALID_TIME_ZONE_CACHE.set(timeZone, true);
    return true;
  } catch (_error) {
    VALID_TIME_ZONE_CACHE.set(timeZone, false);
    return false;
  }
}

function resolveDisplayTimeZone(timeZone = "") {
  const configured = String(timeZone || "").trim();
  if (configured && isValidTimeZone(configured)) {
    return configured;
  }

  const detected = detectDefaultTimeZone();
  return isValidTimeZone(detected) ? detected : "UTC";
}

function formatTimestampUtc(timestampMs) {
  const date = new Date(timestampMs);
  return [
    date.getUTCFullYear(),
    "-",
    pad2(date.getUTCMonth() + 1),
    "-",
    pad2(date.getUTCDate()),
    " ",
    pad2(date.getUTCHours()),
    ":",
    pad2(date.getUTCMinutes()),
    ":",
    pad2(date.getUTCSeconds()),
    ".",
    pad3(date.getUTCMilliseconds()),
    " UTC"
  ].join("");
}

function getTimestampFormatter(timeZone) {
  if (!TIMESTAMP_FORMATTER_CACHE.has(timeZone)) {
    TIMESTAMP_FORMATTER_CACHE.set(timeZone, new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      timeZoneName: "short",
      year: "numeric"
    }));
  }

  return TIMESTAMP_FORMATTER_CACHE.get(timeZone);
}

function formatTimestampWithFormatter(timestampMs, formatter) {
  const date = new Date(timestampMs);
  const formatted = formatter.format(date).replace(",", "");
  const zoneOffset = formatted.lastIndexOf(" ");
  if (zoneOffset === -1) {
    return `${formatted}.${pad3(date.getUTCMilliseconds())}`;
  }

  return `${formatted.slice(0, zoneOffset)}.${pad3(date.getUTCMilliseconds())}${formatted.slice(zoneOffset)}`;
}

function formatTimestampInTimeZone(timestampMs, timeZone = "") {
  if (!Number.isFinite(timestampMs)) {
    return null;
  }

  const resolvedTimeZone = resolveDisplayTimeZone(timeZone);
  if (resolvedTimeZone === "UTC") {
    return formatTimestampUtc(timestampMs);
  }

  return formatTimestampWithFormatter(timestampMs, getTimestampFormatter(resolvedTimeZone));
}

function parseMetaTime(raw) {
  const match = /^t([0-9]+(?:\.[0-9]+)?)s$/.exec(raw || "");
  if (!match) {
    return null;
  }

  const days = Number(match[1]);
  if (!Number.isFinite(days)) {
    return null;
  }

  const totalMilliseconds = Math.round(days * 24 * 60 * 60 * 1000);

  return {
    timestampMs: totalMilliseconds
  };
}

function formatBytes(bytesValue, rawSize) {
  const bytes = Number(bytesValue);
  if (!Number.isFinite(bytes)) {
    return rawSize || null;
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = -1;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const display = size >= 10 ? size.toFixed(1) : size.toFixed(2);
  return `${display} ${units[unitIndex]} (${bytes} B)`;
}

function getMetaSizeLabel(format) {
  return format === "file" ? "File size" : "Size";
}

function normalizeMetaText(value) {
  return value === "" ? null : value;
}

function formatMetaDuration(rawSeconds) {
  const seconds = Number(rawSeconds);
  if (!Number.isFinite(seconds)) {
    return null;
  }

  if (seconds < 1) {
    return `${Math.round(seconds * 1000)} ms`;
  }

  if (seconds < 10) {
    return `${seconds.toFixed(2)} s`;
  }

  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }

  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const parts = [];

  if (hours) {
    parts.push(`${hours} h`);
  }

  if (minutes) {
    parts.push(`${minutes} m`);
  }

  if (remainingSeconds || !parts.length) {
    parts.push(`${remainingSeconds} s`);
  }

  return parts.join(" ");
}

function formatDurationSeconds(seconds) {
  return formatMetaDuration(String(seconds));
}

function createMetaFromRow(row) {
  const parsedTime = parseMetaTime(row.time);
  const warnings = normalizeMetaText(row.warnings);
  const error = normalizeMetaText(row.error);
  const format = normalizeMetaText(row.format);

  return {
    bytes: normalizeMetaText(row.bytes),
    bytesValue: Number.isFinite(Number(row.bytes)) ? Number(row.bytes) : null,
    error,
    format,
    hasError: Boolean(error),
    hasWarnings: Boolean(warnings),
    parent: normalizeMetaText(row.parent),
    raw: row,
    runtime: formatMetaDuration(row.seconds),
    secondsValue: Number.isFinite(Number(row.seconds)) ? Number(row.seconds) : null,
    size: formatBytes(row.bytes, normalizeMetaText(row.size)),
    sizeLabel: getMetaSizeLabel(format),
    time: null,
    timestampMs: parsedTime ? parsedTime.timestampMs : null,
    type: normalizeMetaText(row.type),
    warnings
  };
}

function uniqueTexts(values) {
  return [...new Set(values
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function buildBranchAggregateMeta(parentName, branches, parentMeta = null) {
  const builtBranches = branches.filter((branch) => Number.isFinite(branch.timestampMs));
  const latestBranch = builtBranches.reduce((latest, branch) => {
    if (!latest || branch.timestampMs > latest.timestampMs) {
      return branch;
    }

    return latest;
  }, null);
  const byteValues = branches
    .map((branch) => branch.bytesValue)
    .filter((value) => Number.isFinite(value));
  const secondValues = branches
    .map((branch) => branch.secondsValue)
    .filter((value) => Number.isFinite(value));
  const bytesValue = byteValues.length
    ? byteValues.reduce((total, value) => total + value, 0)
    : null;
  const secondsValue = secondValues.length
    ? secondValues.reduce((total, value) => total + value, 0)
    : null;
  const warnings = uniqueTexts(branches.map((branch) => branch.warnings)).join("\n") || null;
  const errors = uniqueTexts(branches.map((branch) => branch.error)).join("\n") || null;
  const format = parentMeta && parentMeta.format ? parentMeta.format : (branches.find((branch) => branch.format)?.format || null);
  const timestampMs = latestBranch ? latestBranch.timestampMs : (parentMeta ? parentMeta.timestampMs : null);

  return {
    bytes: bytesValue === null ? (parentMeta ? parentMeta.bytes : null) : String(bytesValue),
    bytesValue,
    branchCount: branches.length,
    builtBranchCount: builtBranches.length,
    dynamicBranchAggregate: true,
    error: errors,
    format,
    hasError: Boolean(errors),
    hasWarnings: Boolean(warnings),
    parent: null,
    raw: {
      branchCount: String(branches.length),
      builtBranchCount: String(builtBranches.length),
      name: parentName,
      type: parentMeta && parentMeta.type ? parentMeta.type : "stem"
    },
    runtime: secondsValue === null ? (parentMeta ? parentMeta.runtime : null) : formatDurationSeconds(secondsValue),
    secondsValue,
    size: bytesValue === null ? (parentMeta ? parentMeta.size : null) : formatBytes(bytesValue, null),
    sizeLabel: getMetaSizeLabel(format),
    time: null,
    timestampMs,
    type: parentMeta && parentMeta.type ? parentMeta.type : "stem",
    warnings
  };
}

function applyBranchAggregates(metaByTarget) {
  const branchesByParent = new Map();

  for (const meta of metaByTarget.values()) {
    if (!meta || meta.type !== "branch" || !meta.parent) {
      continue;
    }

    if (!branchesByParent.has(meta.parent)) {
      branchesByParent.set(meta.parent, []);
    }
    branchesByParent.get(meta.parent).push(meta);
  }

  for (const [parentName, branches] of branchesByParent.entries()) {
    metaByTarget.set(parentName, buildBranchAggregateMeta(parentName, branches, metaByTarget.get(parentName) || null));
  }
}

function parseTargetsMeta(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length);
  if (!lines.length) {
    return new Map();
  }

  const header = splitMetaLine(lines[0], META_COLUMNS.length);
  const columns = header.length === META_COLUMNS.length ? header : META_COLUMNS;
  const metaByTarget = new Map();

  for (const line of lines.slice(1)) {
    const values = splitMetaLine(line, columns.length);
    const row = {};
    for (let index = 0; index < columns.length; index += 1) {
      row[columns[index]] = values[index] || "";
    }

    if (!row.name) {
      continue;
    }

    metaByTarget.set(row.name, createMetaFromRow(row));
  }

  applyBranchAggregates(metaByTarget);
  return metaByTarget;
}

function readTargetsMeta(workspaceRoot, readFile) {
  const metaFile = normalizeFile(path.join(workspaceRoot, "_targets", "meta", "meta"));
  if (!pathExists(metaFile)) {
    return new Map();
  }

  try {
    return parseTargetsMeta(readFile(metaFile));
  } catch (_error) {
    return new Map();
  }
}

module.exports = {
  detectDefaultTimeZone,
  formatTimestampInTimeZone,
  parseTargetsMeta,
  readTargetsMeta,
  resolveDisplayTimeZone
};
