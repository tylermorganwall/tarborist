"use strict";

// Build graph adjacency, transitive reachability, and SCC-based cycle detection
// for the statically indexed targets DAG.
function ensureSet(map, key) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }

  return map.get(key);
}

class ReachabilityMap {
  constructor(adjacency) {
    this.adjacency = adjacency;
    this.cache = new Map();
    this.cachedEntries = 0;
  }

  get size() { return this.adjacency.size; }
  has(name) { return this.adjacency.has(name); }
  keys() { return this.adjacency.keys(); }

  get(name) {
    if (!this.has(name)) {
      return undefined;
    }
    if (this.cache.has(name)) {
      const value = this.cache.get(name);
      this.cache.delete(name);
      this.cache.set(name, value);
      return value;
    }
    const seen = new Set();
    const pending = [...this.adjacency.get(name)];
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const next of this.adjacency.get(current) || []) {
        if (!seen.has(next)) {
          pending.push(next);
        }
      }
    }
    // Bound both the number of cached queries and total stored memberships.
    // One unusually large query is returned to its caller without being cached.
    if (seen.size <= 16384) {
      while (this.cache.size && (this.cache.size >= 32 || this.cachedEntries + seen.size > 16384)) {
        const oldest = this.cache.keys().next().value;
        this.cachedEntries -= this.cache.get(oldest).size;
        this.cache.delete(oldest);
      }
      this.cache.set(name, seen);
      this.cachedEntries += seen.size;
    }
    return seen;
  }

  *entries() {
    for (const name of this.keys()) {
      yield [name, this.get(name)];
    }
  }

  *values() {
    for (const name of this.keys()) {
      yield this.get(name);
    }
  }

  [Symbol.iterator]() { return this.entries(); }
}

function tarjan(adjacency) {
  // Iterative Tarjan traversal: a long valid pipeline must not exhaust the JS
  // stack before cycle diagnostics can be built.
  const indexByNode = new Map();
  const lowLinkByNode = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let nextIndex = 0;
  const enter = (node) => {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex++);
    stack.push(node);
    onStack.add(node);
    return { node, neighbors: (adjacency.get(node) || new Set()).values() };
  };

  for (const root of adjacency.keys()) {
    if (indexByNode.has(root)) {
      continue;
    }
    const frames = [enter(root)];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const neighbor = frame.neighbors.next();
      if (!neighbor.done) {
        if (!indexByNode.has(neighbor.value)) {
          frames.push(enter(neighbor.value));
        } else if (onStack.has(neighbor.value)) {
          lowLinkByNode.set(frame.node, Math.min(lowLinkByNode.get(frame.node), indexByNode.get(neighbor.value)));
        }
        continue;
      }
      frames.pop();
      if (frames.length) {
        const parent = frames[frames.length - 1].node;
        lowLinkByNode.set(parent, Math.min(lowLinkByNode.get(parent), lowLinkByNode.get(frame.node)));
      }
      if (lowLinkByNode.get(frame.node) === indexByNode.get(frame.node)) {
        const component = [];
        let node;
        do {
          node = stack.pop();
          onStack.delete(node);
          component.push(node);
        } while (node !== frame.node);
        components.push(component);
      }
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

  const descendants = new ReachabilityMap(upstreamToDownstream);
  const ancestors = new ReachabilityMap(downstreamToUpstream);

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
