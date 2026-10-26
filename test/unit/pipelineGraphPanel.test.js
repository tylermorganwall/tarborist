"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

// A completed index fixture keeps the actual graph and HTML builders in scope.
function createIndex(name = "alpha") {
  const root = path.resolve("/workspace/panel-test");
  const file = path.join(root, "_targets.R");
  const range = { start: { line: 3, character: 12 }, end: { line: 3, character: 17 } };
  const target = { name, file, nameRange: range };
  return {
    rootFile: file,
    workspaceRoot: root,
    partial: false,
    targets: new Map([[name, target]]),
    files: new Map([[file, {
      file,
      diagnostics: [],
      lastValue: {
        kind: "TargetList",
        groupOrigin: { label: "targets_part", file, range },
        items: [{ kind: "TargetObject", target }]
      }
    }]]),
    graph: { upstreamToDownstream: new Map([[name, new Set()]]) }
  };
}

function createBranchingIndex(order = ["seed", "left", "right", "result", "downstream", "unrelated"]) {
  const index = createIndex();
  index.targets = new Map(order.map((name, position) => [name, {
    name,
    file: index.rootFile,
    nameRange: { start: { line: position + 2, character: 4 }, end: { line: position + 2, character: 4 + name.length } }
  }]));
  const memberships = [
    ["targets_inputs", ["seed"]],
    ["targets_prepare", ["left", "right"]],
    ["targets_reports", ["result", "downstream"]],
    ["targets_other", ["unrelated"]]
  ];
  index.files.get(index.rootFile).lastValue = {
    kind: "TargetList",
    items: memberships.map(([label, names], position) => ({
      kind: "TargetList",
      groupOrigin: {
        label, file: index.rootFile,
        range: { start: { line: 10 * position, character: 0 }, end: { line: 10 * position, character: label.length } }
      },
      items: names.filter((name) => index.targets.has(name)).map((name) => ({ kind: "TargetObject", target: index.targets.get(name) }))
    }))
  };
  const edges = [["seed", "left"], ["seed", "right"], ["left", "result"], ["right", "result"], ["result", "downstream"]];
  index.graph.upstreamToDownstream = new Map(order.map((name) => [name, new Set()]));
  for (const [from, to] of edges) {
    if (index.targets.has(from) && index.targets.has(to)) index.graph.upstreamToDownstream.get(from).add(to);
  }
  return index;
}

