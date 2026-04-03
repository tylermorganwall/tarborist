"use strict";

// Build graph adjacency, transitive reachability, and SCC-based cycle detection
// for the statically indexed targets DAG.
function ensureSet(map, key) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }

  return map.get(key);
}

function buildReachability(adjacency) {
  // Precompute descendants/ancestors once so completion and hover lookups stay cheap.
  const closure = new Map();

  for (const node of adjacency.keys()) {
    const seen = new Set();
    const stack = [...(adjacency.get(node) || [])];

    while (stack.length) {
      const candidate = stack.pop();
      if (seen.has(candidate)) {
        continue;
      }

      seen.add(candidate);
      for (const next of adjacency.get(candidate) || []) {
        if (!seen.has(next)) {
          stack.push(next);
        }
      }
    }

    closure.set(node, seen);
  }

  return closure;
}

function tarjan(adjacency) {
  // Standard Tarjan SCC walk to identify real cycles, including multi-node loops.
  const indexByNode = new Map();
  const lowLinkByNode = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let nextIndex = 0;

  function visit(node) {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;

    stack.push(node);
    onStack.add(node);

    for (const neighbor of adjacency.get(node) || []) {
      if (!indexByNode.has(neighbor)) {
        visit(neighbor);
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node), lowLinkByNode.get(neighbor)));
        continue;
      }

      if (onStack.has(neighbor)) {
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node), indexByNode.get(neighbor)));
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) {
      return;
    }

    const component = [];
    while (stack.length) {
      const current = stack.pop();
      onStack.delete(current);
      component.push(current);
      if (current === node) {
        break;
      }
    }

    components.push(component);
  }

  for (const node of adjacency.keys()) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }

  return components;
}

function buildPipelineGraph(targets, refs) {
  const upstreamToDownstream = new Map();
  const downstreamToUpstream = new Map();

  for (const targetName of targets.keys()) {
    upstreamToDownstream.set(targetName, new Set());
    downstreamToUpstream.set(targetName, new Set());
  }

  // Refs point from a referenced upstream target into the enclosing target.
  for (const ref of refs) {
    if (!ref.enclosingTarget || !targets.has(ref.targetName) || !targets.has(ref.enclosingTarget)) {
      continue;
    }

    ensureSet(upstreamToDownstream, ref.targetName).add(ref.enclosingTarget);
    ensureSet(downstreamToUpstream, ref.enclosingTarget).add(ref.targetName);
  }

  const descendants = buildReachability(upstreamToDownstream);
  const ancestors = buildReachability(downstreamToUpstream);

  const cycles = [];
  for (const component of tarjan(upstreamToDownstream)) {
    if (component.length > 1) {
      cycles.push(component.sort());
      continue;
    }

    const [node] = component;
    if ((upstreamToDownstream.get(node) || new Set()).has(node)) {
      cycles.push(component);
    }
  }

  return {
    upstreamToDownstream,
    downstreamToUpstream,
    descendants,
    ancestors,
    cycles,
    cyclicTargets: new Set(cycles.flat())
  };
}

module.exports = {
  buildPipelineGraph
};
