"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildPipelineGraph } = require("../../src/index/graph");

function chain(length) {
  const targets = new Map(Array.from({ length }, (_, index) => [String(index), {}]));
  const refs = Array.from({ length: length - 1 }, (_, index) => ({ targetName: String(index), enclosingTarget: String(index + 1) }));
  return buildPipelineGraph(targets, refs);
}

test("long chains are stack safe and reachability is computed only on demand", () => {
  const graph = chain(10000);
  assert.equal(graph.cycles.length, 0);
  assert.equal(graph.descendants.cache.size, 0);
  assert.equal(graph.ancestors.cache.size, 0);
  assert.equal(graph.descendants.get("0").size, 9999);
  assert.equal(graph.ancestors.get("9999").size, 9999);
  assert.equal(graph.descendants.get("9999").size, 0);
  assert.equal(graph.descendants.get("absent"), undefined);
});

test("reachability cache stays bounded across many queries", () => {
  const graph = chain(2000);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(graph.descendants.get(String(index)).size, 1999 - index);
    assert.ok(graph.descendants.cachedEntries <= 16384);
    assert.ok(graph.descendants.cache.size <= 32);
  }
  assert.equal(graph.descendants.get("0").size, 1999, "evicted results can be recomputed");
});

test("iterative cycle detection handles connected cycles, self loops, and acyclic parents", () => {
  const targets = new Map(["a", "b", "c", "d", "e", "f", "g"].map((name) => [name, {}]));
  const refs = [["a", "b"], ["b", "c"], ["c", "b"], ["c", "d"], ["d", "e"], ["e", "d"], ["f", "f"]]
    .map(([targetName, enclosingTarget]) => ({ targetName, enclosingTarget }));
  const graph = buildPipelineGraph(targets, refs);
  assert.deepEqual(graph.cycles.map((cycle) => cycle.join(",")).sort(), ["b,c", "d,e", "f"]);
  assert.deepEqual([...graph.descendants.get("a")].sort(), ["b", "c", "d", "e"]);
  assert.deepEqual([...graph.ancestors.get("d")].sort(), ["a", "b", "c", "d", "e"]);
  assert.deepEqual([...graph.descendants.get("g")], []);
});
