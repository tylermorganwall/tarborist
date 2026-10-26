"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { buildGraphDot, filterGraphUpstream, validateGraphLayout, renderGraphLayout } = require("../../media/pipelineGraphModel");

function exampleGraph() {
  const groups = [
    { id: "g0", label: "unrelated_pipeline", parentId: null },
    { id: "g1", label: "analysis", parentId: null },
    { id: "g2", label: "inputs", parentId: "g1" },
    { id: "g3", label: "models", parentId: "g1" },
    { id: "g4", label: "reports", parentId: null },
    { id: "g5", label: "side_pipeline", parentId: "g1" }
  ].map((group) => ({ ...group, key: group.label }));
  const nodes = [
    { id: "n0", name: "unrelated_target", groupId: "g0" },
    { id: "n1", name: "raw", groupId: "g2" },
    { id: "n2", name: "left", groupId: "g3" },
    { id: "n3", name: "right", groupId: "g3" },
    { id: "n4", name: "fit", groupId: "g4" },
    { id: "n5", name: "downstream_target", groupId: "g4" },
    { id: "n6", name: "isolated", groupId: null },
    { id: "n7", name: "side_target", groupId: "g5" }
  ].map((node) => ({ ...node, status: "built", file: "/project/_targets.R", line: 1, inDegree: 0, outDegree: 0 }));
  const edges = [
    { from: "n1", to: "n2" },
    { from: "n1", to: "n3" },
    { from: "n2", to: "n4" },
    { from: "n3", to: "n4" },
    { from: "n4", to: "n5" },
    { from: "n1", to: "n7" }
  ];
  for (const edge of edges) {
    nodes.find((node) => node.id === edge.from).outDegree += 1;
    nodes.find((node) => node.id === edge.to).inDegree += 1;
  }
  return {
    rootFile: "/project/_targets.R",
    workspaceRoot: "/project",
    graphSource: "static",
    statusSource: "last recorded build",
    partial: true,
    diagnostics: [{ message: "A source expression could not be resolved." }],
    groups,
    nodes,
    edges
  };
}

function namedEdges(graph) {
  const names = new Map(graph.nodes.map((node) => [node.id, node.name]));
  return graph.edges.map((edge) => [names.get(edge.from), names.get(edge.to)]);
}

function columnGraph() {
  const groups = ["inputs", "prepare", "models", "reports"]
    .map((label, index) => ({ id: `g${index}`, key: label, label, parentId: null }));
  const nodes = [["raw", 0], ["clean_data", 1], ["training_rows", 1], ["training_data", 1],
    ["test_data", 1], ["model", 2], ["report", 3]]
    .map(([name, group], index) => ({ id: `n${index}`, name, groupId: `g${group}`, status: "unbuilt", inDegree: 0, outDegree: 0 }));
  const edges = [[0, 1], [1, 2], [2, 3], [2, 4], [3, 5], [4, 5], [5, 6]]
    .map(([from, to]) => ({ from: `n${from}`, to: `n${to}` }));
  for (const edge of edges) {
    nodes.find((node) => node.id === edge.from).outDegree += 1;
    nodes.find((node) => node.id === edge.to).inDegree += 1;
  }
  return { graphSource: "static", nodes, edges, groups };
}

test("upstream filtering keeps the focus and every ancestor across a diamond", () => {
  const original = exampleGraph();
  const snapshot = JSON.stringify(original);
  const filtered = filterGraphUpstream(original, "fit");

  assert.equal(filtered.upstreamTarget, "fit");
  assert.deepEqual(filtered.upstreamTargets, ["fit"]);
  assert.deepEqual(filtered.nodes.map((node) => node.name), ["raw", "left", "right", "fit"]);
  assert.deepEqual(namedEdges(filtered), [["raw", "left"], ["raw", "right"], ["left", "fit"], ["right", "fit"]]);
  assert.deepEqual(filtered.nodes.map((node) => node.id), ["n0", "n1", "n2", "n3"]);
  assert.deepEqual(filtered.nodes.map((node) => [node.inDegree, node.outDegree]), [[0, 2], [1, 1], [1, 1], [2, 0]]);
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(filtered.partial, true);
  assert.equal(filtered.statusSource, original.statusSource);
  assert.deepEqual(filtered.diagnostics, original.diagnostics);
  assert.ok(filtered.nodes.every((node) => node.status === "built" && node.file === original.rootFile));
});

