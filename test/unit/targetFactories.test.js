"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { matchesCall, walkNamed } = require("../../src/parser/ast");
const { ensureParserReady, parseText } = require("../../src/parser/treeSitter");
const { parseTarTargetCall } = require("../../src/index/targetFactories");

function findFirstCall(source, callNames) {
  const tree = parseText(source);
  let matchedCall = null;

  walkNamed(tree.rootNode, (node) => {
    if (!matchedCall && node.type === "call" && matchesCall(node, callNames)) {
      matchedCall = node;
    }
  });

  return matchedCall;
}

test.before(async () => {
  await ensureParserReady();
});

test("parseTarTargetCall() supports positional name and command arguments", () => {
  const callNode = findFirstCall("tar_target(value, 1)\n", new Set(["tar_target"]));
  const parsed = parseTarTargetCall(callNode, "/tmp/_targets.R");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.target.name, "value");
  assert.equal(parsed.target.commandRange.start.line, 0);
});

test("parseTarTargetCall() supports positional arguments for target-like factories", () => {
  const callNode = findFirstCall("tar_parquet(value, 1)\n", new Set(["tar_parquet"]));
  const parsed = parseTarTargetCall(callNode, "/tmp/_targets.R");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.target.name, "value");
  assert.equal(parsed.target.commandRange.start.line, 0);
});
