"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { getTargetDestination } = require("./targetDestination");

function quoteRString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function tsvField(value) {
  return String(value == null ? "" : value)
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, " ");
}

function buildTarboristManifest(index) {
  const lines = ["name\tfile\tline\tcolumn"];
  const targets = [...index.targets.values()].sort((left, right) => left.name.localeCompare(right.name));

  for (const target of targets) {
    const destination = getTargetDestination(target);
    if (!destination || !destination.file || !destination.range || !destination.range.start) {
      continue;
    }

    lines.push([
      tsvField(target.name),
      tsvField(destination.file),
      tsvField(destination.range.start.line + 1),
      tsvField(destination.range.start.character + 1)
    ].join("\t"));
  }

  return `${lines.join("\n")}\n`;
}

async function writeTarboristManifest(index) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tarborist-"));
  const manifestPath = path.join(dir, "targets-manifest.tsv");
  await fs.writeFile(manifestPath, buildTarboristManifest(index), "utf8");
  return { dir, manifestPath };
}

function buildTarboristBootstrap(helperPath, manifestPath) {
  return [
    `source(${quoteRString(helperPath)}, local = .GlobalEnv)`,
    `tarborist_set_manifest(${quoteRString(manifestPath)})`
  ].join("\n");
}

function buildManifestUpdateCode(manifestPath) {
  return `tarborist_set_manifest(${quoteRString(manifestPath)})`;
}

module.exports = {
  buildManifestUpdateCode,
  buildTarboristBootstrap,
  buildTarboristManifest,
  quoteRString,
  tsvField,
  writeTarboristManifest
};