test("multiple targets retain disjoint branches and shared ancestors exactly once", () => {
  const original = exampleGraph();
  const snapshot = JSON.stringify(original);
  const selected = Object.freeze(["right", "unrelated_target", "left", "right"]);
  const filtered = filterGraphUpstream(original, selected);

  assert.deepEqual(filtered.upstreamTargets, ["right", "unrelated_target", "left"]);
  assert.equal(filtered.upstreamTarget, null);
  assert.deepEqual(filtered.nodes.map((node) => node.name), ["unrelated_target", "raw", "left", "right"]);
  assert.deepEqual(namedEdges(filtered), [["raw", "left"], ["raw", "right"]]);
  assert.deepEqual(filtered.groups.map((group) => group.label), ["unrelated_pipeline", "analysis", "inputs", "models"]);
  assert.deepEqual(filtered.nodes.map((node) => [node.inDegree, node.outDegree]), [[0, 0], [0, 2], [1, 0], [1, 0]]);
  assert.equal(JSON.stringify(original), snapshot);
  assert.deepEqual(selected, ["right", "unrelated_target", "left", "right"]);
});

test("selecting an ancestor and its descendant preserves both focus names without duplicate topology", () => {
  const original = exampleGraph();
  const filtered = filterGraphUpstream(original, ["raw", "fit"]);
  const descendantOnly = filterGraphUpstream(original, "fit");
  assert.deepEqual(filtered.upstreamTargets, ["raw", "fit"]);
  assert.deepEqual(filtered.nodes, descendantOnly.nodes);
  assert.deepEqual(filtered.edges, descendantOnly.edges);
  assert.deepEqual(filtered.groups, descendantOnly.groups);
});

test("filtered groups retain nesting and discard empty siblings regardless of source order", () => {
  const original = exampleGraph();
  original.groups.reverse();
  const filtered = filterGraphUpstream(original, "fit");
  const groupsById = new Map(filtered.groups.map((group) => [group.id, group]));
  assert.deepEqual(filtered.groups.map((group) => group.label), ["reports", "models", "inputs", "analysis"]);
  for (const node of filtered.nodes) {
    const group = groupsById.get(node.groupId);
    assert.equal(group.label, node.name === "raw" ? "inputs" : node.name === "fit" ? "reports" : "models");
    if (group.label !== "reports") {
      assert.equal(groupsById.get(group.parentId).label, "analysis");
    }
  }
  assert.doesNotThrow(() => buildGraphDot(filtered));
});

test("a target with no inputs remains visible and an ungrouped target creates no clusters", () => {
  const graph = exampleGraph();
  const root = filterGraphUpstream(graph, "raw");
  assert.deepEqual(root.nodes.map((node) => node.name), ["raw"]);
  assert.deepEqual(root.edges, []);
  assert.deepEqual(root.groups.map((group) => group.label), ["analysis", "inputs"]);
  const isolated = filterGraphUpstream(graph, "isolated");
  assert.deepEqual(isolated.nodes.map((node) => node.name), ["isolated"]);
  assert.deepEqual(isolated.edges, []);
  assert.deepEqual(isolated.groups, []);
  assert.equal(isolated.nodes[0].groupId, null);
});

test("surviving subpipelines keep their colors after pruning and reindexing", () => {
  const original = exampleGraph();
  const filtered = filterGraphUpstream(original, "raw");
  const originalDot = buildGraphDot(original);
  const filteredDot = buildGraphDot(filtered);
  for (const label of ["analysis", "inputs"]) {
    const colorPattern = new RegExp(`label="${label}",\\s+style="rounded,filled", color="([^"]+)", fillcolor="([^"]+)"`);
    assert.deepEqual(filteredDot.match(colorPattern)?.slice(1), originalDot.match(colorPattern)?.slice(1));
    assert.ok(filteredDot.match(colorPattern));
  }
  assert.deepEqual(filtered.groups.map((group) => group.colorIndex), [1, 2]);
  assert.deepEqual(filterGraphUpstream(filtered, "raw").groups.map((group) => group.colorIndex), [1, 2]);
  filtered.groups[0].colorIndex = -1;
  assert.match(buildGraphDot(filtered), /label="analysis",\s+style="rounded,filled", color="#9FBDE0", fillcolor="#EDF5FF"/);
});

