"use strict";

const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const test = require("node:test");

const {
  buildTarboristBootstrap,
  buildTarboristManifest,
  quoteRString,
  tsvField,
  writeTarboristManifest
} = require("../../src/tarboristMake");

test("buildTarboristManifest writes sorted rows and uses generator destinations for generated targets", () => {
  const index = {
    targets: new Map([
      ["zeta", {
        file: "/project/_targets.R",
        name: "zeta",
        nameRange: {
          start: { character: 2, line: 9 }
        }
      }],
      ["alpha_branch", {
        file: "/project/_targets.R",
        generated: true,
        generator: {
          file: "/project/R/map_targets.R",
          range: {
            start: { character: 4, line: 14 }
          }
        },
        name: "alpha_branch",
        nameRange: {
          start: { character: 0, line: 0 }
        }
      }]
    ])
  };

  const manifest = buildTarboristManifest(index);

  assert.equal(
    manifest,
    [
      "name\tfile\tline\tcolumn",
      "alpha_branch\t/project/R/map_targets.R\t15\t5",
      "zeta\t/project/_targets.R\t10\t3",
      ""
    ].join("\n")
  );
});

test("tsvField strips tabs and newlines from manifest values", () => {
  assert.equal(tsvField("a\tb\nc\r\nd"), "a b c d");
});

test("quoteRString escapes backslashes and double quotes", () => {
  assert.equal(quoteRString('C:\\tmp\\"quoted"'), "\"C:\\\\tmp\\\\\\\"quoted\\\"\"");
});

test("buildTarboristBootstrap sources the helper and sets the manifest path", () => {
  const bootstrap = buildTarboristBootstrap("/repo/r/tarborist_make.R", "/tmp/tarborist-123/targets-manifest.tsv");

  assert.equal(
    bootstrap,
    'source("/repo/r/tarborist_make.R", local = .GlobalEnv)\n' +
    'tarborist_set_manifest("/tmp/tarborist-123/targets-manifest.tsv")'
  );
});

test("writeTarboristManifest writes the manifest to a temp directory", async () => {
  const index = {
    targets: new Map([
      ["alpha", {
        file: "/project/_targets.R",
        name: "alpha",
        nameRange: {
          start: { character: 1, line: 1 }
        }
      }]
    ])
  };

  const written = await writeTarboristManifest(index);
  try {
    const manifest = await fs.readFile(written.manifestPath, "utf8");
    assert.equal(manifest, "name\tfile\tline\tcolumn\nalpha\t/project/_targets.R\t2\t2\n");
    assert.equal(path.basename(written.manifestPath), "targets-manifest.tsv");
  } finally {
    await fs.rm(written.dir, {
      force: true,
      recursive: true
    });
  }
});