function loadPanelHarness(
  renderSvg = async () => '<svg xmlns="http://www.w3.org/2000/svg"><title>pipeline</title></svg>',
  renderLayout = null
) {
  const index = createIndex();
  const root = index.workspaceRoot;
  const state = {
    panels: [], renders: [], widthRequests: [], refreshes: [], documents: [], editors: [],
    dialogs: [], saveResults: [], writes: [], errors: [], warnings: [], information: [],
    commands: [], logs: []
  };
  const refreshListeners = new Set();
  const removalListeners = new Set();
  const uri = (file) => ({ scheme: "file", fsPath: file, toString() { return `file://${file}`; } });
  const manager = {
    indices: new Map([[root, index]]),
    onDidRefresh(listener) {
      refreshListeners.add(listener);
      return { dispose() { refreshListeners.delete(listener); } };
    },
    onDidRemove(listener) {
      removalListeners.add(listener);
      return { dispose() { removalListeners.delete(listener); } };
    },
    getPipelineRootForUri(file) {
      return [...this.indices.keys()].find((pipelineRoot) => file.fsPath === pipelineRoot || file.fsPath.startsWith(`${pipelineRoot}${path.sep}`)) || null;
    },
    async getIndexForUri(file) { return this.indices.get(this.getPipelineRootForUri(file)); },
    isIndexCurrent(currentIndex) { return !currentIndex?.stale && this.indices.get(currentIndex?.workspaceRoot) === currentIndex; },
    async refreshWorkspace(pipelineRoot) {
      state.refreshes.push(pipelineRoot);
      for (const listener of refreshListeners) listener({ root: pipelineRoot, index: this.indices.get(pipelineRoot) });
    },
    async refreshAll() {
      for (const pipelineRoot of this.indices.keys()) await this.refreshWorkspace(pipelineRoot);
    },
    removeRoot(pipelineRoot) {
      this.indices.delete(pipelineRoot);
      for (const listener of removalListeners) listener({ root: pipelineRoot });
    }
  };
  const vscode = {
    Uri: { file: uri, joinPath(base, ...parts) { return uri(path.join(base.fsPath, ...parts)); } },
    ViewColumn: { Beside: 2 },
    TextEditorRevealType: { InCenter: 1 },
    Position: class Position { constructor(line, character) { this.line = line; this.character = character; } },
    Selection: class Selection { constructor(anchor, active) { this.anchor = anchor; this.active = active; } },
    Range: class Range { constructor(start, end) { this.start = start; this.end = end; } },
    commands: {
      registerCommand(command, handler) {
        const registration = { command, handler, disposed: false, dispose() { this.disposed = true; } };
        state.commands.push(registration);
        return registration;
      }
    },
    window: {
      activeTextEditor: { document: { uri: uri(index.rootFile) } },
      createWebviewPanel(viewType, title, column, options) {
        const disposeListeners = new Set();
        let receiveMessage;
        let html = "";
        const panel = {
          viewType, title, column, options, disposed: false, reveals: [], htmlWrites: [], messages: [],
          reveal(value) { this.reveals.push(value); },
          onDidDispose(listener) { disposeListeners.add(listener); return { dispose() { disposeListeners.delete(listener); } }; },
          dispose() {
            if (this.disposed) return;
            this.disposed = true;
            for (const listener of disposeListeners) listener();
          },
          async post(message) { receiveMessage(message); await new Promise(setImmediate); },
          webview: {
            cspSource: "vscode-webview://panel-test",
            asWebviewUri(value) { return `webview:${value.fsPath}`; },
            onDidReceiveMessage(listener) { receiveMessage = listener; return { dispose() {} }; },
            async postMessage(message) { panel.messages.push(message); return true; },
            get html() { return html; },
            set html(value) { html = value; panel.htmlWrites.push(value); }
          }
        };
        state.panels.push(panel);
        return panel;
      },
      async showTextDocument(document, options) {
        const editor = { document, options, selection: null, reveals: [], revealRange(range, mode) { this.reveals.push({ range, mode }); } };
        state.editors.push(editor);
        return editor;
      },
      async showSaveDialog(options) { state.dialogs.push(options); return state.saveResults.shift(); },
      async showErrorMessage(message) { state.errors.push(message); },
      async showWarningMessage(message) { state.warnings.push(message); },
      async showInformationMessage(message) { state.information.push(message); },
      async showQuickPick() { return undefined; }
    },
    workspace: {
      isTrusted: true,
      async openTextDocument(value) { state.documents.push(value); return { uri: value }; },
      fs: { async writeFile(value, bytes) { state.writes.push({ uri: value, content: Buffer.from(bytes).toString("utf8") }); } }
    }
  };
  const modulePath = require.resolve("../../src/visualization/pipelineGraphPanel");
  const navigationModulePath = path.resolve(__dirname, "../../src/visualization/targetNavigation.js");
  delete require.cache[modulePath];
  delete require.cache[navigationModulePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") return vscode;
    if (request === "./renderGraph" && parent.filename === modulePath) {
      return {
        async renderGraphLayout(dot, graphWidth = null) {
          state.renders.push(dot);
          state.widthRequests.push(graphWidth);
          if (renderLayout) return renderLayout(dot, graphWidth);
          const svg = await renderSvg(dot);
          const widthInfo = graphWidth === null ? null
            : {
              requested: graphWidth, natural: 800, actual: Math.max(800, graphWidth),
              limited: graphWidth < 800, reason: graphWidth < 800 ? "natural-minimum" : null
            };
          return { dot, svg, widthInfo };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let registerPipelineGraphCommand;
  try {
    ({ registerPipelineGraphCommand } = require(modulePath));
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
    delete require.cache[navigationModulePath];
  }
  const context = { extensionUri: uri(path.resolve("/extension/tarborist")), subscriptions: [] };
  const controller = registerPipelineGraphCommand(context, manager, { appendLine(message) { state.logs.push(message); } });
  return { controller, context, manager, state, root, index, uri, refreshListeners, removalListeners };
}

test("graph command opens a real grouped page and reopening reuses one refresh render", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  assert.equal(h.state.commands[0].command, "tarborist.showPipelineGraph");
  assert.equal(h.context.subscriptions[0], h.controller);
  await h.state.commands[0].handler();
  const panel = h.state.panels[0];
  assert.equal(panel.viewType, "tarborist.pipelineGraph");
  assert.equal(panel.options.enableScripts, true);
  assert.match(panel.options.localResourceRoots[0].fsPath, /media$/);
  assert.match(panel.webview.html, /targets_part/);
  assert.match(panel.webview.html, /"name":"alpha"/);
  assert.equal(h.state.renders.length, 1);

  h.manager.indices.set(h.root, createIndex("beta"));
  await h.state.commands[0].handler();
  await new Promise(setImmediate);
  assert.equal(h.state.panels.length, 1);
  assert.deepEqual(panel.reveals, [2]);
  assert.equal(h.state.renders.length, 2);
  assert.match(panel.webview.html, /"name":"beta"/);
  assert.deepEqual(h.state.errors, []);
});

test("source messages resolve only current indexed IDs and ignore supplied file paths", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  await h.controller.open();
  const panel = h.state.panels[0];
  const entry = h.controller.panels.get(h.root);
  await panel.post({ type: "openTarget", id: "unknown", file: "/outside/secret.R" });
  await panel.post({ type: "openTarget", file: "/outside/secret.R" });
  await panel.post({ type: "openFile", file: "/outside/secret.R" });
  assert.equal(h.state.documents.length, 0);

  const renderCount = h.state.renders.length;
  await panel.post({ type: "openTarget", id: entry.graph.nodes[0].id, file: "/outside/secret.R", line: 999 });
  assert.equal(h.state.documents.length, 1);
  assert.equal(h.state.documents[0].fsPath, h.index.rootFile);
  assert.deepEqual({ ...h.state.editors[0].selection.active }, { line: 3, character: 12 });
  assert.equal(h.state.editors[0].options.preview, false);
  assert.equal(h.state.editors[0].reveals[0].mode, 1);
  assert.equal(h.state.renders.length, renderCount);
});

test("source navigation resolves the visible target at its refreshed location even when graph rendering fails", async (t) => {
  let failRender = false;
  const h = loadPanelHarness(async () => {
    if (failRender) throw new Error("graph preview unavailable");
    return '<svg xmlns="http://www.w3.org/2000/svg"><title>published graph</title></svg>';
  });
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  await entry.panel.post({ type: "setUpstreamFilter", names: ["left", "right"] });
  const prepareGroup = entry.graph.groups.find((group) => group.label === "targets_prepare").key;
  await entry.panel.post({ type: "setLayout", direction: "LR", startGroup: null, endGroup: null, groupColumns: { [prepareGroup]: 1 }, graphWidth: 1800 });
  const publishedHtml = entry.panel.webview.html;
  const publishedOptions = entry.renderOptions;
  const originalId = entry.viewGraph.nodes.find((node) => node.name === "right").id;
  const refreshed = createBranchingIndex(["unrelated", "right", "left", "result", "seed", "downstream"]);
  const moved = refreshed.targets.get("right");
  moved.file = path.join(h.root, "R", "moved-subpipeline.R");
  moved.nameRange = { start: { line: 42, character: 7 }, end: { line: 42, character: 12 } };
  h.manager.indices.set(h.root, refreshed);
  failRender = true;
  await assert.rejects(h.controller.render(h.root, refreshed), /graph preview unavailable/);
  await entry.panel.post({ type: "openTarget", id: originalId, file: "/outside/secret.R", line: 999 });
  assert.equal(h.state.documents.length, 1);
  assert.equal(h.state.documents[0].fsPath, moved.file);
  assert.deepEqual({ ...h.state.editors[0].selection.active }, { line: 42, character: 7 });
  assert.equal(entry.panel.webview.html, publishedHtml);
  assert.deepEqual(entry.renderOptions, publishedOptions);
  assert.deepEqual(entry.viewGraph.upstreamTargets, ["left", "right"]);
});

test("source navigation does not open a removed target or fall back to another pipeline", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  const otherRoot = path.join(path.dirname(h.root), "other-panel-pipeline");
  const otherIndex = createIndex("alpha");
  otherIndex.workspaceRoot = otherRoot;
  otherIndex.rootFile = path.join(otherRoot, "_targets.R");
  otherIndex.targets.get("alpha").file = otherIndex.rootFile;
  h.manager.indices.set(otherRoot, otherIndex);
  h.manager.indices.set(h.root, createIndex("replacement"));
  await entry.panel.post({ type: "openTarget", name: "alpha", root: otherRoot, file: otherIndex.rootFile });
  assert.equal(h.state.documents.length, 0);
  assert.equal(h.state.editors.length, 0);
  assert.equal(h.state.refreshes.at(-1), h.root);
  assert.ok(!h.state.refreshes.includes(otherRoot));
});

test("source navigation opens the current generator origin for a generated target", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  const index = createIndex("mapped_north");
  const target = index.targets.get("mapped_north");
  target.generated = true;
  target.generator = {
    file: path.join(h.root, "R", "generated-targets.R"),
    range: { start: { line: 17, character: 2 }, end: { line: 30, character: 1 } }
  };
  h.manager.indices.set(h.root, index);
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  await entry.panel.post({ type: "openTarget", name: target.name, file: "/outside/fake.R", line: 999 });
  assert.equal(h.state.documents.length, 1);
  assert.equal(h.state.documents[0].fsPath, target.generator.file);
  assert.deepEqual({ ...h.state.editors[0].selection.active }, { line: 17, character: 2 });
  assert.equal(h.state.editors[0].options.preview, false);
});