test("upstream traversal terminates on cycles and keeps all contributing edges", () => {
  const graph = exampleGraph();
  graph.edges.push({ from: "n4", to: "n2" });
  const filtered = filterGraphUpstream(graph, "fit");
  assert.deepEqual(filtered.nodes.map((node) => node.name), ["raw", "left", "right", "fit"]);
  assert.deepEqual(namedEdges(filtered).at(-1), ["fit", "left"]);
  assert.equal(filtered.edges.length, 5);
  assert.equal(filtered.nodes.find((node) => node.name === "left").inDegree, 2);
});

test("clearing upstream selection returns the complete graph without changing its snapshot", () => {
  const original = exampleGraph();
  const full = filterGraphUpstream(original, null);
  assert.equal(full.upstreamTarget, null);
  assert.deepEqual(full.upstreamTargets, []);
  assert.deepEqual(full.nodes, original.nodes);
  assert.deepEqual(full.groups, original.groups);
  assert.deepEqual(full.edges, original.edges);
  assert.equal(original.upstreamTarget, undefined);
  assert.deepEqual(filterGraphUpstream(original), full);
  assert.deepEqual(filterGraphUpstream(original, []), full);
});

test("unknown selections and malformed edges fail instead of exporting a misleading graph", () => {
  const graph = exampleGraph();
  assert.throws(() => filterGraphUpstream(graph, "missing"), /Unknown target/);
  assert.throws(() => filterGraphUpstream(graph, ["fit", "missing"]), /Unknown target "missing"/);
  for (const selection of ["", 4, {}, ["fit", ""], ["fit", null], ["fit", 4], [["fit"]]]) {
    assert.throws(() => filterGraphUpstream(graph, selection), /nonempty target name/);
  }
  graph.edges.push({ from: "missing", to: "n4" });
  assert.throws(() => filterGraphUpstream(graph, "fit"), /existing node IDs/);
});

test("filtered DOT and SVG contain the exact visible topology with no unrelated targets", async () => {
  const filtered = filterGraphUpstream(exampleGraph(), "fit");
  const dot = buildGraphDot(filtered, { legend: false });
  assert.match(dot, /Upstream of fit/);
  assert.doesNotMatch(dot, /unrelated_target|downstream_target|side_target|isolated|unrelated_pipeline|side_pipeline/);
  assert.equal((dot.match(/id="node_n\d+"/g) || []).length, 4);
  assert.equal((dot.match(/n\d+ -> n\d+;/g) || []).length, 4);
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  const result = viz.render(dot, { format: "svg" });
  assert.equal(result.status, "success", JSON.stringify(result.errors));
  assert.equal((result.output.match(/id="node_n\d+"/g) || []).length, 4);
  assert.equal((result.output.match(/class="edge"/g) || []).length, 4);
  assert.doesNotMatch(result.output, /unrelated_target|downstream_target|side_target|isolated/);
});

test("multi-target DOT and SVG export the union and identify every selected target", async () => {
  const filtered = filterGraphUpstream(exampleGraph(), ["left", "right", "isolated"]);
  const dot = buildGraphDot(filtered, { legend: false });
  assert.match(dot, /Upstream of 3 targets\\nleft\\nright\\nisolated/);
  assert.doesNotMatch(dot, /unrelated_target|downstream_target|side_target|label="fit"|unrelated_pipeline|side_pipeline/);
  assert.equal((dot.match(/id="node_n\d+"/g) || []).length, 4);
  assert.equal((dot.match(/n\d+ -> n\d+;/g) || []).length, 2);
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  const result = viz.render(dot, { format: "svg" });
  assert.equal(result.status, "success", JSON.stringify(result.errors));
  assert.equal((result.output.match(/id="node_n\d+"/g) || []).length, 4);
  assert.equal((result.output.match(/class="edge"/g) || []).length, 2);
  assert.doesNotMatch(result.output, /unrelated_target|downstream_target|side_target|>fit</);
});

test("many selected targets use a compact caption with the complete focus metadata", () => {
  const original = exampleGraph();
  const selected = original.nodes.map((node) => node.name);
  const filtered = filterGraphUpstream(original, selected);
  const dot = buildGraphDot(filtered);
  assert.deepEqual(filtered.upstreamTargets, selected);
  assert.match(dot, /Upstream of 8 targets\\nunrelated_target\\nraw\\nleft\\nright\\nand 4 more selected targets/);
});

