"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildStaticWorkspaceIndex } = require("../../src/index/pipelineResolver");
const { ensureParserReady } = require("../../src/parser/treeSitter");
const { buildGroupedPipelineGraph, buildGraphDot } = require("../../src/visualization/pipelineGraph");

test.before(ensureParserReady);

function withIndex(files, callback, script = "_targets.R") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarborist-graph-"));
  try {
    for (const [name, contents] of Object.entries(typeof files === "string" ? { [script]: files } : files)) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    const index = buildStaticWorkspaceIndex({
      workspaceRoot: root,
      script: path.join(root, script),
      readFile: (file) => fs.readFileSync(file, "utf8")
    });
    return callback(index, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function memberships(graph) {
  const labels = new Map(graph.groups.map((group) => [group.id, group.label]));
  return Object.fromEntries(graph.nodes.map((node) => [node.name, labels.get(node.groupId) || null]));
}

function namedEdges(graph) {
  const names = new Map(graph.nodes.map((node) => [node.id, node.name]));
  return graph.edges.map((edge) => [names.get(edge.from), names.get(edge.to)]);
}

test("groups the user's named lists, ignores NULL, and retains cross-group dependencies", () => withIndex(`
targets_subpipeline1 = list(
  tar_target(raw, 1),
  tar_target(clean, raw + 1),
  NULL
)
targets_subpipeline2 = list(tar_target(report, clean + 2), NULL)
unused = list(tar_target(disabled, 9))
list(targets_subpipeline1, targets_subpipeline2, NULL)
`, (index) => {
  const graph = buildGroupedPipelineGraph(index);
  assert.equal(graph.partial, false);
  assert.equal(graph.graphSource, "static");
  assert.equal(graph.statusSource, "last recorded build");
  assert.deepEqual(memberships(graph), {
    raw: "targets_subpipeline1", clean: "targets_subpipeline1", report: "targets_subpipeline2"
  });
  assert.deepEqual(namedEdges(graph), [["raw", "clean"], ["clean", "report"]]);
  assert.equal(graph.nodes.find((node) => node.name === "clean").command, "raw + 1");
  assert.equal(graph.nodes.find((node) => node.name === "raw").line, 3);
  assert.equal(graph.nodes.find((node) => node.name === "clean").inDegree, 1);
  assert.equal(graph.nodes.find((node) => node.name === "clean").outDegree, 1);
  assert.ok(graph.nodes.every((node) => node.status === "unbuilt"));
  assert.doesNotThrow(() => JSON.stringify(graph));
}));

test("aliases and reassignment preserve the particular list definition used in the final pipeline", () => withIndex(`
seed_object = tar_target(seed, 1)
chunk = list(seed_object, tar_target(before, seed))
alias = chunk
chunk = list(tar_target(after, before))
list(alias, chunk)
`, (index) => {
  const graph = buildGroupedPipelineGraph(index);
  assert.equal(graph.groups.length, 2);
  assert.deepEqual(graph.groups.map((group) => group.label), ["chunk", "chunk"]);
  assert.deepEqual(graph.groups.map((group) => group.line), [3, 5]);
  assert.equal(graph.nodes[0].groupId, graph.nodes[1].groupId);
  assert.notEqual(graph.nodes[1].groupId, graph.nodes[2].groupId);
  assert.ok(!graph.groups.some((group) => group.label === "seed_object" || group.label === "alias"));
}));

test("subpipeline keys survive line edits and return-order changes while distinguishing repeated definitions", () => {
  const definitions = `
chunk = list(tar_target(first, 1))
old_chunk = chunk
chunk = list(tar_target(second, first))
other = list(tar_target(third, 1))
`;
  const keyByTarget = (index) => {
    const graph = buildGroupedPipelineGraph(index);
    const keys = new Map(graph.groups.map((group) => [group.id, group.key]));
    assert.equal(new Set(keys.values()).size, graph.groups.length);
    return Object.fromEntries(graph.nodes.map((node) => [node.name, keys.get(node.groupId)]));
  };
  const before = withIndex(`${definitions}\nlist(old_chunk, chunk, other)`, keyByTarget);
  const after = withIndex(`# New source comment\n\n${definitions}\nlist(other, chunk, old_chunk)`, keyByTarget);
  assert.deepEqual(after, before);
  assert.notEqual(before.first, before.second);
  assert.deepEqual(JSON.parse(before.first), [["_targets.R", "chunk", 0]]);
  assert.deepEqual(JSON.parse(before.second), [["_targets.R", "chunk", 1]]);
});

test("nested named lists preserve hierarchy without boxing the final assembly", () => withIndex(`
one = tar_target(raw, 1)
data = list(one, modeling = list(tar_target(fit, raw)))
assembly = list(data, outputs = list(tar_target(report, fit)), NULL)
assembly
`, (index) => {
  const graph = buildGroupedPipelineGraph(index);
  assert.deepEqual(memberships(graph), { raw: "data", fit: "modeling", report: "outputs" });
  const data = graph.groups.find((group) => group.label === "data");
  const modeling = graph.groups.find((group) => group.label === "modeling");
  assert.equal(modeling.parentId, data.id);
  assert.ok(!graph.groups.some((group) => group.label === "assembly"));
  const dot = buildGraphDot(graph);
  assert.match(dot, /subgraph cluster_g0/);
  assert.match(dot, /id="group_g0"/);
  assert.match(dot, /id="node_n0"/);
}));

test("a single named leaf pipeline keeps its group name", () => withIndex(`
analysis = list(tar_target(x, 1), tar_target(y, x))
analysis
`, (index) => {
  assert.deepEqual(memberships(buildGroupedPipelineGraph(index)), { x: "analysis", y: "analysis" });
}));

test("imports with repeated list labels remain distinct by source location", () => withIndex({
  "_targets.R": `source("first.R")\nleft = chunk\nsource("second.R")\nlist(left, chunk)\n`,
  "first.R": "chunk = list(tar_target(first, 1))\n",
  "second.R": "chunk = list(tar_target(second, first))\n"
}, (index) => {
  const graph = buildGroupedPipelineGraph(index);
  assert.equal(graph.groups.length, 2);
  assert.deepEqual(graph.groups.map((group) => group.label), ["chunk", "chunk"]);
  assert.notEqual(graph.groups[0].file, graph.groups[1].file);
  assert.notEqual(graph.nodes[0].groupId, graph.nodes[1].groupId);
  assert.deepEqual(namedEdges(graph), [["first", "second"]]);
}));

test("tar_select_targets retains the selected targets' original subpipeline hierarchy", () => withIndex(`
a = list(tar_target(a1, 1), tar_target(a2, a1))
b = list(tar_target(b1, a1))
all = list(a, b)
selected = tar_select_targets(all, ends_with("1"))
selected
`, (index) => {
  const graph = buildGroupedPipelineGraph(index);
  assert.deepEqual(memberships(graph), { a1: "a", b1: "b" });
  assert.deepEqual(namedEdges(graph), [["a1", "b1"]]);
}));

test("a named tar_map subpipeline groups its generated targets without inventing runtime branches", () => withIndex(`
models = tarchetypes::tar_map(
  values = list(species = c("adelie", "gentoo")),
  targets::tar_target(fit, species),
  targets::tar_target(report, fit)
)
list(models, NULL)
`, (index) => {
  const graph = buildGroupedPipelineGraph(index);
  assert.equal(graph.partial, false);
  assert.equal(graph.groups.length, 1);
  assert.equal(graph.groups[0].label, "models");
  assert.deepEqual(graph.nodes.map((node) => node.name), ["fit_adelie", "report_adelie", "fit_gentoo", "report_gentoo"]);
  assert.ok(graph.nodes.every((node) => node.generated && node.groupId === graph.groups[0].id));
  assert.ok(graph.nodes.every((node) => node.file === index.rootFile && node.line === 2 && node.character === 10));
  assert.deepEqual(namedEdges(graph), [["fit_adelie", "report_adelie"], ["fit_gentoo", "report_gentoo"]]);
}));

test("selection membership cannot leak unselected targets that appear elsewhere", () => withIndex(`
a = list(tar_target(x, 1), tar_target(y, x))
first = tar_select_targets(a, x)
other = list(tar_select_targets(a, y), tar_target(z, y))
list(first, other)
`, (index) => {
  const graph = buildGroupedPipelineGraph(index);
  const y = graph.nodes.find((node) => node.name === "y");
  const yGroup = graph.groups.find((group) => group.id === y.groupId);
  const parent = graph.groups.find((group) => group.id === yGroup.parentId);
  assert.equal(parent.label, "other");
  assert.ok(!graph.diagnostics.some((diagnostic) => /multiple subpipelines/.test(diagnostic.message)));
}));

test("the same target in incompatible groups is displayed once in their common ancestor", () => withIndex(`
t = tar_target(shared, 1)
a = list(t, tar_target(x, shared))
b = list(t, tar_target(y, shared))
list(a, b)
`, (index) => {
  const graph = buildGroupedPipelineGraph(index);
  assert.equal(graph.nodes.filter((node) => node.name === "shared").length, 1);
  assert.equal(graph.nodes.find((node) => node.name === "shared").groupId, null);
  assert.ok(graph.partial);
  assert.ok(graph.diagnostics.some((diagnostic) => /multiple subpipelines/.test(diagnostic.message)));
}));

test("a supplied targets network is authoritative and unmatched vertices stay ungrouped", () => withIndex(`
a = list(tar_target(x, 1))
b = list(tar_target(y, x))
unused = list(tar_target(z, 2))
list(a, b)
`, (index) => {
  const network = {
    vertices: [{ name: "x", status: "uptodate" }, { name: "y", status: "outdated" }, { name: "generated_branch", status: "errored" }],
    edges: [{ from: "y", to: "x" }, { from: "x", to: "generated_branch" }, { from: "x", to: "generated_branch" }]
  };
  const graph = buildGroupedPipelineGraph(index, { network });
  assert.equal(graph.graphSource, "network");
  assert.equal(graph.statusSource, "network");
  assert.deepEqual(memberships(graph), { x: "a", y: "b", generated_branch: null });
  assert.deepEqual(namedEdges(graph), [["y", "x"], ["x", "generated_branch"]]);
  assert.deepEqual(graph.nodes.map((node) => node.status), ["uptodate", "outdated", "errored"]);
  assert.equal(graph.nodes.find((node) => node.name === "generated_branch").file, null);
  const filtered = buildGroupedPipelineGraph(index, { network, exclude: ["y"] });
  assert.deepEqual(filtered.groups.map((group) => group.label), ["a"]);
  assert.deepEqual(namedEdges(filtered), [["x", "generated_branch"]]);
  assert.equal(filtered.nodes.find((node) => node.name === "x").inDegree, 0);
}));

test("filtering prunes empty groups while preserving ancestors and remaining edges", () => withIndex(`
outer = list(first = list(tar_target(x, 1)), second = list(tar_target(y, x)))
result = list(outer, tar_target(z, y))
result
`, (index) => {
  const graph = buildGroupedPipelineGraph(index, { exclude: ["x"] });
  assert.deepEqual(graph.groups.map((group) => group.label), ["outer", "second"]);
  assert.deepEqual(namedEdges(graph), [["y", "z"]]);
  assert.doesNotMatch(buildGraphDot(graph), /label="first"/);
}));

test("last build metadata never asserts that a static target is currently up to date", () => withIndex(`
list(tar_target(x, 1), tar_target(y, 2), tar_target(z, 3), tar_target(w, 4))
`, (index) => {
  index.targetsMeta.set("x", { timestampMs: Date.now() });
  index.targetsMeta.set("y", { hasError: true });
  index.targetsMeta.set("z", { hasWarnings: true });
  index.targetsProgress.set("w", "canceled");
  const graph = buildGroupedPipelineGraph(index);
  assert.deepEqual(graph.nodes.map((node) => node.status), ["built", "last_error", "last_warning", "canceled"]);
  assert.match(buildGraphDot(graph), /not current freshness/);
}));

test("nondefault scripts keep their actual root path", () => withIndex("list(tar_target(x, 1))", (index, root) => {
  assert.equal(index.rootFile, path.join(root, "pipeline.R"));
  assert.equal(index.workspaceRoot, root);
  assert.equal(buildGroupedPipelineGraph(index).nodes[0].name, "x");
}, "pipeline.R"));

test("render IDs cannot collide and labels cannot inject DOT syntax", () => withIndex("list(NULL)", (index) => {
  const names = ["a-b", "a_b", 'x"; fake -> other; //', "\\N", "line\nname"];
  const graph = buildGroupedPipelineGraph(index, {
    network: { vertices: names.map((name) => ({ name })), edges: [] }
  });
  graph.groups = [{ id: "g0", label: 'group" {evil}', parentId: null }];
  graph.nodes[0].groupId = "g0";
  const dot = buildGraphDot(graph, { legend: false });
  assert.deepEqual(graph.nodes.map((node) => node.id), ["n0", "n1", "n2", "n3", "n4"]);
  assert.ok(dot.includes('label="x\\"; fake -> other; //"'));
  assert.ok(dot.includes('label="\\\\N"'));
  assert.ok(dot.includes('label="line\\nname"'));
  assert.ok(dot.includes('label="group\\" {evil}"'));
  assert.doesNotMatch(dot, /^\s*fake -> other/m);
}));

test("malformed networks fail clearly instead of silently dropping data", () => withIndex("list(NULL)", (index) => {
  assert.throws(() => buildGroupedPipelineGraph(index, {
    network: { vertices: [{ name: "x" }, { name: "x" }], edges: [] }
  }), /duplicate vertex/);
  assert.throws(() => buildGroupedPipelineGraph(index, {
    network: { vertices: [{ name: "x" }], edges: [{ from: "x", to: "missing" }] }
  }), /present in the vertices/);
  assert.throws(() => buildGroupedPipelineGraph(index, { exclude: "x" }), /array of target names/);
  assert.throws(() => buildGraphDot(buildGroupedPipelineGraph(index), { direction: 'LR; bad' }), /direction must/);
}));

test("Graphviz lays out interleaved dependencies across nested clusters", async () => {
  const graph = withIndex(`
training = list(tar_target(input, 1), tar_target(finish, validate))
quality = list(checks = list(tar_target(validate, input)))
list(training, quality)
`, (index) => buildGroupedPipelineGraph(index));
  const { instance } = require("@viz-js/viz");
  const viz = await instance();
  for (const direction of ["LR", "TB", "RL", "BT"]) {
    const result = viz.render(buildGraphDot(graph, { direction, scaleNodes: true }), { format: "svg" });
    assert.equal(result.status, "success", JSON.stringify(result.errors));
    assert.equal((result.output.match(/id="node_n\d+"/g) || []).length, 3);
    assert.equal((result.output.match(/id="group_g\d+"/g) || []).length, 3);
  }
});
