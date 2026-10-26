"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function createIndex(root, names = ["result"]) {
  const rootFile = path.join(root, "_targets.R");
  return {
    rootFile,
    workspaceRoot: root,
    targets: new Map(names.map((name) => [name, {
      name,
      file: path.join(root, "R", "targets.R"),
      nameRange: { start: { line: 8, character: 4 }, end: { line: 8, character: 4 + name.length } }
    }]))
  };
}

function loadHarness(indices = [createIndex("/workspace/project")]) {
  const state = {
    lookups: [], refreshes: [], refreshAll: 0, opened: [], editors: [],
    picks: [], information: [], errors: [], logs: [], pick: null
  };
  const manager = {
    indices: new Map(indices.map((index) => [index.workspaceRoot, index])),
    async getIndexForUri(uri) {
      state.lookups.push(uri.fsPath);
      return state.getIndex ? state.getIndex(uri) : this.indices.get(path.dirname(uri.fsPath));
    },
    isIndexCurrent(index) { return index.current !== false; },
    async refreshWorkspace(root) {
      state.refreshes.push(root);
      await state.onRefresh?.(root);
    },
    async refreshAll() {
      state.refreshAll += 1;
      await state.onRefreshAll?.();
    }
  };
  const vscode = {
    env: { uriScheme: "positron" },
    Uri: { file(file) { return { scheme: "file", fsPath: file }; } },
    Position: class Position { constructor(line, character) { this.line = line; this.character = character; } },
    Selection: class Selection { constructor(anchor, active) { this.anchor = anchor; this.active = active; } },
    Range: class Range { constructor(start, end) { this.start = start; this.end = end; } },
    TextEditorRevealType: { InCenter: 1 },
    workspace: {
      async openTextDocument(uri) {
        if (state.openError) throw state.openError;
        state.opened.push(uri.fsPath);
        return { uri };
      }
    },
    window: {
      registerUriHandler(handler) {
        state.handler = handler;
        return { disposed: false, dispose() { this.disposed = true; } };
      },
      async showInformationMessage(message) { state.information.push(message); },
      async showErrorMessage(message) { state.errors.push(message); },
      async showQuickPick(items, options) {
        state.picks.push({ items, options });
        return typeof state.pick === "function" ? state.pick(items) : state.pick;
      },
      async showTextDocument(document, options) {
        const editor = { document, options, reveals: [], revealRange(...args) { this.reveals.push(args); } };
        state.editors.push(editor);
        return editor;
      }
    }
  };
  const filename = require.resolve("../../src/visualization/targetNavigation");
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  const localRequire = Module.createRequire(filename);
  instance.require = (name) => name === "vscode" ? vscode : localRequire(name);
  instance._compile(fs.readFileSync(filename, "utf8"), filename);
  const context = { subscriptions: [] };
  const output = { appendLine(message) { state.logs.push(message); } };
  const api = instance.exports;
  api.registerTargetNavigation(context, manager, output);
  return { ...api, state, manager, context, vscode };
}

// VS Code's URI.parse decodes each complete component before handleUri. A
// browser link must preserve the query's encoded values across that first pass.
function hostUri(name, pipeline, overrides = {}) {
  const params = new URLSearchParams({ target: name });
  if (pipeline !== undefined) params.set("pipeline", pipeline);
  const href = `positron://tylermorganwall.tarborist/open-target?${encodeURIComponent(params.toString())}`;
  const url = new URL(href);
  return {
    scheme: url.protocol.slice(0, -1),
    authority: url.host,
    path: url.pathname,
    query: decodeURIComponent(url.search.slice(1)),
    fragment: "",
    ...overrides
  };
}

test("native navigation uses the current indexed location without rebuilding a fresh graph", async () => {
  const harness = loadHarness();
  assert.equal(await harness.openTargetDefinition(harness.manager, "result", { pipelineRoot: "/workspace/project" }), true);
  assert.deepEqual(harness.state.opened, ["/workspace/project/R/targets.R"]);
  assert.deepEqual(harness.state.lookups, ["/workspace/project/_targets.R"]);
  assert.deepEqual(harness.state.refreshes, []);
  assert.equal(harness.state.refreshAll, 0);
  const editor = harness.state.editors[0];
  assert.equal(editor.options.preview, false);
  assert.equal(editor.selection.anchor.line, 8);
  assert.equal(editor.selection.anchor.character, 4);
  assert.equal(editor.reveals[0][1], harness.vscode.TextEditorRevealType.InCenter);
});