test("the same graph model runs in a browser without Node globals", () => {
  const context = vm.createContext({});
  const code = fs.readFileSync(path.join(__dirname, "../../media/pipelineGraphModel.js"), "utf8");
  vm.runInContext(code, context);
  const filtered = context.TarboristGraphModel.filterGraphUpstream(exampleGraph(), ["fit", "isolated"]);
  assert.equal(JSON.stringify(filtered), JSON.stringify(filterGraphUpstream(exampleGraph(), ["fit", "isolated"])));
  assert.equal(context.TarboristGraphModel.buildGraphDot(filtered), buildGraphDot(filtered));
  const layout = { direction: "TB", groupColumns: { models: 1 }, startGroup: "inputs" };
  assert.equal(context.TarboristGraphModel.buildGraphDot(filtered, layout), buildGraphDot(filtered, layout));
  assert.equal(JSON.stringify(context.TarboristGraphModel.validateGraphLayout(exampleGraph(), { startGroup: "inputs" })),
    JSON.stringify(validateGraphLayout(exampleGraph(), { startGroup: "inputs" })));
});

test("layout options reject unknown groups and contradictory nested positions", () => {
  const graph = exampleGraph();
  assert.deepEqual(validateGraphLayout(graph), { direction: "LR", startGroup: null, endGroup: null, groupColumns: {}, graphWidth: null });
  assert.throws(() => validateGraphLayout(graph, { startGroup: "missing" }), /not in the current pipeline/);
  assert.throws(() => validateGraphLayout(graph, { direction: "sideways" }), /direction must be/);
  assert.throws(() => validateGraphLayout(graph, { startGroup: {} }), /group key or null/);
  for (const [startGroup, endGroup] of [["inputs", "inputs"], ["analysis", "inputs"], ["models", "analysis"]]) {
    assert.throws(() => validateGraphLayout(graph, { startGroup, endGroup }), /different, non-nested groups/);
  }
  assert.doesNotThrow(() => validateGraphLayout(graph, { startGroup: "inputs", endGroup: "models" }));
});

test("hidden group positions are dormant in an upstream view and survive reindexing", () => {
  const graph = exampleGraph();
  const options = { startGroup: "unrelated_pipeline", endGroup: "reports", legend: false };
  const subset = filterGraphUpstream(graph, "raw");
  assert.doesNotThrow(() => validateGraphLayout(graph, options));
  assert.doesNotMatch(buildGraphDot(subset, options), /layout_(?:start|end)_boundary/);
  assert.match(buildGraphDot(graph, options), /layout_start_boundary/);
  assert.match(buildGraphDot(graph, options), /layout_end_boundary/);
  const selectedGroups = filterGraphUpstream(graph, "fit").groups;
  for (const group of selectedGroups) {
    assert.equal(group.key, graph.groups.find((original) => original.label === group.label).key);
  }
  const empty = { ...graph, nodes: [], groups: [], edges: [] };
  assert.doesNotThrow(() => buildGraphDot(empty, options));
});

test("pinned whole clusters occupy opposing ends without changing dependency topology", async () => {
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  const graph = exampleGraph();
  const snapshot = JSON.stringify(graph);
  const byId = new Map(graph.groups.map((group) => [group.id, group]));
  function belongsTo(id, ancestor) {
    while (id !== null) {
      if (id === ancestor) return true;
      id = byId.get(id).parentId;
    }
    return false;
  }
  function rankInterval(box, direction) {
    const [x0, y0, x1, y1] = box;
    return direction === "LR" ? [x0, x1] : direction === "RL" ? [-x1, -x0]
      : direction === "TB" ? [-y1, -y0] : [y0, y1];
  }
  for (const direction of ["LR", "TB", "RL", "BT"]) {
    // The reversed case intentionally places input boxes after their consumers.
    for (const [startGroup, endGroup] of [["inputs", "reports"], ["models", "inputs"]]) {
      const dot = buildGraphDot(graph, { direction, startGroup, endGroup, legend: false });
      const rendered = JSON.parse(viz.renderString(dot, { format: "json" }));
      const objects = new Map(rendered.objects.map((object) => [object.name, object]));
      for (const [key, isStart] of [[startGroup, true], [endGroup, false]]) {
        const pinned = graph.groups.find((group) => group.key === key);
        const pinnedBox = rankInterval(objects.get(`cluster_${pinned.id}`).bb.split(",").map(Number), direction);
        for (const group of graph.groups) {
          if (belongsTo(group.id, pinned.id) || belongsTo(pinned.id, group.id)) continue;
          const box = rankInterval(objects.get(`cluster_${group.id}`).bb.split(",").map(Number), direction);
          assert.ok(isStart ? pinnedBox[1] < box[0] : pinnedBox[0] > box[1], `${direction}: ${key} vs ${group.label}`);
        }
        for (const node of graph.nodes) {
          if (belongsTo(node.groupId, pinned.id)) continue;
          const object = objects.get(node.id);
          const [x, y] = object.pos.split(",").map(Number);
          const halfWidth = Number(object.width) * 36;
          const halfHeight = Number(object.height) * 36;
          const box = rankInterval([x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight], direction);
          assert.ok(isStart ? pinnedBox[1] < box[0] : pinnedBox[0] > box[1], `${direction}: ${key} vs ${node.name}`);
        }
      }
      const svg = viz.renderString(dot, { format: "svg" });
      assert.equal((svg.match(/id="node_n\d+"/g) || []).length, graph.nodes.length);
      assert.equal((svg.match(/class="edge"/g) || []).length, graph.edges.length);
      // Graphviz leaves comments for invisible elements, but no drawing groups.
      assert.doesNotMatch(svg.replace(/<!--[\s\S]*?-->/g, ""), /layout_(?:start|end)_boundary/);
      assert.deepEqual([...dot.matchAll(/^\s+(n\d+) -> (n\d+)(?: \[constraint=false\])?;/gm)].map((match) => [match[1], match[2]]),
        graph.edges.map((edge) => [edge.from, edge.to]));
    }
  }
  assert.equal(JSON.stringify(graph), snapshot);
});

