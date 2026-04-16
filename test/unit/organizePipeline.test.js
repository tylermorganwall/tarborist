"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { buildStaticWorkspaceIndex } = require("../../src/index/pipelineResolver");
const { organizePipelineText } = require("../../src/organizePipeline");
const { ensureParserReady } = require("../../src/parser/treeSitter");

function buildIndexFromText(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarborist-organize-"));
  const rootFile = path.join(root, "_targets.R");
  fs.writeFileSync(rootFile, text, "utf8");

  return {
    file: rootFile,
    index: buildStaticWorkspaceIndex({
      readFile(file) {
        if (path.resolve(file) === path.resolve(rootFile)) {
          return text;
        }

        throw new Error(`Unexpected read: ${file}`);
      },
      workspaceRoot: root
    })
  };
}

test.before(async () => {
  await ensureParserReady();
});

test("organizePipelineText() reorders targets by DAG while preserving comments and fixed sub-pipeline references", async () => {
  const input = [
    "part <- list(",
    "  # beta comment",
    "  tar_target(beta, alpha + 1),",
    "",
    "  # alpha comment",
    "  tar_target(alpha, 1)",
    ")",
    "",
    "other_part <- list(",
    "  tar_target(omega, 1)",
    ")",
    "",
    "list(",
    "  part,",
    "  # delta comment",
    "  tar_target(delta, gamma + 1),",
    "",
    "  # gamma comment",
    "  tar_target(gamma, 1),",
    "  other_part",
    ")",
    ""
  ].join("\n");
  const expected = [
    "part <- list(",
    "  # alpha comment",
    "  tar_target(alpha, 1),",
    "",
    "  # beta comment",
    "  tar_target(beta, alpha + 1)",
    ")",
    "",
    "other_part <- list(",
    "  tar_target(omega, 1)",
    ")",
    "",
    "list(",
    "  part,",
    "  # gamma comment",
    "  tar_target(gamma, 1),",
    "",
    "  # delta comment",
    "  tar_target(delta, gamma + 1),",
    "  other_part",
    ")",
    ""
  ].join("\n");
  const { file, index } = buildIndexFromText(input);

  const result = await organizePipelineText({
    file,
    index,
    text: input
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, expected);
});

test("organizePipelineText() preserves original order for dependency ties", async () => {
  const input = [
    "list(",
    "  tar_target(gamma, alpha + 1),",
    "  tar_target(beta, 1),",
    "  tar_target(alpha, 1)",
    ")",
    ""
  ].join("\n");
  const expected = [
    "list(",
    "  tar_target(beta, 1),",
    "  tar_target(alpha, 1),",
    "  tar_target(gamma, alpha + 1)",
    ")",
    ""
  ].join("\n");
  const { file, index } = buildIndexFromText(input);

  const result = await organizePipelineText({
    file,
    index,
    text: input
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, expected);
});

test("organizePipelineText() also reorders tar_plan() named entries by DAG", async () => {
  const input = [
    "tarchetypes::tar_plan(",
    "  # beta comment",
    "  beta = alpha + 1,",
    "",
    "  # alpha comment",
    "  alpha = 1,",
    "  tar_target(gamma, beta + 1)",
    ")",
    ""
  ].join("\n");
  const expected = [
    "tarchetypes::tar_plan(",
    "  # alpha comment",
    "  alpha = 1,",
    "",
    "  # beta comment",
    "  beta = alpha + 1,",
    "  tar_target(gamma, beta + 1)",
    ")",
    ""
  ].join("\n");
  const { file, index } = buildIndexFromText(input);

  const result = await organizePipelineText({
    file,
    index,
    text: input
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, expected);
});

test("organizePipelineText() keeps inline comments attached without duplicating targets", async () => {
  const input = [
    "library(targets)",
    "",
    "list(",
    "\t# final summary",
    "\ttar_target(summary_tbl, data.frame(score = score, flag = flagged)), # 6",
    "",
    "\ttar_target(score, mean(model$x)), # 4",
    "",
    "\t# source data",
    "\ttar_target(raw_data, data.frame(x = 1:10, y = (1:10) + 1)), # 1",
    "",
    "\ttar_target(flagged, score > 5), # 5",
    "",
    "\ttar_target(model, transform(clean_data, x = x * 2)), # 3",
    "",
    "\ttar_target(clean_data, subset(raw_data, x > 3)) # 2",
    ")",
    ""
  ].join("\n");
  const expected = [
    "library(targets)",
    "",
    "list(",
    "\t# source data",
    "\ttar_target(raw_data, data.frame(x = 1:10, y = (1:10) + 1)), # 1",
    "",
    "\ttar_target(clean_data, subset(raw_data, x > 3)), # 2",
    "",
    "\ttar_target(model, transform(clean_data, x = x * 2)), # 3",
    "",
    "\ttar_target(score, mean(model$x)), # 4",
    "",
    "\ttar_target(flagged, score > 5), # 5",
    "",
    "\t# final summary",
    "\ttar_target(summary_tbl, data.frame(score = score, flag = flagged)) # 6",
    ")",
    ""
  ].join("\n");
  const { file, index } = buildIndexFromText(input);

  const result = await organizePipelineText({
    file,
    index,
    text: input
  });

  assert.equal(result.changed, true);
  assert.equal(result.text, expected);
});
