"use strict";

const path = require("path");
const { buildGraphDot, filterGraphUpstream, validateGraphLayout } = require("../../media/pipelineGraphModel");
const { getTargetLocation } = require("../targetLocation");

/**
 * Convert a completed static index into serializable graph and group data.
 * A supplied targets network owns the displayed vertices, edges, and statuses;
 * the static index then contributes source locations and group membership only.
 */
function buildGroupedPipelineGraph(index, options = {}) {
  if (!index || !(index.targets instanceof Map) || !(index.files instanceof Map)) {
    throw new TypeError("index must be a completed tarborist workspace index.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object.");
  }
  const exclude = options.exclude === undefined ? [] : options.exclude;
  if (!Array.isArray(exclude) || exclude.some((name) => typeof name !== "string")) {
    throw new TypeError("exclude must be an array of target names.");
  }
  const network = options.network === undefined ? null : options.network;
  if (network !== null && (!network || !Array.isArray(network.vertices) || !Array.isArray(network.edges))) {
    throw new TypeError("network must contain vertices and edges arrays.");
  }
  const vertices = network ? network.vertices : [...index.targets.keys()].map((name) => ({ name }));
  const vertexNames = new Set();
  for (const [position, vertex] of vertices.entries()) {
    if (!vertex || typeof vertex.name !== "string" || !vertex.name.length) {
      throw new TypeError(`Vertex ${position + 1} must have a nonempty string name.`);
    }
    if (vertexNames.has(vertex.name)) {
      throw new TypeError(`The network contains duplicate vertex ${JSON.stringify(vertex.name)}.`);
    }
    vertexNames.add(vertex.name);
    if (network && vertex.status !== undefined && vertex.status !== null && typeof vertex.status !== "string") {
      throw new TypeError(`Status for ${JSON.stringify(vertex.name)} must be a string or null.`);
    }
  }
  const sourceEdges = network ? network.edges : [...(index.graph?.upstreamToDownstream || new Map())]
    .flatMap(([from, downstream]) => [...downstream].map((to) => ({ from, to })));
  for (const [position, edge] of sourceEdges.entries()) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string"
      || !vertexNames.has(edge.from) || !vertexNames.has(edge.to)) {
      throw new TypeError(`Edge ${position + 1} must connect names present in the vertices array.`);
    }
  }

  const diagnostics = [];
  for (const record of index.files.values()) {
    for (const diagnostic of record.diagnostics || []) {
      diagnostics.push({
        file: diagnostic.file || record.file,
        line: (diagnostic.range?.start.line || 0) + 1,
        character: (diagnostic.range?.start.character || 0) + 1,
        severity: diagnostic.severity,
        message: diagnostic.message
      });
    }
  }

  // Resolved list objects preserve source-order bindings, including aliases and
  // earlier values of reassigned symbols. Source spans identify definitions;
  // two lists with the same label are still distinct groups.
  const groups = [];
  const groupByOrigin = new Map();
  const targetPaths = new Map();
  const rootValue = index.files.get(index.rootFile)?.lastValue;
  const pending = [{ value: rootValue, groupPath: [], allowed: null, root: true }];
  while (pending.length) {
    const entry = pending.pop();
    const value = entry.value;
    if (!value) {
      continue;
    }
    if (value.kind === "TargetObject") {
      const target = value.target;
      if (index.targets.get(target.name) !== target || (entry.allowed && !entry.allowed.has(target.name))) {
        continue;
      }
      if (!targetPaths.has(target.name)) {
        targetPaths.set(target.name, []);
      }
      targetPaths.get(target.name).push(entry.groupPath);
      continue;
    }
    if (value.kind !== "TargetList" && value.kind !== "StaticMap") {
      continue;
    }

    let groupPath = entry.groupPath;
    let showGroup = Boolean(value.groupOrigin);
    if (entry.root && value.selectionSource) {
      showGroup = false;
    } else if (entry.root && showGroup && value.kind === "TargetList") {
      // A named final assembly should not wrap the meaningful subpipeline
      // clusters in one redundant outer box. A single leaf list keeps its name.
      const descendants = [...value.items];
      while (descendants.length) {
        const child = descendants.pop();
        if (!child) {
          continue;
        }
        if (child.groupOrigin && ((child.items && child.items.length) || (child.targets && child.targets.length))) {
          showGroup = false;
          break;
        }
        if (child.selectionSource) {
          descendants.push(child.selectionSource);
        } else if (child.kind === "TargetList") {
          descendants.push(...child.items);
        }
      }
    }
    if (showGroup) {
      const origin = value.groupOrigin;
      const parentId = groupPath.length ? groupPath[groupPath.length - 1] : null;
      const key = JSON.stringify([parentId, origin.file, origin.range, origin.label]);
      let group = groupByOrigin.get(key);
      if (!group) {
        group = {
          id: `g${groups.length}`,
          label: origin.label,
          parentId,
          file: origin.file,
          line: (origin.range?.start.line || 0) + 1,
          character: (origin.range?.start.character || 0) + 1
        };
        groupByOrigin.set(key, group);
        groups.push(group);
      }
      groupPath = [...groupPath, group.id];
    }

    if (value.selectionSource) {
      // Selection flattens targets for analysis, but graph grouping follows the
      // original list hierarchy, restricted to this selection's actual names.
      const allowed = new Set(value.items.map((item) => item.target?.name)
        .filter((name) => name && (!entry.allowed || entry.allowed.has(name))));
      pending.push({ value: value.selectionSource, groupPath, allowed, root: entry.root });
    } else if (value.kind === "StaticMap") {
      for (const target of value.targets) {
        if (index.targets.get(target.name) === target && (!entry.allowed || entry.allowed.has(target.name))) {
          if (!targetPaths.has(target.name)) {
            targetPaths.set(target.name, []);
          }
          targetPaths.get(target.name).push(groupPath);
        }
      }
    } else {
      for (let position = value.items.length - 1; position >= 0; position -= 1) {
        pending.push({ value: value.items[position], groupPath, allowed: entry.allowed, root: false });
      }
    }
  }

  const excluded = new Set(exclude);
  const nodes = [];
  for (const vertex of vertices) {
    if (excluded.has(vertex.name)) {
      continue;
    }
    const target = index.targets.get(vertex.name);
    const paths = targetPaths.get(vertex.name) || [[]];
    // An invalid duplicate occurrence must not silently pick one of two groups.
    // Keep a single target node at the closest group shared by every occurrence.
    const commonPath = paths[0].slice();
    for (const other of paths.slice(1)) {
      let length = 0;
      while (length < commonPath.length && length < other.length && commonPath[length] === other[length]) {
        length += 1;
      }
      commonPath.length = length;
    }
    if (paths.some((candidate) => candidate.length !== commonPath.length)) {
      diagnostics.push({
        file: target.file,
        line: target.nameRange.start.line + 1,
        character: target.nameRange.start.character + 1,
        severity: "warning",
        message: `Target '${vertex.name}' occurs in multiple subpipelines; it is shown in their nearest common group.`
      });
    }

    const meta = index.targetsMeta?.get(vertex.name);
    const progress = index.targetsProgress?.get(vertex.name);
    let status = "unbuilt";
    if (network) {
      status = vertex.status || "unknown";
    } else if (progress === "canceled") {
      status = "canceled";
    } else if (meta?.hasError) {
      status = "last_error";
    } else if (meta?.hasWarnings) {
      status = "last_warning";
    } else if (Number.isFinite(meta?.timestampMs)) {
      status = "built";
    } else if (meta) {
      status = "unknown";
    }

    let command = null;
    const source = target && (index.sourceTexts?.get(target.file) || index.files.get(target.file)?.text);
    if (source !== undefined && source !== null && target?.commandRange) {
      const { start, end } = target.commandRange;
      const lines = source.split("\n").slice(start.line, end.line + 1);
      if (lines.length === 1) {
        command = lines[0].slice(start.character, end.character);
      } else if (lines.length) {
        lines[lines.length - 1] = lines[lines.length - 1].slice(0, end.character);
        lines[0] = lines[0].slice(start.character);
        command = lines.join("\n");
      }
    }
    const location = target ? getTargetLocation(target) : null;
    nodes.push({
      id: `n${nodes.length}`,
      name: vertex.name,
      groupId: commonPath.length ? commonPath[commonPath.length - 1] : null,
      status,
      file: location?.file || null,
      line: location?.range ? location.range.start.line + 1 : null,
      character: location?.range ? location.range.start.character + 1 : null,
      command,
      generated: Boolean(target?.generated),
      inDegree: 0,
      outDegree: 0
    });
  }

  const byName = new Map(nodes.map((node) => [node.name, node]));
  const edges = [];
  const edgeKeys = new Set();
  for (const source of sourceEdges) {
    const from = byName.get(source.from);
    const to = byName.get(source.to);
    if (!from || !to) {
      continue;
    }
    const key = `${from.id}:${to.id}`;
    if (edgeKeys.has(key)) {
      continue;
    }
    edgeKeys.add(key);
    edges.push({ from: from.id, to: to.id });
    from.outDegree += 1;
    to.inDegree += 1;
  }

  // Pin identities follow source definitions, not renderer IDs or line numbers.
  // Source occurrence distinguishes reused labels; hierarchy distinguishes the
  // same list definition included under different containing subpipelines.
  const workspaceRoot = index.workspaceRoot || path.dirname(index.rootFile);
  const definitionsByName = new Map();
  for (const group of groups) {
    const name = JSON.stringify([group.file, group.label]);
    if (!definitionsByName.has(name)) definitionsByName.set(name, new Map());
    definitionsByName.get(name).set(`${group.line}:${group.character}`, group);
  }
  const definitionOccurrences = new Map();
  for (const [name, definitions] of definitionsByName) {
    const ordered = [...definitions.values()].sort((a, b) => a.line - b.line || a.character - b.character);
    for (const [occurrence, group] of ordered.entries()) {
      definitionOccurrences.set(`${name}:${group.line}:${group.character}`, occurrence);
    }
  }
  const groupKeyPaths = new Map([[null, []]]);
  for (const group of groups) {
    const name = JSON.stringify([group.file, group.label]);
    const occurrence = definitionOccurrences.get(`${name}:${group.line}:${group.character}`);
    const keyPath = [...groupKeyPaths.get(group.parentId), [
      path.relative(workspaceRoot, group.file).replace(/\\/g, "/"), group.label, occurrence
    ]];
    groupKeyPaths.set(group.id, keyPath);
    group.key = JSON.stringify(keyPath);
  }

  // Filtering removes empty clusters but retains every ancestor of a visible
  // node. Renumber after pruning so renderer IDs never depend on user text.
  const usedGroups = new Set(nodes.map((node) => node.groupId).filter(Boolean));
  for (let position = groups.length - 1; position >= 0; position -= 1) {
    if (usedGroups.has(groups[position].id) && groups[position].parentId) {
      usedGroups.add(groups[position].parentId);
    }
  }
  const visibleGroups = groups.filter((group) => usedGroups.has(group.id));
  const groupIds = new Map(visibleGroups.map((group, position) => [group.id, `g${position}`]));
  for (const node of nodes) {
    node.groupId = groupIds.get(node.groupId) || null;
  }
  return {
    rootFile: index.rootFile,
    workspaceRoot,
    partial: Boolean(index.partial),
    graphSource: network ? "network" : "static",
    statusSource: network ? "network" : "last recorded build",
    diagnostics,
    groups: visibleGroups.map((group) => ({
      ...group,
      id: groupIds.get(group.id),
      parentId: groupIds.get(group.parentId) || null
    })),
    nodes,
    edges
  };
}

module.exports = { buildGroupedPipelineGraph, buildGraphDot, filterGraphUpstream, validateGraphLayout };