test("a single disconnected group position works with wide labels and nested siblings", async () => {
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  const graph = exampleGraph();
  graph.groups[0].label = "A long disconnected subpipeline label ".repeat(5);
  for (const [direction, option] of [["LR", "startGroup"], ["TB", "endGroup"]]) {
    const dot = buildGraphDot(graph, { direction, [option]: "unrelated_pipeline", legend: false });
    const rendered = JSON.parse(viz.renderString(dot, { format: "json" }));
    const objects = new Map(rendered.objects.map((object) => [object.name, object]));
    const pinned = objects.get("cluster_g0").bb.split(",").map(Number);
    for (const group of graph.groups.slice(1)) {
      const box = objects.get(`cluster_${group.id}`).bb.split(",").map(Number);
      assert.ok(direction === "LR" ? pinned[2] < box[0] : pinned[3] < box[1]);
    }
  }
});

test("column settings validate stable keys, clone input, and reject incompatible nested choices", () => {
  const graph = exampleGraph();
  const columns = { models: 2, reports: 1 };
  const validated = validateGraphLayout(graph, { groupColumns: columns });
  assert.deepEqual(validated.groupColumns, columns);
  assert.notEqual(validated.groupColumns, columns);
  columns.models = 5;
  assert.equal(validated.groupColumns.models, 2);
  for (const value of [null, [], "1", new Date(), { models: 0 }, { models: -1 }, { models: 1.5 },
    { models: "2" }, { models: NaN }, { models: Infinity }, { models: Number.MAX_SAFE_INTEGER + 1 }, { "": 1 }]) {
    assert.throws(() => validateGraphLayout(graph, { groupColumns: value }), /positive integers/);
  }
  assert.throws(() => validateGraphLayout(graph, { groupColumns: { missing: 1 } }), /not in the current pipeline/);
  assert.throws(() => validateGraphLayout(graph, { groupColumns: { analysis: 1, models: 2 } }), /either a subpipeline or its nested groups/);
  assert.throws(() => validateGraphLayout(graph, { groupColumns: { analysis: 1 }, startGroup: "inputs" }), /positioned nested subpipeline/);
  assert.doesNotThrow(() => validateGraphLayout(graph, { groupColumns: { inputs: 1 }, startGroup: "analysis" }));
  assert.doesNotThrow(() => validateGraphLayout(graph, { groupColumns: { analysis: 1 }, startGroup: "analysis" }));
  assert.doesNotThrow(() => validateGraphLayout(graph, { groupColumns: { models: Number.MAX_SAFE_INTEGER } }));
});

test("column settings remain dormant during filtering and follow surviving stable group keys", () => {
  const graph = columnGraph();
  const options = { groupColumns: { prepare: 1, reports: 2 }, legend: false };
  const rawOnly = filterGraphUpstream(graph, "raw");
  assert.equal(buildGraphDot(rawOnly, options), buildGraphDot(rawOnly, { legend: false }));
  const trainingOnly = filterGraphUpstream(graph, "training_data");
  assert.match(buildGraphDot(trainingOnly, options), /rank=same; n1; n2; n3;/);
  assert.deepEqual(options.groupColumns, { prepare: 1, reports: 2 });
  assert.doesNotThrow(() => buildGraphDot({ ...graph, nodes: [], edges: [], groups: [] }, options));
});