test("refresh updates the page and export messages use the stored graph and chosen destination", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  await h.controller.open();
  const panel = h.state.panels[0];
  h.manager.indices.set(h.root, createIndex("refreshed"));
  await panel.post({ type: "refresh", root: "/unrelated" });
  assert.deepEqual(h.state.refreshes, [h.root, h.root]);
  assert.match(panel.webview.html, /"name":"refreshed"/);

  const entry = h.controller.panels.get(h.root);
  const svgDestination = h.uri(path.join(h.root, "selected.svg"));
  const dotDestination = h.uri(path.join(h.root, "selected.dot"));
  h.state.saveResults.push(svgDestination, dotDestination, undefined);
  await panel.post({ type: "exportSvg", content: "untrusted payload", file: "/outside.svg" });
  await panel.post({ type: "exportDot", content: "untrusted payload", file: "/outside.dot" });
  await panel.post({ type: "exportDot" });
  assert.deepEqual(h.state.writes, [
    { uri: svgDestination, content: entry.svg },
    { uri: dotDestination, content: entry.dot }
  ]);
  assert.equal(h.state.dialogs[0].defaultUri.fsPath, path.join(h.root, "pipeline.svg"));
  assert.deepEqual(h.state.dialogs[0].filters, { "SVG image": ["svg"] });
  assert.deepEqual(h.state.dialogs[1].filters, { "Graphviz DOT": ["dot"] });
});

