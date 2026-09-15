"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const parser = require("../../src/parser/treeSitter");
const { buildStaticWorkspaceIndex } = require("../../src/index/pipelineResolver");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function isolatedParser(runtime) {
  const filename = require.resolve("../../src/parser/treeSitter");
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  instance.require = (name) => name === "web-tree-sitter" ? runtime : require(name);
  instance._compile(fs.readFileSync(filename, "utf8"), filename);
  return instance.exports;
}

test.before(() => parser.ensureParserReady());

test("index snapshots release all trees, including Quarto and malformed recovery trees", () => {
  const runtime = require("web-tree-sitter");
  const originalDelete = runtime.Tree.prototype.delete;
  let deleted = 0;
  runtime.Tree.prototype.delete = function () {
    deleted += 1;
    return originalDelete.call(this);
  };
  const before = parser.getParserStatistics();
  try {
    for (const fixture of ["direct", "tar_map", "tar_quarto", "partial_target_command", "missing_pipeline_comma"]) {
      const root = path.resolve(__dirname, "../fixtures", fixture);
      const index = buildStaticWorkspaceIndex({ workspaceRoot: root, readFile: (file) => fs.readFileSync(file, "utf8") });
      const pending = [index];
      const seen = new Set();
      while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== "object" || seen.has(value)) {
          continue;
        }
        seen.add(value);
        assert.ok(!(value instanceof runtime.Node));
        assert.ok(!(value instanceof runtime.Tree));
        const children = value instanceof Map || value instanceof Set ? value.values() : Object.values(value);
        for (const child of children) {
          pending.push(child);
        }
      }
      assert.equal(parser.getParserStatistics().liveTrees, 0);
    }
    assert.equal(deleted, parser.getParserStatistics().parses - before.parses);
    assert.ok(deleted > 5, "recovery and Quarto parses are included in cleanup");
  } finally {
    runtime.Tree.prototype.delete = originalDelete;
  }
});

test("analysis failures release trees before propagating errors", () => {
  const runtime = require("web-tree-sitter");
  const originalDelete = runtime.Tree.prototype.delete;
  let deleted = 0;
  runtime.Tree.prototype.delete = function () { deleted += 1; return originalDelete.call(this); };
  try {
    assert.throws(() => parser.withTreeScope(() => {
      parser.parseText("x <- 1");
      throw new Error("analysis failed");
    }), /analysis failed/);
    assert.equal(deleted, 1);
    assert.equal(parser.getParserStatistics().liveTrees, 0);
  } finally {
    runtime.Tree.prototype.delete = originalDelete;
  }
});

test("fatal errors during AST access rebuild the runtime and retry once", async () => {
  const original = parser.getParser();
  const generation = parser.getParserStatistics().runtimeGeneration;
  let invalidDestructorCalls = 0;
  original.parse = () => ({
    get rootNode() { throw new WebAssembly.RuntimeError("memory access out of bounds"); },
    delete() { invalidDestructorCalls += 1; }
  });
  let attempts = 0;
  let retries = 0;
  const result = await parser.runParserOperation(() => {
    attempts += 1;
    return parser.parseText("x <- 1").rootNode.type;
  }, { onRetry: () => { retries += 1; } });
  assert.equal(result, "program");
  assert.equal(attempts, 2);
  assert.equal(retries, 1);
  assert.equal(invalidDestructorCalls, 0);
  assert.notEqual(parser.getParser(), original);
  assert.ok(parser.getParserStatistics().runtimeGeneration > generation);
  assert.equal(parser.getParserStatistics().liveTrees, 0);
});

test("persistent operation failures stop after the single retry", async () => {
  let attempts = 0;
  await assert.rejects(parser.runParserOperation(() => {
    attempts += 1;
    throw new WebAssembly.RuntimeError("unreachable");
  }), /unreachable/);
  assert.equal(attempts, 2);
  await parser.ensureParserReady();
});

test("initialization keeps a single promise while retrying", async () => {
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  let constructed = 0;
  const isolated = isolatedParser({
    Language: { load: async () => ({}) },
    Parser: class {
      static async init() {
        attempts += 1;
        if (attempts === 1) {
          throw new WebAssembly.RuntimeError("injected initialization failure");
        }
        entered.resolve();
        await release.promise;
      }
      constructor() { constructed += 1; }
      setLanguage() {}
      delete() {}
    }
  });
  const first = isolated.ensureParserReady();
  await entered.promise;
  const second = isolated.ensureParserReady();
  assert.equal(first, second);
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0], results[1]);
  assert.equal(attempts, 2);
  assert.equal(constructed, 1);
  isolated.resetParser();
});

test("reset during initialization prevents obsolete work from publishing", async () => {
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  let constructed = 0;
  const isolated = isolatedParser({
    Language: { load: async () => ({}) },
    Parser: class {
      static async init() {
        attempts += 1;
        if (attempts === 1) {
          entered.resolve();
          await release.promise;
        }
      }
      constructor() { constructed += 1; }
      setLanguage() {}
      delete() {}
    }
  });
  const obsolete = isolated.ensureParserReady();
  await entered.promise;
  isolated.resetParser();
  const current = await isolated.ensureParserReady();
  release.resolve();
  assert.equal(await obsolete, current);
  assert.equal(isolated.getParser(), current);
  assert.equal(constructed, 1);
  isolated.resetParser();
});

test("failed setLanguage never publishes a partially initialized parser", async () => {
  let fail = true;
  let deleted = 0;
  const isolated = isolatedParser({
    Language: { load: async () => ({}) },
    Parser: class {
      static async init() {}
      setLanguage() { if (fail) { throw new Error("invalid grammar"); } }
      delete() { deleted += 1; }
    }
  });
  await assert.rejects(isolated.ensureParserReady(), /invalid grammar/);
  assert.throws(() => isolated.getParser(), /not initialized/);
  assert.equal(deleted, 1);
  fail = false;
  assert.ok(await isolated.ensureParserReady());
  isolated.resetParser();
});