test("native navigation refreshes changed editor buffers before selecting the definition", async () => {
  const oldIndex = createIndex("/workspace/project");
  oldIndex.current = false;
  const harness = loadHarness([oldIndex]);
  const newIndex = createIndex("/workspace/project");
  Object.assign(newIndex.targets.get("result"), {
    file: "/workspace/project/R/moved.R",
    nameRange: { start: { line: 40, character: 2 }, end: { line: 40, character: 8 } }
  });
  harness.state.onRefresh = (root) => harness.manager.indices.set(root, newIndex);
  assert.equal(await harness.openTargetDefinition(harness.manager, "result", { pipelineRoot: oldIndex.workspaceRoot }), true);
  assert.deepEqual(harness.state.refreshes, [oldIndex.workspaceRoot]);
  assert.deepEqual(harness.state.opened, ["/workspace/project/R/moved.R"]);
  assert.equal(harness.state.editors[0].selection.anchor.line, 40);
});

test("native navigation stays in its trusted pipeline when a target was removed", async () => {
  const harness = loadHarness([createIndex("/workspace/project", []), createIndex("/workspace/other")]);
  assert.equal(await harness.openTargetDefinition(harness.manager, "result", { pipelineRoot: "/workspace/project" }), false);
  assert.deepEqual(harness.state.opened, []);
  assert.equal(harness.state.refreshAll, 0);
  assert.match(harness.state.information[0], /no longer in this pipeline/);
});

test("generated targets navigate to their generator's source range", async () => {
  const index = createIndex("/workspace/project");
  Object.assign(index.targets.get("result"), {
    generated: true,
    generator: {
      file: "/workspace/project/R/generator.R",
      range: { start: { line: 13, character: 1 }, end: { line: 20, character: 1 } }
    }
  });
  const harness = loadHarness([index]);
  assert.equal(await harness.openTargetDefinition(harness.manager, "result", { pipelineRoot: index.workspaceRoot }), true);
  assert.deepEqual(harness.state.opened, ["/workspace/project/R/generator.R"]);
  assert.equal(harness.state.editors[0].selection.anchor.line, 13);
  assert.equal(harness.state.editors[0].selection.anchor.character, 1);
});

test("a failed fresh index never opens the previous source snapshot", async () => {
  const index = createIndex("/workspace/project");
  index.stale = true;
  const harness = loadHarness([index]);
  assert.equal(await harness.openTargetDefinition(harness.manager, "result", { pipelineRoot: index.workspaceRoot }), false);
  assert.deepEqual(harness.state.refreshes, [index.workspaceRoot]);
  assert.deepEqual(harness.state.opened, []);
  assert.match(harness.state.information[0], /could not be indexed/);
});

test("the current index must still belong to the trusted native root", async () => {
  const harness = loadHarness();
  harness.state.getIndex = () => createIndex("/workspace/other");
  assert.equal(await harness.openTargetDefinition(harness.manager, "result", { pipelineRoot: "/workspace/project" }), false);
  assert.deepEqual(harness.state.opened, []);
});

test("missing or invalid source positions do not open a guessed file location", async () => {
  const index = createIndex("/workspace/project");
  index.targets.get("result").nameRange.start.line = -1;
  const harness = loadHarness([index]);
  assert.equal(await harness.openTargetDefinition(harness.manager, "result", { pipelineRoot: index.workspaceRoot }), false);
  assert.deepEqual(harness.state.opened, []);
  assert.match(harness.state.information[0], /no indexed source location/);
});

test("URI registration belongs to extension subscriptions", () => {
  const harness = loadHarness();
  assert.equal(harness.context.subscriptions.length, 1);
  const registration = harness.context.subscriptions[0];
  registration.dispose();
  assert.equal(registration.disposed, true);
});

test("portable links resolve a single current pipeline and discover newly opened roots", async () => {
  const harness = loadHarness([]);
  const index = createIndex("/workspace/portable-copy");
  harness.state.onRefreshAll = () => harness.manager.indices.set(index.workspaceRoot, index);
  await harness.state.handler.handleUri(hostUri("result", "_targets.R"));
  assert.equal(harness.state.refreshAll, 1);
  assert.deepEqual(harness.state.opened, ["/workspace/portable-copy/R/targets.R"]);
  assert.deepEqual(harness.state.picks, []);
});

test("URI encoding preserves reserved characters and Unicode after the host decodes the query", async () => {
  const name = "result + 50%20 & rate=#\u00e9";
  const index = createIndex("/workspace/A & B+% folder", [name]);
  const harness = loadHarness([index]);
  await harness.state.handler.handleUri(hostUri(name, index.rootFile));
  assert.deepEqual(harness.state.opened, ["/workspace/A & B+% folder/R/targets.R"]);
  assert.deepEqual(harness.state.picks, []);
  assert.deepEqual(harness.state.information, []);
});

test("malformed or unrelated URI requests cannot refresh or open supplied files", async () => {
  const requests = [
    { path: "/open-file" },
    { scheme: "command" },
    { authority: "other.extension" },
    { fragment: "source" },
    { query: "pipeline=_targets.R" },
    { query: "target=" },
    { query: "target=+" },
    { query: "target=result&target=other" },
    { query: "target=result&pipeline=_targets.R&pipeline=other.R" },
    { query: "target=result&pipeline=" },
    { query: "target=result&file=/outside/secret.R&line=99" },
    { query: "target=result&command=workbench.action.closeWindow" }
  ];
  for (const overrides of requests) {
    const harness = loadHarness();
    await harness.state.handler.handleUri(hostUri("result", "_targets.R", overrides));
    assert.equal(harness.state.refreshAll, 0, JSON.stringify(overrides));
    assert.deepEqual(harness.state.opened, [], JSON.stringify(overrides));
    assert.match(harness.state.information[0], /link is invalid/);
  }
});

