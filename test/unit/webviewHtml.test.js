"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { getPipelineGraphHtml } = require("../../src/visualization/webviewHtml");

test("pipeline metadata remains inert JSON even with HTML-like names and commands", () => {
  const graph = {
    rootFile: "/pipeline/_targets.R",
    nodes: [{ id: "n0", name: '</script><script>alert("name")</script>', command: "a < b & c > d" }],
    groups: [{ id: "g0", label: 'a"<img src=x>' }],
    edges: [],
    diagnostics: [{ message: "</script><svg onload=alert(1)>" }]
  };
  const html = getPipelineGraphHtml({
    graph,
    svg: '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "test">\n<svg viewBox="0 0 100 100"></svg>',
    nonce: "example-nonce",
    scriptUri: "vscode-webview://example/script.js",
    styleUri: "vscode-webview://example/style.css",
    cspSource: "vscode-webview://example",
    dot: "digraph { n0; }"
  });
  assert.ok(!html.includes('<?xml'));
  assert.ok(!html.includes('<!DOCTYPE svg'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<svg onload'));
  assert.ok(!html.includes('<img src=x>'));
  const payload = html.match(/<script id="pipeline-data"[^>]*>(.*?)<\/script>/s)[1];
  assert.deepEqual(JSON.parse(payload), { graph, viewGraph: graph, dot: "digraph { n0; }", renderOptions: {}, widthInfo: null });
  assert.match(html, /default-src &#39;none&#39;/);
  assert.match(html, /connect-src &#39;none&#39;/);
  assert.match(html, /nonce="example-nonce"/);
  assert.ok(!html.includes("unsafe-inline"));
  assert.ok(!html.includes("unsafe-eval"));
});

test("standalone documents contain nonce-protected inline assets and portable graph data", () => {
  const html = getPipelineGraphHtml({
    graph: { nodes: [], groups: [], edges: [] },
    svg: '<svg viewBox="0 0 1 1"></svg>',
    nonce: "standalone-nonce",
    scriptText: 'document.body.dataset.ready = "true";',
    styleText: "body { color: #123456; }"
  });
  assert.match(html, /<style nonce="standalone-nonce">body \{ color: #123456; \}<\/style>/);
  assert.match(html, /<script nonce="standalone-nonce">document.body.dataset.ready/);
  assert.ok(!html.includes('src="undefined"'));
  assert.ok(!html.includes('href="undefined"'));
  assert.match(html, /id="graph-viewport"/);
  assert.match(html, /id="open-source"/);
  assert.match(html, /id="target-context-menu"[^>]*role="menu"/);
  assert.match(html, /id="context-open-source"[^>]*role="menuitem"/);
  assert.match(html, /Open definition in Positron/);
  assert.match(html, /id="source-navigation-help"/);
  assert.match(html, /press Shift\+F10/);
  assert.match(html, /id="export-svg"/);
  assert.match(html, /id="upstream-only"/);
  assert.match(html, /id="selection-count"/);
  assert.match(html, /id="selected-targets"/);
  assert.match(html, /Shift-click to add or remove targets/);
  assert.match(html, /id="show-all"/);
  assert.match(html, /id="flow-direction"/);
  assert.match(html, /id="group-details"/);
  assert.match(html, /id="pin-start"/);
  assert.match(html, /id="pin-end"/);
  assert.match(html, /id="clear-group-pin"/);
  assert.match(html, /id="clear-pins"/);
  assert.match(html, /id="reset-layout"/);
  assert.match(html, /id="graph-width" type="number" min="1" max="100000" step="1" placeholder="Automatic"/);
  assert.match(html, /Target graph width \(px\)/);
  assert.match(html, /id="apply-graph-width"/);
  assert.match(html, /id="clear-graph-width"/);
  assert.match(html, /id="graph-width-result"/);
  assert.match(html, /id="group-columns" type="number" min="1" step="1" placeholder="Automatic"/);
  assert.match(html, /id="apply-group-width"/);
  assert.match(html, /id="clear-group-width"/);
  assert.match(html, /remove all pins and width settings/);
});

test("upstream views keep their complete graph separate from the displayed snapshot", () => {
  const graph = { nodes: [{ id: "n0", name: "input" }, { id: "n1", name: "result" }], groups: [], edges: [{ from: "n0", to: "n1" }] };
  const viewGraph = { ...graph, nodes: [graph.nodes[0]], edges: [], upstreamTarget: "input" };
  const html = getPipelineGraphHtml({
    graph,
    viewGraph,
    dot: "filtered DOT",
    svg: "<svg></svg>",
    nonce: "native-nonce",
    scriptUri: "vscode-webview://example/pipelineGraph.js",
    modelScriptUri: "vscode-webview://example/pipelineGraphModel.js",
    styleUri: "vscode-webview://example/pipelineGraph.css",
    cspSource: "vscode-webview://example"
  });
  const payload = JSON.parse(html.match(/<script id="pipeline-data"[^>]*>(.*?)<\/script>/s)[1]);
  assert.deepEqual(payload.graph, graph);
  assert.deepEqual(payload.viewGraph, viewGraph);
  assert.equal(payload.dot, "filtered DOT");
  assert.match(html, /src="vscode-webview:\/\/example\/pipelineGraphModel.js"/);
  assert.match(html, /worker-src &#39;none&#39;/);
  assert.doesNotMatch(html, /wasm-unsafe-eval/);
});

test("offline layout source remains inert and enables only worker and WebAssembly permissions", () => {
  const layoutWorkerText = 'self.postMessage("</script><script>unsafe()</script>");';
  const html = getPipelineGraphHtml({
    graph: { nodes: [], groups: [], edges: [] },
    svg: "<svg></svg>",
    nonce: "offline-nonce",
    scriptText: "initialize();",
    modelScriptText: "const model = {};",
    styleText: "body {}",
    layoutWorkerText,
    renderOptions: { direction: "TB", scaleNodes: true }
  });
  const payload = JSON.parse(html.match(/<script id="pipeline-data"[^>]*>(.*?)<\/script>/s)[1]);
  assert.equal(payload.layoutWorkerText, layoutWorkerText);
  assert.deepEqual(payload.renderOptions, { direction: "TB", scaleNodes: true });
  assert.match(html, /worker-src blob:/);
  assert.match(html, /&#39;wasm-unsafe-eval&#39;/);
  assert.doesNotMatch(html, /&#39;unsafe-eval&#39;/);
  assert.doesNotMatch(html, /<script>unsafe/);
  assert.match(html, /connect-src &#39;none&#39;/);
});

test("layout choices and opaque group keys remain inert in the HTML payload", () => {
  const key = '[["pipeline.R","</script><svg onload=unsafe()>",0]]';
  const graph = { nodes: [], edges: [], groups: [{ id: "g0", key, label: "inputs", parentId: null }] };
  const renderOptions = {
    direction: "TB", startGroup: key, endGroup: null, groupColumns: { [key]: 1 }, graphWidth: 1400, scaleNodes: true
  };
  const widthInfo = { requested: 1400, natural: 920, actual: 1385, limited: false, reason: null };
  const html = getPipelineGraphHtml({
    graph, svg: "<svg></svg>", nonce: "layout-nonce", scriptText: "initialize();", styleText: "body {}", renderOptions, widthInfo
  });
  const payload = JSON.parse(html.match(/<script id="pipeline-data"[^>]*>(.*?)<\/script>/s)[1]);
  assert.deepEqual(payload.renderOptions, renderOptions);
  assert.deepEqual(payload.widthInfo, widthInfo);
  assert.equal(payload.graph.groups[0].key, key);
  assert.doesNotMatch(html, /<svg onload/);
  assert.match(html, /value="LR">Left to right/);
  assert.match(html, /value="TB">Top to bottom/);
  assert.match(html, /value="RL">Right to left/);
  assert.match(html, /value="BT">Bottom to top/);
});
