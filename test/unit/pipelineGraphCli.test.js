"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createPipelineGraph } = require("../../scripts/pipeline-graph");
const { renderGraphSvg } = require("../../src/visualization/renderGraph");

const cli = path.resolve(__dirname, "../../scripts/pipeline-graph.js");

test("CLI parses a custom script path without executing setup code", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grouped graph "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, "pipeline custom.R");
  const sentinel = path.join(directory, "should-not-exist");
  fs.writeFileSync(script, [
    `writeLines("executed", ${JSON.stringify(sentinel)})`,
    "targets_first = list(tar_target(a, 1), NULL)",
    "targets_second = list(tar_target(b, a + 1), NULL)",
    "list(targets_first, targets_second, NULL)"
  ].join("\n"));

  const requestPath = path.join(directory, "request with spaces.json");
  fs.writeFileSync(requestPath, JSON.stringify({ script, exclude: [], direction: "TB" }));
  const result = spawnSync(process.execPath, [cli, "--request", requestPath], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const { graph, dot } = JSON.parse(result.stdout);
  assert.deepEqual(graph.groups.map((group) => group.label), ["targets_first", "targets_second"]);
  assert.deepEqual(graph.nodes.map((node) => node.name), ["a", "b"]);
  assert.equal(graph.edges.length, 1);
  assert.match(dot, /rankdir=TB/);
  assert.equal(fs.existsSync(sentinel), false);

  const svg = await renderGraphSvg(dot);
  assert.match(svg, /<svg /);
  assert.match(svg, /targets_first/);
  assert.match(svg, /targets_second/);
  assert.match(svg, /id="node_n0"/);
});

test("CLI preserves supplied network statuses and singleton exclusions", async () => {
  const script = path.resolve(__dirname, "../../examples/grouped_pipeline/_targets.R");
  const { graph } = await createPipelineGraph({
    script,
    exclude: ["configuration"],
    network: {
      vertices: [
        { name: "observations", status: "uptodate" },
        { name: "configuration", status: "queued" },
        { name: "external_factory_result", status: "outdated" }
      ],
      edges: [{ from: "observations", to: "external_factory_result" }]
    }
  });
  assert.equal(graph.graphSource, "network");
  assert.deepEqual(graph.nodes.map((node) => node.name), ["observations", "external_factory_result"]);
  assert.deepEqual(graph.nodes.map((node) => node.status), ["uptodate", "outdated"]);
  assert.equal(graph.nodes[1].groupId, null);
  assert.equal(graph.edges.length, 1);
});

test("CLI emits a self-contained interactive HTML graph", () => {
  const script = path.resolve(__dirname, "../../examples/grouped_pipeline/_targets.R");
  const result = spawnSync(process.execPath, [cli, script, "--format", "html"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<!DOCTYPE html>/);
  assert.match(result.stdout, /<svg /);
  assert.match(result.stdout, /id="target-search"/);
  assert.match(result.stdout, /id="pipeline-data"/);
  assert.match(result.stdout, /id="upstream-only"/);
  assert.match(result.stdout, /id="show-all"/);
  const payload = JSON.parse(result.stdout.match(/<script id="pipeline-data"[^>]*>(.*?)<\/script>/s)[1]);
  assert.match(payload.layoutWorkerText, /Viz.instance\(\)/);
  assert.match(payload.layoutWorkerText, /self.onmessage/);
  assert.match(result.stdout, /TarboristGraphModel/);
  assert.doesNotMatch(result.stdout, /<script[^>]+src=/);
  assert.doesNotMatch(result.stdout, /<link[^>]+href=/);
});

test("CLI errors go to stderr with a failing exit status", () => {
  const result = spawnSync(process.execPath, [cli, "--format", "unknown"], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--format must be/);
});

test("Graphviz errors reject without crashing the caller", async () => {
  await assert.rejects(renderGraphSvg("digraph { a -> }"), /syntax error/i);
});