test("an absolute pipeline hint prefers its exact currently indexed pipeline", async () => {
  const first = createIndex("/workspace/first");
  const second = createIndex("/workspace/second");
  const harness = loadHarness([first, second]);
  await harness.state.handler.handleUri(hostUri("result", second.rootFile));
  assert.deepEqual(harness.state.opened, ["/workspace/second/R/targets.R"]);
  assert.deepEqual(harness.state.picks, []);
});

test("an exact absolute hint with a removed target cannot fall through to another project", async () => {
  const first = createIndex("/workspace/first", []);
  const harness = loadHarness([first, createIndex("/workspace/second")]);
  await harness.state.handler.handleUri(hostUri("result", first.rootFile));
  assert.deepEqual(harness.state.opened, []);
  assert.deepEqual(harness.state.picks, []);
  assert.match(harness.state.information[0], /no longer in this pipeline/);
});

test("a moved absolute pipeline hint requires choosing even one alternate candidate", async () => {
  const harness = loadHarness();
  await harness.state.handler.handleUri(hostUri("result", "/old/location/_targets.R"));
  assert.equal(harness.state.picks.length, 1);
  assert.equal(harness.state.picks[0].items.length, 1);
  assert.match(harness.state.picks[0].options.placeHolder, /original pipeline is not open/);
  assert.deepEqual(harness.state.opened, []);

  harness.state.pick = (items) => items[0];
  await harness.state.handler.handleUri(hostUri("result", "/old/location/_targets.R"));
  assert.deepEqual(harness.state.opened, ["/workspace/project/R/targets.R"]);
});

test("relative pipeline hints select matching indexed paths without resolving against the extension directory", async () => {
  const harness = loadHarness([createIndex("/workspace/project/nested"), createIndex("/workspace/other")]);
  await harness.state.handler.handleUri(hostUri("result", "nested/_targets.R"));
  assert.deepEqual(harness.state.opened, ["/workspace/project/nested/R/targets.R"]);
  assert.deepEqual(harness.state.picks, []);
});

test("ambiguous portable links let the user choose among current pipeline definitions", async () => {
  const harness = loadHarness([createIndex("/workspace/first"), createIndex("/workspace/second")]);
  harness.state.pick = (items) => items[1];
  await harness.state.handler.handleUri(hostUri("result", "_targets.R"));
  assert.equal(harness.state.picks.length, 1);
  assert.deepEqual(harness.state.picks[0].items.map((item) => item.description), [
    "/workspace/first/_targets.R", "/workspace/second/_targets.R"
  ]);
  assert.deepEqual(harness.state.opened, ["/workspace/second/R/targets.R"]);
});

test("an omitted pipeline hint opens only the unambiguous matching target", async () => {
  const harness = loadHarness([createIndex("/workspace/first", ["other"]), createIndex("/workspace/second")]);
  await harness.state.handler.handleUri(hostUri("result"));
  assert.deepEqual(harness.state.opened, ["/workspace/second/R/targets.R"]);
  assert.deepEqual(harness.state.picks, []);
});

test("a definition changed while choosing a pipeline is resolved again from the current index", async () => {
  const harness = loadHarness([createIndex("/workspace/first"), createIndex("/workspace/second")]);
  harness.state.pick = (items) => {
    const updated = createIndex("/workspace/second");
    updated.targets.get("result").file = "/workspace/second/R/new-source.R";
    harness.manager.indices.set(updated.workspaceRoot, updated);
    return items[1];
  };
  await harness.state.handler.handleUri(hostUri("result", "_targets.R"));
  assert.deepEqual(harness.state.opened, ["/workspace/second/R/new-source.R"]);
});

test("links with no matching open pipeline explain how to retry without opening a supplied path", async () => {
  const harness = loadHarness([]);
  await harness.state.handler.handleUri(hostUri("result", "/outside/project/_targets.R"));
  assert.deepEqual(harness.state.opened, []);
  assert.deepEqual(harness.state.lookups, []);
  assert.match(harness.state.information[0], /Open its folder in Positron/);
});

test("URI navigation reports file-open failures without unhandled rejections", async () => {
  const harness = loadHarness();
  harness.state.openError = new Error("Source file is unavailable");
  await harness.state.handler.handleUri(hostUri("result", "_targets.R"));
  assert.match(harness.state.errors[0], /Source file is unavailable/);
  assert.deepEqual(harness.state.logs, harness.state.errors);
  assert.deepEqual(harness.state.editors, []);
});