test("upstream focus publishes only ancestors, validates navigation, and exports the filtered snapshot", async (t) => {
  const h = loadPanelHarness(async (dot) => `<svg xmlns="http://www.w3.org/2000/svg"><desc>${Buffer.from(dot).toString("base64")}</desc></svg>`);
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const panel = h.state.panels[0];
  const entry = h.controller.panels.get(h.root);
  await panel.post({ type: "setUpstreamFilter", name: "result" });

  assert.equal(entry.graph.nodes.length, 6);
  assert.deepEqual(entry.viewGraph.nodes.map((node) => node.name), ["seed", "left", "right", "result"]);
  assert.equal(entry.viewGraph.edges.length, 4);
  assert.deepEqual(entry.viewGraph.groups.map((group) => group.label), ["targets_inputs", "targets_prepare", "targets_reports"]);
  assert.equal(entry.viewGraph.upstreamTarget, "result");
  assert.doesNotMatch(entry.dot, /label="(?:downstream|unrelated|targets_other)"/);
  const payload = JSON.parse(panel.webview.html.match(/<script id="pipeline-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(payload.graph.nodes.length, 6);
  assert.equal(payload.viewGraph.nodes.length, 4);

  const renderCount = h.state.renders.length;
  await panel.post({ type: "setUpstreamFilter", name: "unknown" });
  await panel.post({ type: "setUpstreamFilter", name: { toString: "result" } });
  assert.equal(h.state.renders.length, renderCount);
  await panel.post({ type: "openTarget", name: "downstream", file: "/outside/secret.R" });
  await panel.post({ type: "openTarget", name: "unknown", id: "n0" });
  assert.equal(h.state.documents.length, 0);
  await panel.post({ type: "openTarget", name: "right", file: "/outside/secret.R", line: 999 });
  assert.equal(h.state.documents[0].fsPath, entry.graph.rootFile);
  assert.deepEqual({ ...h.state.editors[0].selection.active }, { line: 4, character: 4 });

  h.state.saveResults.push(h.uri(path.join(h.root, "result.svg")), h.uri(path.join(h.root, "result.dot")));
  await panel.post({ type: "exportSvg", content: "untrusted payload" });
  await panel.post({ type: "exportDot", content: "untrusted payload" });
  assert.equal(h.state.writes[0].content, entry.svg);
  assert.equal(h.state.writes[1].content, entry.dot);
  assert.equal(h.state.dialogs[0].defaultUri.fsPath, path.join(h.root, "pipeline-upstream-result.svg"));
  assert.equal(h.state.dialogs[1].defaultUri.fsPath, path.join(h.root, "pipeline-upstream-result.dot"));

  await panel.post({ type: "setUpstreamFilter", name: null });
  assert.equal(entry.viewGraph.nodes.length, 6);
  assert.equal(entry.viewGraph.upstreamTarget, null);
  assert.match(entry.dot, /unrelated/);
  assert.match(entry.dot, /label="downstream"/);
  assert.deepEqual(h.state.errors, []);
});

test("upstream focus follows the target name through refreshed IDs and clears when it disappears", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const panel = h.state.panels[0];
  const entry = h.controller.panels.get(h.root);
  await panel.post({ type: "setUpstreamFilter", name: "result" });
  const formerId = entry.graph.nodes.find((node) => node.name === "result").id;
  const reordered = createBranchingIndex(["unrelated", "result", "downstream", "right", "left", "seed"]);
  await h.controller.render(h.root, reordered);
  assert.notEqual(entry.graph.nodes.find((node) => node.name === "result").id, formerId);
  assert.equal(entry.viewGraph.upstreamTarget, "result");
  assert.deepEqual(new Set(entry.viewGraph.nodes.map((node) => node.name)), new Set(["seed", "left", "right", "result"]));

  const removed = createBranchingIndex(["seed", "left", "right", "downstream", "unrelated"]);
  await h.controller.render(h.root, removed);
  assert.equal(entry.viewGraph.upstreamTarget, null);
  assert.deepEqual(entry.upstreamTargets, []);
  assert.equal(entry.viewGraph.nodes.length, 5);
  assert.match(entry.dot, /unrelated/);
});

test("multiple upstream roots publish the union once and export the complete selected subgraph", async (t) => {
  const h = loadPanelHarness(async (dot) => `<svg xmlns="http://www.w3.org/2000/svg"><desc>${Buffer.from(dot).toString("base64")}</desc></svg>`);
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const panel = h.state.panels[0];
  const entry = h.controller.panels.get(h.root);
  await panel.post({ type: "setUpstreamFilter", names: ["left", "right", "left"] });

  assert.deepEqual(entry.upstreamTargets, ["left", "right"]);
  assert.deepEqual(entry.viewGraph.upstreamTargets, ["left", "right"]);
  assert.deepEqual(entry.viewGraph.nodes.map((node) => node.name), ["seed", "left", "right"]);
  assert.equal(entry.viewGraph.edges.length, 2);
  assert.deepEqual(entry.viewGraph.groups.map((group) => group.label), ["targets_inputs", "targets_prepare"]);
  assert.doesNotMatch(entry.dot, /label="(?:result|downstream|unrelated|targets_reports|targets_other)"/);
  const payload = JSON.parse(panel.webview.html.match(/<script id="pipeline-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(payload.viewGraph.upstreamTargets, ["left", "right"]);

  const renderCount = h.state.renders.length;
  for (const names of [["left", "unknown"], ["left", 3], [""], "left", null]) {
    await panel.post({ type: "setUpstreamFilter", names });
  }
  assert.equal(h.state.renders.length, renderCount);
  assert.deepEqual(entry.viewGraph.upstreamTargets, ["left", "right"]);
  h.state.saveResults.push(h.uri(path.join(h.root, "combined.svg")), h.uri(path.join(h.root, "combined.dot")));
  await panel.post({ type: "exportSvg" });
  await panel.post({ type: "exportDot" });
  assert.equal(h.state.writes[0].content, entry.svg);
  assert.equal(h.state.writes[1].content, entry.dot);
  assert.equal(h.state.dialogs[0].defaultUri.fsPath, path.join(h.root, "pipeline-upstream-2-targets.svg"));
  assert.equal(h.state.dialogs[1].defaultUri.fsPath, path.join(h.root, "pipeline-upstream-2-targets.dot"));

  // A disjoint selected root is retained too, even without any dependencies.
  await panel.post({ type: "setUpstreamFilter", names: ["result", "unrelated"] });
  assert.deepEqual(entry.viewGraph.nodes.map((node) => node.name), ["seed", "left", "right", "result", "unrelated"]);
  assert.equal(entry.viewGraph.edges.length, 4);
  assert.equal(entry.viewGraph.groups.length, 4);
  assert.doesNotMatch(entry.dot, /label="downstream"/);
  await panel.post({ type: "setUpstreamFilter", names: [] });
  assert.deepEqual(entry.viewGraph.upstreamTargets, []);
  assert.equal(entry.viewGraph.nodes.length, 6);
  assert.deepEqual(h.state.errors, []);
});

test("multiple-root focus survives refreshed IDs and retains only surviving selected names", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  await entry.panel.post({ type: "setUpstreamFilter", names: ["result", "unrelated"] });
  await h.controller.render(h.root, createBranchingIndex(["unrelated", "downstream", "result", "right", "left", "seed"]));
  assert.deepEqual(entry.viewGraph.upstreamTargets, ["result", "unrelated"]);
  assert.deepEqual(new Set(entry.viewGraph.nodes.map((node) => node.name)), new Set(["seed", "left", "right", "result", "unrelated"]));

  await h.controller.render(h.root, createBranchingIndex(["seed", "left", "right", "downstream", "unrelated"]));
  assert.deepEqual(entry.upstreamTargets, ["unrelated"]);
  assert.deepEqual(entry.viewGraph.upstreamTargets, ["unrelated"]);
  assert.deepEqual(entry.viewGraph.nodes.map((node) => node.name), ["unrelated"]);
  assert.equal(entry.viewGraph.edges.length, 0);

  await h.controller.render(h.root, createBranchingIndex(["seed", "left", "right", "downstream"]));
  assert.deepEqual(entry.upstreamTargets, []);
  assert.deepEqual(entry.viewGraph.upstreamTargets, []);
  assert.equal(entry.viewGraph.nodes.length, 4);
});

test("layout direction, pins, columns, and graph width remain committed through filtering, reset, and export", async (t) => {
  const h = loadPanelHarness(async (dot) => `<svg xmlns="http://www.w3.org/2000/svg"><desc>${Buffer.from(dot).toString("base64")}</desc></svg>`);
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  const startGroup = entry.graph.groups.find((group) => group.label === "targets_inputs").key;
  const endGroup = entry.graph.groups.find((group) => group.label === "targets_reports").key;
  const prepareGroup = entry.graph.groups.find((group) => group.label === "targets_prepare").key;
  assert.equal(typeof startGroup, "string");
  assert.equal(typeof endGroup, "string");
  const options = { direction: "TB", startGroup, endGroup, groupColumns: { [prepareGroup]: 1, [endGroup]: 2 }, graphWidth: 1600 };
  await entry.panel.post({ type: "setLayout", ...options });
  assert.deepEqual(entry.layoutOptions, options);
  assert.deepEqual(entry.renderOptions, options);
  assert.match(entry.dot, /rankdir=TB/);
  const payload = JSON.parse(entry.panel.webview.html.match(/<script id="pipeline-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(payload.renderOptions, options);

  await entry.panel.post({ type: "setUpstreamFilter", names: ["seed"] });
  assert.deepEqual(entry.viewGraph.groups.map((group) => group.key), [startGroup]);
  assert.deepEqual(entry.layoutOptions, options);
  assert.deepEqual(entry.renderOptions, options);
  assert.match(entry.dot, /rankdir=TB/);
  assert.doesNotMatch(entry.dot, /label="targets_reports"/);
  await entry.panel.post({ type: "setUpstreamFilter", names: [] });
  assert.deepEqual(entry.renderOptions, options);
  assert.ok(entry.viewGraph.groups.some((group) => group.key === endGroup));
  const exportedDot = entry.dot;
  h.state.saveResults.push(h.uri(path.join(h.root, "pinned.dot")), h.uri(path.join(h.root, "pinned.svg")));
  await entry.panel.post({ type: "exportDot" });
  await entry.panel.post({ type: "exportSvg" });
  assert.equal(h.state.writes[0].content, exportedDot);
  assert.equal(h.state.writes[1].content, entry.svg);

  const renderCount = h.state.renders.length;
  for (const invalid of [
    { direction: "sideways", startGroup, endGroup },
    { direction: "LR", startGroup: 42, endGroup },
    { direction: "LR", startGroup: "unknown-group-key", endGroup }
  ]) {
    await entry.panel.post({ type: "setLayout", ...invalid });
  }
  assert.equal(h.state.renders.length, renderCount);
  assert.deepEqual(entry.renderOptions, options);
  // Older clients omit the column map when changing only pins or direction.
  await entry.panel.post({ type: "setLayout", direction: "LR", startGroup: null, endGroup: null });
  assert.deepEqual(entry.renderOptions, { direction: "LR", startGroup: null, endGroup: null, groupColumns: options.groupColumns, graphWidth: 1600 });
  await entry.panel.post({ type: "setLayout", direction: "LR", startGroup: null, endGroup: null, groupColumns: {}, graphWidth: null });
  assert.deepEqual(entry.renderOptions, { direction: "LR", startGroup: null, endGroup: null, groupColumns: {}, graphWidth: null });
  assert.match(entry.dot, /rankdir=LR/);
  assert.deepEqual(h.state.errors, []);
});

test("column settings reject malformed maps and replace only explicitly supplied maps", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  const prepareGroup = entry.graph.groups.find((group) => group.label === "targets_prepare").key;
  const reportsGroup = entry.graph.groups.find((group) => group.label === "targets_reports").key;
  const options = { direction: "LR", startGroup: null, endGroup: null, groupColumns: { [prepareGroup]: 1, [reportsGroup]: 2 }, graphWidth: null };
  await entry.panel.post({ type: "setLayout", ...options });
  const publishedHtml = entry.panel.webview.html;
  const renderCount = h.state.renders.length;
  const invalidMaps = [
    null, [], 1, "1",
    { [prepareGroup]: 0 }, { [prepareGroup]: -1 }, { [prepareGroup]: 1.5 },
    { [prepareGroup]: "1" }, { [prepareGroup]: null }, { [prepareGroup]: true },
    { [prepareGroup]: NaN }, { [prepareGroup]: Infinity }, { [prepareGroup]: Number.MAX_SAFE_INTEGER + 1 },
    { "unknown-group-key": 1 }, { [prepareGroup]: 1, "unknown-group-key": 2 }
  ];
  for (const groupColumns of invalidMaps) {
    await entry.panel.post({ type: "setLayout", ...options, groupColumns });
  }
  assert.equal(h.state.renders.length, renderCount);
  assert.equal(entry.panel.webview.html, publishedHtml);
  assert.deepEqual(entry.layoutOptions, options);
  assert.deepEqual(entry.renderOptions, options);

  // A supplied map replaces the previous map, so omitted groups return to Automatic.
  await entry.panel.post({ type: "setLayout", ...options, groupColumns: { [prepareGroup]: 2 } });
  assert.deepEqual(entry.renderOptions.groupColumns, { [prepareGroup]: 2 });
  await entry.panel.post({ type: "setLayout", direction: "BT", startGroup: reportsGroup, endGroup: null });
  assert.deepEqual(entry.renderOptions, { direction: "BT", startGroup: reportsGroup, endGroup: null, groupColumns: { [prepareGroup]: 2 }, graphWidth: null });
  await entry.panel.post({ type: "setLayout", direction: "BT", startGroup: reportsGroup, endGroup: null, groupColumns: {} });
  assert.deepEqual(entry.renderOptions, { direction: "BT", startGroup: reportsGroup, endGroup: null, groupColumns: {}, graphWidth: null });
  assert.deepEqual(h.state.errors, []);
});

test("graph width validates its bounds and clears independently of pins and columns", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  assert.equal(entry.renderOptions.graphWidth, null);
  assert.equal(entry.widthInfo, null);
  assert.equal(h.state.widthRequests.at(-1), null);
  const startGroup = entry.graph.groups.find((group) => group.label === "targets_inputs").key;
  const endGroup = entry.graph.groups.find((group) => group.label === "targets_reports").key;
  const prepareGroup = entry.graph.groups.find((group) => group.label === "targets_prepare").key;
  const options = { direction: "LR", startGroup, endGroup, groupColumns: { [prepareGroup]: 1 }, graphWidth: 1600 };
  await entry.panel.post({ type: "setLayout", ...options });
  assert.equal(h.state.widthRequests.at(-1), 1600);
  const publishedHtml = entry.panel.webview.html;
  const renderCount = h.state.renders.length;
  for (const graphWidth of [0, -1, 1.5, "1600", false, {}, [], NaN, Infinity, 100001, Number.MAX_SAFE_INTEGER]) {
    await entry.panel.post({ type: "setLayout", ...options, graphWidth });
  }
  assert.equal(h.state.renders.length, renderCount);
  assert.equal(entry.panel.webview.html, publishedHtml);
  assert.deepEqual(entry.layoutOptions, options);
  assert.deepEqual(entry.renderOptions, options);

  await entry.panel.post({ type: "setLayout", direction: "TB", startGroup, endGroup });
  assert.deepEqual(entry.renderOptions, { ...options, direction: "TB" });
  assert.equal(h.state.widthRequests.at(-1), 1600);
  for (const graphWidth of [1, 100000]) {
    await entry.panel.post({ type: "setLayout", ...options, graphWidth });
    assert.equal(h.state.widthRequests.at(-1), graphWidth);
    assert.equal(entry.renderOptions.graphWidth, graphWidth);
  }
  await entry.panel.post({ type: "setLayout", ...options, graphWidth: null });
  assert.deepEqual(entry.renderOptions, { ...options, graphWidth: null });
  assert.equal(entry.widthInfo, null);
  assert.deepEqual(h.state.errors, []);
});

test("the measured renderer publishes and exports its final DOT, SVG, and width information together", async (t) => {
  const h = loadPanelHarness(undefined, async (dot, graphWidth) => ({
    dot: `${dot}\n// measured width: ${graphWidth}`,
    svg: `<svg xmlns="http://www.w3.org/2000/svg"><title>measured width ${graphWidth}</title></svg>`,
    widthInfo: graphWidth === null ? null : { requested: graphWidth, natural: 900, actual: graphWidth - 12, limited: false, reason: null }
  }));
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  const prepareGroup = entry.graph.groups.find((group) => group.label === "targets_prepare").key;
  const options = { direction: "LR", startGroup: null, endGroup: null, groupColumns: { [prepareGroup]: 1 }, graphWidth: 1800 };
  await entry.panel.post({ type: "setLayout", ...options });
  await entry.panel.post({ type: "setUpstreamFilter", names: ["left", "right"] });
  assert.equal(entry.dot, `${h.state.renders.at(-1)}\n// measured width: 1800`);
  assert.deepEqual(entry.widthInfo, { requested: 1800, natural: 900, actual: 1788, limited: false, reason: null });
  const payload = JSON.parse(entry.panel.webview.html.match(/<script id="pipeline-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(payload.widthInfo, entry.widthInfo);
  assert.deepEqual(payload.renderOptions, options);
  const publishedDot = entry.dot;
  const publishedSvg = entry.svg;
  h.state.saveResults.push(h.uri(path.join(h.root, "measured.svg")));
  await entry.panel.post({ type: "exportSvg" });
  assert.equal(h.state.writes[0].content, publishedSvg);

  let chooseDestination;
  h.state.saveResults.push(new Promise((resolve) => { chooseDestination = resolve; }));
  const exporting = h.controller.receiveMessage(h.root, entry, { type: "exportDot" });
  await entry.panel.post({ type: "setLayout", ...options, graphWidth: 2200 });
  assert.match(entry.dot, /measured width: 2200/);
  assert.equal(entry.widthInfo.actual, 2188);
  chooseDestination(h.uri(path.join(h.root, "previous-measured.dot")));
  await exporting;
  assert.equal(h.state.writes[1].content, publishedDot);
  assert.equal(h.state.dialogs[1].defaultUri.fsPath, path.join(h.root, "pipeline-upstream-2-targets.dot"));
});

test("layout pins and columns follow stable group keys through source reordering and prune removed groups", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  const originalStart = entry.graph.groups.find((group) => group.label === "targets_inputs");
  const originalEnd = entry.graph.groups.find((group) => group.label === "targets_reports");
  const prepareGroup = entry.graph.groups.find((group) => group.label === "targets_prepare").key;
  const options = {
    direction: "TB", startGroup: originalStart.key, endGroup: originalEnd.key,
    groupColumns: { [prepareGroup]: 1, [originalEnd.key]: 2 }, graphWidth: 1600
  };
  await entry.panel.post({ type: "setLayout", ...options });

  const reordered = createBranchingIndex();
  const lists = reordered.files.get(reordered.rootFile).lastValue.items;
  lists.reverse();
  for (const list of lists) {
    list.groupOrigin.range.start.line += 7;
    list.groupOrigin.range.end.line += 7;
  }
  await h.controller.render(h.root, reordered);
  const refreshedStart = entry.graph.groups.find((group) => group.label === "targets_inputs");
  const refreshedEnd = entry.graph.groups.find((group) => group.label === "targets_reports");
  assert.notEqual(refreshedStart.id, originalStart.id);
  assert.equal(refreshedStart.key, originalStart.key);
  assert.equal(refreshedEnd.key, originalEnd.key);
  assert.deepEqual(entry.renderOptions, options);

  await h.controller.render(h.root, createBranchingIndex(["seed", "left", "right", "unrelated"]));
  assert.deepEqual(entry.layoutOptions, { direction: "TB", startGroup: originalStart.key, endGroup: null, groupColumns: { [prepareGroup]: 1 }, graphWidth: 1600 });
  assert.deepEqual(entry.renderOptions, entry.layoutOptions);
  assert.equal(entry.widthInfo.requested, 1600);
  assert.match(entry.dot, /rankdir=TB/);
});

test("incompatible nested pins or columns restore the published layout and upstream focus", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  const index = createBranchingIndex();
  const record = index.files.get(index.rootFile);
  const lists = record.lastValue.items;
  record.lastValue.items = [{
    kind: "TargetList",
    groupOrigin: { label: "targets_bundle", file: index.rootFile, range: { start: { line: 0, character: 0 }, end: { line: 30, character: 0 } } },
    items: lists.slice(0, 2)
  }, ...lists.slice(2)];
  h.manager.indices.set(h.root, index);
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  const parentGroup = entry.graph.groups.find((group) => group.label === "targets_bundle").key;
  const childGroup = entry.graph.groups.find((group) => group.label === "targets_inputs").key;
  await entry.panel.post({ type: "setLayout", direction: "LR", startGroup: null, endGroup: null, groupColumns: { [childGroup]: 1 } });
  await entry.panel.post({ type: "setUpstreamFilter", names: ["left", "right"] });
  const publishedHtml = entry.panel.webview.html;
  const publishedDot = entry.dot;
  const publishedOptions = { ...entry.renderOptions };
  const renderCount = h.state.renders.length;
  for (const invalid of [
    { direction: "TB", startGroup: parentGroup, endGroup: childGroup },
    { direction: "TB", startGroup: null, endGroup: null, groupColumns: { [parentGroup]: 1, [childGroup]: 1 } },
    { direction: "TB", startGroup: childGroup, endGroup: null, groupColumns: { [parentGroup]: 1 } }
  ]) {
    await entry.panel.post({ type: "setLayout", ...invalid });
    assert.equal(h.state.renders.length, renderCount);
    assert.equal(entry.panel.webview.html, publishedHtml);
    assert.equal(entry.dot, publishedDot);
    assert.deepEqual(entry.renderOptions, publishedOptions);
    assert.deepEqual(entry.layoutOptions, publishedOptions);
    assert.deepEqual(entry.upstreamTargets, ["left", "right"]);
    assert.equal(entry.panel.messages.at(-1).type, "filterError");
    assert.match(entry.panel.messages.at(-1).message, /ancestor|nested|contain|overlap/i);
  }
});

test("obsolete layout requests cannot overwrite the latest pins, widths, or exported snapshot", async (t) => {
  const pending = [];
  const h = loadPanelHarness(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  const opening = h.controller.open();
  await new Promise(setImmediate);
  pending[0].resolve('<svg xmlns="http://www.w3.org/2000/svg"><title>full graph</title></svg>');
  await opening;
  const entry = h.controller.panels.get(h.root);
  const startGroup = entry.graph.groups.find((group) => group.label === "targets_inputs").key;
  const endGroup = entry.graph.groups.find((group) => group.label === "targets_reports").key;
  const prepareGroup = entry.graph.groups.find((group) => group.label === "targets_prepare").key;
  const fullDot = entry.dot;
  const older = h.controller.receiveMessage(h.root, entry, { type: "setLayout", direction: "LR", startGroup, endGroup, groupColumns: { [prepareGroup]: 1 }, graphWidth: 1200 });
  h.state.saveResults.push(h.uri(path.join(h.root, "before-layout.dot")));
  await h.controller.receiveMessage(h.root, entry, { type: "exportDot" });
  assert.equal(h.state.writes[0].content, fullDot);
  const latestOptions = { direction: "TB", startGroup, endGroup: null, groupColumns: { [prepareGroup]: 2 }, graphWidth: 1800 };
  const latest = h.controller.receiveMessage(h.root, entry, { type: "setLayout", ...latestOptions });
  pending[2].resolve('<svg xmlns="http://www.w3.org/2000/svg"><title>latest layout</title></svg>');
  await latest;
  const currentHtml = entry.panel.webview.html;
  pending[1].resolve('<svg xmlns="http://www.w3.org/2000/svg"><title>obsolete layout</title></svg>');
  await older;
  assert.equal(entry.panel.webview.html, currentHtml);
  assert.deepEqual(entry.layoutOptions, latestOptions);
  assert.deepEqual(entry.renderOptions, entry.layoutOptions);
  assert.equal(entry.widthInfo.requested, 1800);
  assert.match(entry.dot, /rankdir=TB/);
  assert.match(entry.svg, /latest layout/);
});

test("pending upstream layouts keep exports on the visible snapshot and cannot replace a newer focus", async (t) => {
  const pending = [];
  const h = loadPanelHarness(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  const opening = h.controller.open();
  await new Promise(setImmediate);
  pending[0].resolve('<svg xmlns="http://www.w3.org/2000/svg"><title>full graph</title></svg>');
  await opening;
  const entry = h.controller.panels.get(h.root);
  const fullDot = entry.dot;

  const older = h.controller.receiveMessage(h.root, entry, { type: "setUpstreamFilter", name: "result" });
  assert.equal(pending.length, 2);
  h.state.saveResults.push(h.uri(path.join(h.root, "during-layout.dot")));
  await h.controller.receiveMessage(h.root, entry, { type: "exportDot" });
  assert.equal(h.state.writes[0].content, fullDot);
  assert.equal(h.state.dialogs[0].defaultUri.fsPath, path.join(h.root, "pipeline.dot"));

  const latest = h.controller.receiveMessage(h.root, entry, { type: "setUpstreamFilter", name: "seed" });
  pending[2].resolve('<svg xmlns="http://www.w3.org/2000/svg"><title>seed graph</title></svg>');
  await latest;
  const publishedHtml = entry.panel.webview.html;
  pending[1].resolve('<svg xmlns="http://www.w3.org/2000/svg"><title>obsolete result graph</title></svg>');
  await older;
  assert.equal(entry.viewGraph.upstreamTarget, "seed");
  assert.deepEqual(entry.viewGraph.nodes.map((node) => node.name), ["seed"]);
  assert.equal(entry.panel.webview.html, publishedHtml);
  assert.match(entry.svg, /seed graph/);
  assert.deepEqual(h.state.errors, []);
});

test("an export holds its filtered content while the save dialog waits and the view changes", async (t) => {
  const h = loadPanelHarness();
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  const prepareGroup = entry.graph.groups.find((group) => group.label === "targets_prepare").key;
  await h.controller.receiveMessage(h.root, entry, {
    type: "setLayout", direction: "LR", startGroup: null, endGroup: null, groupColumns: { [prepareGroup]: 1 }, graphWidth: 1400
  });
  await h.controller.receiveMessage(h.root, entry, { type: "setUpstreamFilter", name: "result" });
  const filteredDot = entry.dot;
  let chooseDestination;
  h.state.saveResults.push(new Promise((resolve) => { chooseDestination = resolve; }));
  const exporting = h.controller.receiveMessage(h.root, entry, { type: "exportDot" });
  await h.controller.receiveMessage(h.root, entry, { type: "setUpstreamFilter", name: null });
  await h.controller.receiveMessage(h.root, entry, {
    type: "setLayout", direction: "LR", startGroup: null, endGroup: null, groupColumns: {}, graphWidth: null
  });
  chooseDestination(h.uri(path.join(h.root, "saved-after-reset.dot")));
  await exporting;
  assert.equal(entry.viewGraph.nodes.length, 6);
  assert.equal(h.state.writes[0].content, filteredDot);
  assert.equal(h.state.dialogs[0].defaultUri.fsPath, path.join(h.root, "pipeline-upstream-result.dot"));
});

test("a failed width layout restores the committed widths, pins, filter, and export", async (t) => {
  let fail = false;
  const h = loadPanelHarness(async (dot) => {
    if (fail) throw new Error("column layout failed");
    return `<svg xmlns="http://www.w3.org/2000/svg"><desc>${Buffer.from(dot).toString("base64")}</desc></svg>`;
  });
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  const prepareGroup = entry.graph.groups.find((group) => group.label === "targets_prepare").key;
  const startGroup = entry.graph.groups.find((group) => group.label === "targets_inputs").key;
  const options = { direction: "LR", startGroup, endGroup: null, groupColumns: { [prepareGroup]: 1 }, graphWidth: 1200 };
  await entry.panel.post({ type: "setLayout", ...options });
  await entry.panel.post({ type: "setUpstreamFilter", names: ["left", "right"] });
  const publishedHtml = entry.panel.webview.html;
  const publishedDot = entry.dot;
  const publishedSvg = entry.svg;
  const publishedWidthInfo = { ...entry.widthInfo };
  fail = true;
  await entry.panel.post({ type: "setLayout", ...options, direction: "TB", groupColumns: { [prepareGroup]: 2 }, graphWidth: 1600 });
  assert.equal(entry.panel.webview.html, publishedHtml);
  assert.equal(entry.dot, publishedDot);
  assert.equal(entry.svg, publishedSvg);
  assert.deepEqual(entry.widthInfo, publishedWidthInfo);
  assert.deepEqual(entry.layoutOptions, options);
  assert.deepEqual(entry.renderOptions, options);
  assert.deepEqual(entry.upstreamTargets, ["left", "right"]);
  assert.deepEqual(entry.viewGraph.upstreamTargets, ["left", "right"]);
  assert.equal(entry.panel.messages.at(-1).type, "filterError");
  assert.match(entry.panel.messages.at(-1).message, /column layout failed/);
  h.state.saveResults.push(h.uri(path.join(h.root, "published-columns.dot")), h.uri(path.join(h.root, "published-columns.svg")));
  await entry.panel.post({ type: "exportDot" });
  await entry.panel.post({ type: "exportSvg" });
  assert.equal(h.state.writes[0].content, publishedDot);
  assert.equal(h.state.writes[1].content, publishedSvg);
});

test("a failed upstream layout keeps the published graph and tells the view to restore its controls", async (t) => {
  let fail = false;
  const h = loadPanelHarness(async () => {
    if (fail) throw new Error("filtered layout failed");
    return '<svg xmlns="http://www.w3.org/2000/svg"><title>published graph</title></svg>';
  });
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  await entry.panel.post({ type: "setUpstreamFilter", name: "result" });
  const publishedHtml = entry.panel.webview.html;
  fail = true;
  await entry.panel.post({ type: "setUpstreamFilter", name: "seed" });
  assert.equal(entry.panel.webview.html, publishedHtml);
  assert.equal(entry.viewGraph.upstreamTarget, "result");
  assert.deepEqual(entry.upstreamTargets, ["result"]);
  assert.equal(entry.panel.messages.at(-1).type, "filterError");
  assert.match(entry.panel.messages.at(-1).message, /filtered layout failed/);
});

test("a removed target or group still visible after a failed refresh releases pending controls", async (t) => {
  let fail = false;
  const h = loadPanelHarness(async () => {
    if (fail) throw new Error("refreshed layout failed");
    return '<svg xmlns="http://www.w3.org/2000/svg"><title>published graph</title></svg>';
  });
  t.after(() => h.controller.dispose());
  h.manager.indices.set(h.root, createBranchingIndex());
  await h.controller.open();
  const entry = h.controller.panels.get(h.root);
  const publishedHtml = entry.panel.webview.html;
  fail = true;
  await assert.rejects(h.controller.render(h.root, createIndex("fresh")), /refreshed layout failed/);
  const renderCount = h.state.renders.length;
  const messageCount = entry.panel.messages.length;
  await entry.panel.post({ type: "setUpstreamFilter", name: "result" });
  assert.equal(h.state.renders.length, renderCount);
  assert.equal(entry.panel.webview.html, publishedHtml);
  assert.equal(entry.panel.messages.length, messageCount + 1);
  assert.equal(entry.panel.messages.at(-1).type, "filterError");
  assert.match(entry.panel.messages.at(-1).message, /no longer|current/i);
  const staleGroup = entry.graph.groups[0].key;
  await entry.panel.post({ type: "setLayout", direction: "LR", startGroup: staleGroup, endGroup: null });
  assert.equal(h.state.renders.length, renderCount);
  assert.equal(entry.panel.webview.html, publishedHtml);
  assert.equal(entry.panel.messages.length, messageCount + 2);
  assert.equal(entry.panel.messages.at(-1).type, "filterError");
  assert.match(entry.panel.messages.at(-1).message, /no longer|current/i);
  await entry.panel.post({ type: "setLayout", direction: "LR", startGroup: null, endGroup: null, groupColumns: { [staleGroup]: 1 } });
  assert.equal(h.state.renders.length, renderCount);
  assert.equal(entry.panel.webview.html, publishedHtml);
  assert.equal(entry.panel.messages.length, messageCount + 3);
  assert.equal(entry.panel.messages.at(-1).type, "filterError");
  assert.match(entry.panel.messages.at(-1).message, /no longer|current/i);
});

test("an older asynchronous layout cannot replace a newer graph", async (t) => {
  const pending = [];
  const h = loadPanelHarness(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  t.after(() => h.controller.dispose());
  const opening = h.controller.open();
  await new Promise(setImmediate);
  assert.equal(pending.length, 1);
  const panel = h.state.panels[0];

  const latest = h.controller.render(h.root, createIndex("latest"));
  assert.equal(pending.length, 2);
  pending[1].resolve('<svg xmlns="http://www.w3.org/2000/svg"><title>new layout</title></svg>');
  await latest;
  const currentHtml = panel.webview.html;
  pending[0].resolve('<svg xmlns="http://www.w3.org/2000/svg"><title>old layout</title></svg>');
  await opening;
  assert.equal(panel.htmlWrites.length, 1);
  assert.equal(panel.webview.html, currentHtml);
  assert.equal(h.controller.panels.get(h.root).graph.nodes[0].name, "latest");
  assert.match(currentHtml, /new layout/);
});

test("root removal closes the page and suppresses pending layouts and old messages", async (t) => {
  const pending = [];
  const h = loadPanelHarness(() => new Promise((resolve) => pending.push(resolve)));
  t.after(() => h.controller.dispose());
  const opening = h.controller.open();
  await new Promise(setImmediate);
  const panel = h.state.panels[0];
  h.manager.removeRoot(h.root);
  assert.equal(panel.disposed, true);
  assert.equal(h.controller.panels.size, 0);
  pending[0]('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await opening;
  await panel.post({ type: "refresh" });
  await panel.post({ type: "openTarget", id: "n0" });
  await panel.post({ type: "exportSvg" });
  assert.equal(panel.htmlWrites.length, 0);
  assert.deepEqual(h.state.refreshes, [h.root]);
  assert.equal(h.state.documents.length, 0);
  assert.equal(h.state.dialogs.length, 0);
});

test("an obsolete layout failure does not interrupt the current graph", async (t) => {
  const pending = [];
  const h = loadPanelHarness(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  t.after(() => h.controller.dispose());
  const opening = h.state.commands[0].handler();
  await new Promise(setImmediate);
  const latest = h.controller.render(h.root, createIndex("latest"));
  pending[1].resolve('<svg xmlns="http://www.w3.org/2000/svg"><title>new layout</title></svg>');
  await latest;
  pending[0].reject(new Error("obsolete layout failed"));
  await opening;
  assert.deepEqual(h.state.errors, []);
  assert.equal(h.controller.panels.get(h.root).graph.nodes[0].name, "latest");
});

test("controller disposal closes pages and releases index listeners", async () => {
  const h = loadPanelHarness();
  await h.controller.open();
  const panel = h.state.panels[0];
  assert.equal(h.refreshListeners.size, 1);
  assert.equal(h.removalListeners.size, 1);
  h.controller.dispose();
  assert.equal(panel.disposed, true);
  assert.equal(h.controller.panels.size, 0);
  assert.equal(h.refreshListeners.size, 0);
  assert.equal(h.removalListeners.size, 0);
  await panel.post({ type: "refresh" });
  assert.deepEqual(h.state.refreshes, [h.root]);
});

test("render failures are reported through the registered command", async (t) => {
  const h = loadPanelHarness(async () => { throw new Error("layout failed"); });
  t.after(() => h.controller.dispose());
  await h.state.commands[0].handler();
  assert.equal(h.state.errors.length, 1);
  assert.match(h.state.errors[0], /layout failed/);
  assert.deepEqual(h.state.logs, h.state.errors);
  assert.equal(h.state.panels[0].htmlWrites.length, 0);
});