test("column reflow changes geometry rather than text size and preserves pins and exported arrows", async () => {
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  const graph = columnGraph();
  const snapshot = JSON.stringify(graph);
  const members = graph.nodes.filter((node) => node.groupId === "g1");
  for (const direction of ["LR", "RL", "TB", "BT"]) {
    const options = { direction, startGroup: "inputs", endGroup: "reports", legend: false, scaleNodes: true };
    const original = JSON.parse(viz.renderString(buildGraphDot(graph, options), { format: "json" }));
    const originalObjects = new Map(original.objects.map((object) => [object.name, object]));
    for (const count of [1, 2]) {
      const dot = buildGraphDot(graph, { ...options, groupColumns: { prepare: count } });
      const rendered = viz.render(dot, { format: "json" });
      assert.equal(rendered.status, "success", JSON.stringify(rendered.errors));
      assert.deepEqual(rendered.errors, []);
      const objects = new Map(JSON.parse(rendered.output).objects.map((object) => [object.name, object]));
      const xPositions = members.map((node) => objects.get(node.id).pos.split(",")[0]);
      assert.equal(new Set(xPositions).size, count, `${direction}: ${count} horizontal columns`);
      for (const node of graph.nodes) {
        assert.equal(objects.get(node.id).fontsize, originalObjects.get(node.id).fontsize);
        assert.equal(objects.get(node.id).label, originalObjects.get(node.id).label);
      }
      const boxes = graph.groups.map((group) => objects.get(`cluster_${group.id}`).bb.split(",").map(Number));
      for (const box of boxes.slice(1)) {
        assert.ok(direction === "LR" ? boxes[0][2] < box[0] : direction === "RL" ? boxes[0][0] > box[2]
          : direction === "TB" ? boxes[0][1] > box[3] : boxes[0][3] < box[1]);
      }
      for (const box of boxes.slice(0, -1)) {
        assert.ok(direction === "LR" ? boxes[3][0] > box[2] : direction === "RL" ? boxes[3][2] < box[0]
          : direction === "TB" ? boxes[3][3] < box[1] : boxes[3][1] > box[3]);
      }
      if (direction === "LR" && count === 1) {
        const originalBox = originalObjects.get("cluster_g1").bb.split(",").map(Number);
        assert.ok(boxes[1][2] - boxes[1][0] < (originalBox[2] - originalBox[0]) * 0.5);
        assert.ok(boxes[1][3] - boxes[1][1] > originalBox[3] - originalBox[1]);
      }
      assert.deepEqual([...dot.matchAll(/^\s+(n\d+) -> (n\d+)(?: \[constraint=false\])?;/gm)].map((match) => [match[1], match[2]]),
        graph.edges.map((edge) => [edge.from, edge.to]));
      const svg = viz.renderString(dot, { format: "svg" });
      assert.equal((svg.match(/id="node_n\d+"/g) || []).length, graph.nodes.length);
      assert.equal((svg.match(/class="edge"/g) || []).length, graph.edges.length);
    }
  }
  const boundedDot = buildGraphDot(graph, { groupColumns: { prepare: Number.MAX_SAFE_INTEGER }, legend: false });
  assert.ok(boundedDot.length < 10000);
  assert.doesNotThrow(() => viz.renderString(boundedDot, { format: "svg" }));
  assert.equal(JSON.stringify(graph), snapshot);
});

