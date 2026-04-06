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
  const date = new Date(totalMilliseconds);

  return {
    formatted: [
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
    ].join(""),
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

function normalizeMetaText(value) {
  return value === "" ? null : value;
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

    const parsedTime = parseMetaTime(row.time);
    const warnings = normalizeMetaText(row.warnings);
    const error = normalizeMetaText(row.error);
    metaByTarget.set(row.name, {
      bytes: normalizeMetaText(row.bytes),
      error,
      hasError: Boolean(error),
      hasWarnings: Boolean(warnings),
      raw: row,
      size: formatBytes(row.bytes, normalizeMetaText(row.size)),
      time: parsedTime ? parsedTime.formatted : null,
      timestampMs: parsedTime ? parsedTime.timestampMs : null,
      warnings
    });
  }

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
  parseTargetsMeta,
  readTargetsMeta
};
