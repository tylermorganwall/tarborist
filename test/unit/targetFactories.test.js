"use strict";

const assert = require("node:assert/strict");
const Module = require("module");
const test = require("node:test");

const { matchesCall, unwrapNode, walkNamed } = require("../../src/parser/ast");
const { ensureParserReady, isParserUnavailableError, isTreeSitterRuntimeError, parseText, resetParser } = require("../../src/parser/treeSitter");
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

test("unwrapNode() does not hang on empty wrapper nodes", () => {
  const node = {
    namedChildren: [],
    type: "expression"
  };

  assert.equal(unwrapNode(node), node);
});

test("parser error classifier recognizes fatal WASM/runtime failures", () => {
  assert.equal(isTreeSitterRuntimeError(new WebAssembly.RuntimeError("memory access out of bounds")), true);
  assert.equal(isTreeSitterRuntimeError(new Error("table index is out of bounds")), true);
  assert.equal(isParserUnavailableError(new Error("Tree-sitter parser is not initialized. Call ensureParserReady() before parsing.")), true);
});

test("ensureParserReady() retries with a fresh runtime after fatal initialization failure", async () => {
  const modulePath = require.resolve("../../src/parser/treeSitter");
  delete require.cache[modulePath];

  let initAttempts = 0;
  const fakeTreeSitter = {
    Language: {
      async load() {
        return {};
      }
    },
    Parser: class Parser {
      static async init() {
        initAttempts += 1;
        if (initAttempts === 1) {
          throw new WebAssembly.RuntimeError("memory access out of bounds");
        }
      }

      delete() {}

      parse(text) {
        return {
          text
        };
      }

      setLanguage() {}
    }
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "web-tree-sitter") {
      return fakeTreeSitter;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const parserModule = require("../../src/parser/treeSitter");
    const parser = await parserModule.ensureParserReady();

    assert.ok(parser);
    assert.equal(initAttempts, 2);
    assert.deepEqual(parserModule.parseText("x <- 1").text, "x <- 1");
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
    resetParser({
      reloadRuntime: true
    });
    await ensureParserReady();
  }
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