test("a dependency leaving and reentering a column loses only conflicting rank constraints", async () => {
  const graph = {
    graphSource: "static",
    groups: [{ id: "g0", key: "selected", label: "selected", parentId: null },
      { id: "g1", key: "outside", label: "outside", parentId: null }],
    nodes: Array.from({ length: 5 }, (_, index) => ({
      id: `n${index}`, name: `target_${index}`, groupId: index < 2 ? "g0" : index === 2 ? "g1" : null,
      status: "unbuilt", inDegree: 0, outDegree: 0
    })),
    edges: [[0, 2], [2, 1], [0, 1], [3, 4]].map(([from, to]) => ({ from: `n${from}`, to: `n${to}` }))
  };
  const dot = buildGraphDot(graph, { groupColumns: { selected: 1 }, legend: false });
  for (const [from, to] of [[0, 2], [2, 1], [0, 1]]) assert.match(dot, new RegExp(`n${from} -> n${to} \\[constraint=false\\];`));
  assert.match(dot, /n3 -> n4;/);
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  const rendered = viz.render(dot, { format: "svg" });
  assert.equal(rendered.status, "success", JSON.stringify(rendered.errors));
  assert.deepEqual(rendered.errors, []);
  assert.equal((rendered.output.match(/class="edge"/g) || []).length, graph.edges.length);
  graph.edges.push({ from: "n1", to: "n0" });
  assert.doesNotThrow(() => viz.renderString(buildGraphDot(graph, { groupColumns: { selected: 1 }, legend: false }), { format: "svg" }));
});

test("parent columns stack nested boxes without flattening them or expanding the column count", async () => {
  const graph = {
    graphSource: "static",
    groups: [{ id: "g0", key: "outer", label: "outer", parentId: null },
      { id: "g1", key: "partA", label: "partA", parentId: "g0" },
      { id: "g2", key: "partB", label: "partB", parentId: "g0" }],
    nodes: Array.from({ length: 6 }, (_, index) => ({
      id: `n${index}`, name: `target_${index}`, groupId: index < 3 ? "g1" : "g2",
      status: "unbuilt", inDegree: 1, outDegree: 1
    })),
    edges: [[0, 3], [3, 1], [1, 4], [4, 2], [2, 5]].map(([from, to]) => ({ from: `n${from}`, to: `n${to}` }))
  };
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  for (const direction of ["LR", "RL", "TB", "BT"]) {
    for (const count of [1, 2]) {
      const dot = buildGraphDot(graph, { direction, groupColumns: { outer: count }, legend: false });
      const rendered = viz.render(dot, { format: "json" });
      assert.equal(rendered.status, "success", JSON.stringify(rendered.errors));
      assert.deepEqual(rendered.errors, []);
      const objects = new Map(JSON.parse(rendered.output).objects.map((object) => [object.name, object]));
      assert.equal(new Set(graph.nodes.map((node) => objects.get(node.id).pos.split(",")[0])).size, count);
      const parent = objects.get("cluster_g0").bb.split(",").map(Number);
      const children = ["cluster_g1", "cluster_g2"].map((id) => objects.get(id).bb.split(",").map(Number));
      for (const box of children) {
        assert.ok(parent[0] < box[0] && parent[1] < box[1] && parent[2] > box[2] && parent[3] > box[3]);
      }
      const [a, b] = children;
      assert.ok(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
      const svg = viz.renderString(dot, { format: "svg" });
      assert.equal((svg.match(/id="group_g\d+"/g) || []).length, 3);
      assert.equal((svg.match(/class="edge"/g) || []).length, graph.edges.length);
    }
  }
});

test("overall width validates whole pixel bounds and defaults to Automatic", () => {
  const graph = columnGraph();
  assert.equal(validateGraphLayout(graph).graphWidth, null);
  for (const graphWidth of [null, 1, 100000]) {
    assert.equal(validateGraphLayout(graph, { graphWidth }).graphWidth, graphWidth);
  }
  for (const graphWidth of [0, -1, 1.5, NaN, Infinity, "2000", {}, 100001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateGraphLayout(graph, { graphWidth }), /whole number from 1 to 100000 pixels/);
    assert.throws(() => renderGraphLayout({}, "", graphWidth), /whole number from 1 to 100000 pixels/);
  }
});

test("overall width increases real horizontal gaps without scaling labels and exports resolved DOT", async () => {
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  const graph = columnGraph();
  const snapshot = JSON.stringify(graph);
  for (const direction of ["LR", "TB"]) {
    const dot = buildGraphDot(graph, {
      direction, startGroup: "inputs", endGroup: "reports", groupColumns: { prepare: 1 }, scaleNodes: true, legend: false
    });
    const natural = JSON.parse(viz.renderString(dot, { format: "json" }));
    const naturalObjects = new Map(natural.objects.map((object) => [object.name, object]));
    const naturalBoxes = graph.groups.map((group) => naturalObjects.get(`cluster_${group.id}`).bb.split(",").map(Number));
    const naturalWidth = (Math.max(...naturalBoxes.map((box) => box[2])) - Math.min(...naturalBoxes.map((box) => box[0]))) * 4 / 3;
    const requested = Math.ceil(naturalWidth * 1.8);
    const formats = [];
    const trackedViz = {
      renderString(source, options) {
        formats.push(options.format);
        return viz.renderString(source, options);
      }
    };
    const result = renderGraphLayout(trackedViz, dot, requested);
    assert.equal(result.widthInfo.requested, requested);
    assert.equal(result.widthInfo.limited, false);
    assert.equal(result.widthInfo.reason, null);
    assert.ok(Math.abs(result.widthInfo.actual - requested) <= requested * 0.02);
    assert.ok(formats.filter((format) => format === "json").length <= 4);
    assert.equal(formats.filter((format) => format === "svg").length, 1);
    assert.equal(result.svg, viz.renderString(result.dot, { engine: "dot", format: "svg" }));
    assert.match(result.svg, /class="graph" transform="scale\(1 1\)/);
    assert.doesNotMatch(result.dot, /\b(?:size|ratio)=/);

    const objects = new Map(JSON.parse(viz.renderString(result.dot, { format: "json" })).objects.map((object) => [object.name, object]));
    const centers = graph.nodes.map((node) => Number(objects.get(node.id).pos.split(",")[0]));
    const naturalCenters = graph.nodes.map((node) => Number(naturalObjects.get(node.id).pos.split(",")[0]));
    assert.ok(Math.max(...centers) - Math.min(...centers) > Math.max(...naturalCenters) - Math.min(...naturalCenters));
    for (const node of graph.nodes) {
      for (const attribute of ["width", "height", "fontsize", "label"]) {
        assert.equal(objects.get(node.id)[attribute], naturalObjects.get(node.id)[attribute]);
      }
    }
    assert.equal(new Set(graph.nodes.filter((node) => node.groupId === "g1")
      .map((node) => objects.get(node.id).pos.split(",")[0])).size, 1);
    const boxes = graph.groups.map((group) => objects.get(`cluster_${group.id}`).bb.split(",").map(Number));
    for (const box of boxes.slice(1)) assert.ok(direction === "LR" ? boxes[0][2] < box[0] : boxes[0][1] > box[3]);
    for (const box of boxes.slice(0, -1)) assert.ok(direction === "LR" ? boxes[3][0] > box[2] : boxes[3][3] < box[1]);
    assert.equal((result.svg.match(/id="node_n\d+"/g) || []).length, graph.nodes.length);
    assert.equal((result.svg.match(/class="edge"/g) || []).length, graph.edges.length);
    if (direction === "LR") {
      const worker = require("../../src/visualization/renderGraph");
      assert.deepEqual(await worker.renderGraphLayout(dot, requested), result);
    }
  }
  assert.equal(JSON.stringify(graph), snapshot);
});

test("Automatic and widths below the natural size retain the original readable layout", async () => {
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  const dot = buildGraphDot(columnGraph());
  const automatic = renderGraphLayout(viz, dot);
  assert.equal(automatic.dot, dot);
  assert.equal(automatic.widthInfo, null);
  const belowNatural = renderGraphLayout(viz, dot, 1);
  assert.equal(belowNatural.dot, dot);
  assert.equal(belowNatural.svg, automatic.svg);
  assert.equal(belowNatural.widthInfo.natural, belowNatural.widthInfo.actual);
  assert.equal(belowNatural.widthInfo.reason, "natural-minimum");
  assert.equal(belowNatural.widthInfo.limited, true);
});

test("single-target and single-column views report limited width without adding blank canvas", async () => {
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  const graph = columnGraph();
  const singleColumn = {
    ...graph,
    groups: [{ id: "g0", key: "only", label: "only", parentId: null }],
    nodes: graph.nodes.map((node) => ({ ...node, groupId: "g0" }))
  };
  const singleTarget = filterGraphUpstream(graph, "raw");
  for (const direction of ["LR", "TB"]) {
    for (const current of [singleTarget, singleColumn]) {
      const dot = buildGraphDot(current, { direction, groupColumns: { only: 1 }, legend: false });
      const result = renderGraphLayout(viz, dot, 4000);
      assert.equal(result.dot, dot);
      assert.equal(result.svg, viz.renderString(dot, { engine: "dot", format: "svg" }));
      assert.equal(result.widthInfo.limited, true);
      assert.equal(result.widthInfo.reason, "no-horizontal-room");
      assert.equal(result.widthInfo.actual, result.widthInfo.natural);
      assert.ok(result.widthInfo.actual < 4000);
    }
  }
});
