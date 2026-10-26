"use strict";

// Shared by the extension host and offline browser view. Keep this module free
// of Node-only APIs so filtering and exports use exactly the same graph logic.
(() => {
  /** Keep selected targets and the union of their transitive dependencies. */
  function filterGraphUpstream(graph, targetNames = null) {
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.groups)) {
      throw new TypeError("graph must contain nodes, edges, and groups arrays.");
    }
    const requestedNames = targetNames === null ? []
      : typeof targetNames === "string" ? [targetNames] : targetNames;
    if (!Array.isArray(requestedNames)
      || requestedNames.some((name) => typeof name !== "string" || !name.length)) {
      throw new TypeError("targetNames must be a nonempty target name, an array of nonempty target names, or null.");
    }
    const focusNames = [...new Set(requestedNames)];
    if (!focusNames.length) {
      return { ...graph, upstreamTargets: [], upstreamTarget: null };
    }
    const targetsByName = new Map(graph.nodes.map((node) => [node.name, node]));
    for (const name of focusNames) {
      if (!targetsByName.has(name)) {
        throw new RangeError(`Unknown target ${JSON.stringify(name)}.`);
      }
    }

    // Edges point from inputs to consumers. Traverse the reverse adjacency once;
    // the visited set handles shared inputs and even an invalid cyclic pipeline.
    const upstream = new Map(graph.nodes.map((node) => [node.id, []]));
    for (const edge of graph.edges) {
      if (!upstream.has(edge.from) || !upstream.has(edge.to)) {
        throw new TypeError("Every graph edge must connect existing node IDs.");
      }
      upstream.get(edge.to).push(edge.from);
    }
    const retainedNodes = new Set();
    const pending = focusNames.map((name) => targetsByName.get(name).id);
    while (pending.length) {
      const id = pending.pop();
      if (retainedNodes.has(id)) {
        continue;
      }
      retainedNodes.add(id);
      for (const dependency of upstream.get(id)) {
        if (!retainedNodes.has(dependency)) {
          pending.push(dependency);
        }
      }
    }

    const sourceNodes = graph.nodes.filter((node) => retainedNodes.has(node.id));
    const groupsById = new Map(graph.groups.map((group) => [group.id, group]));
    const retainedGroups = new Set();
    for (const node of sourceNodes) {
      let groupId = node.groupId;
      const ancestry = new Set();
      while (groupId !== null) {
        if (ancestry.has(groupId)) {
          throw new TypeError("Group hierarchy must not contain a cycle.");
        }
        ancestry.add(groupId);
        if (retainedGroups.has(groupId)) {
          break;
        }
        const group = groupsById.get(groupId);
        if (!group) {
          throw new TypeError(`Unknown group ${JSON.stringify(groupId)}.`);
        }
        retainedGroups.add(groupId);
        groupId = group.parentId;
      }
    }
    const sourceGroups = graph.groups.map((group, position) => ({
      ...group,
      colorIndex: Number.isInteger(group.colorIndex) && group.colorIndex >= 0 ? group.colorIndex : position
    })).filter((group) => retainedGroups.has(group.id));
    const groupIds = new Map(sourceGroups.map((group, position) => [group.id, `g${position}`]));
    const nodeIds = new Map(sourceNodes.map((node, position) => [node.id, `n${position}`]));
    const nodes = sourceNodes.map((node) => ({
      ...node,
      id: nodeIds.get(node.id),
      groupId: groupIds.get(node.groupId) || null,
      inDegree: 0,
      outDegree: 0
    }));
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const edges = graph.edges.filter((edge) => retainedNodes.has(edge.from) && retainedNodes.has(edge.to))
      .map((edge) => ({ ...edge, from: nodeIds.get(edge.from), to: nodeIds.get(edge.to) }));
    for (const edge of edges) {
      nodesById.get(edge.from).outDegree += 1;
      nodesById.get(edge.to).inDegree += 1;
    }
    return {
      ...graph,
      upstreamTargets: focusNames,
      upstreamTarget: focusNames.length === 1 ? focusNames[0] : null,
      nodes,
      edges,
      groups: sourceGroups.map((group) => ({
        ...group,
        id: groupIds.get(group.id),
        parentId: groupIds.get(group.parentId) || null
      }))
    };
  }

  /** Quote data for a DOT string, including literal Graphviz escape sequences. */
  function quoteDot(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      .replace(/\r\n|\r|\n/g, "\\n").replace(/\t/g, "\\t")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")}"`;
  }

  function validateGraphWidth(width) {
    if (width !== null && (!Number.isSafeInteger(width) || width < 1 || width > 100000)) {
      throw new TypeError("graphWidth must be null or a whole number from 1 to 100000 pixels.");
    }
    return width;
  }

  /** Validate persistent layout choices against a complete or filtered graph. */
  function validateGraphLayout(graph, options = {}, allowMissingGroups = false) {
    if (!graph || !Array.isArray(graph.groups)) {
      throw new TypeError("graph must contain a groups array.");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Layout options must be an object.");
    }
    const direction = options.direction === undefined ? "LR" : options.direction;
    if (!["LR", "TB", "RL", "BT"].includes(direction)) {
      throw new TypeError("direction must be LR, TB, RL, or BT.");
    }
    const startGroup = options.startGroup === undefined ? null : options.startGroup;
    const endGroup = options.endGroup === undefined ? null : options.endGroup;
    const graphWidth = validateGraphWidth(options.graphWidth === undefined ? null : options.graphWidth);
    const requestedColumns = options.groupColumns === undefined ? {} : options.groupColumns;
    if (!requestedColumns || Object.prototype.toString.call(requestedColumns) !== "[object Object]") {
      throw new TypeError("groupColumns must map subpipeline keys to positive integers.");
    }
    const columnEntries = Object.entries(requestedColumns);
    if (columnEntries.some(([key, value]) => !key.length || !Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError("groupColumns must map subpipeline keys to positive integers.");
    }
    const groupColumns = Object.fromEntries(columnEntries);
    for (const key of [startGroup, endGroup]) {
      if (key !== null && (typeof key !== "string" || !key.length)) {
        throw new TypeError("Subpipeline positions must be a group key or null.");
      }
    }
    const byKey = new Map(graph.groups.map((group) => [group.key || group.id, group]));
    const byId = new Map(graph.groups.map((group) => [group.id, group]));
    if (!allowMissingGroups) {
      for (const key of [startGroup, endGroup, ...columnEntries.map(([key]) => key)]) {
        if (key !== null && !byKey.has(key)) {
          throw new RangeError("The selected subpipeline is not in the current pipeline.");
        }
      }
    }
    if (startGroup !== null && startGroup === endGroup) {
      throw new RangeError("Start and end subpipelines must be different, non-nested groups.");
    }
    const first = byKey.get(startGroup);
    const last = byKey.get(endGroup);
    if (first && last) {
      for (const [group, other] of [[first, last], [last, first]]) {
        const visited = new Set();
        let current = group;
        while (current) {
          if (current.id === other.id) {
            throw new RangeError("Start and end subpipelines must be different, non-nested groups.");
          }
          if (visited.has(current.id)) {
            throw new TypeError("Group hierarchy must not contain a cycle.");
          }
          visited.add(current.id);
          current = byId.get(current.parentId);
        }
      }
    }
    const sizedGroups = new Set(columnEntries.map(([key]) => byKey.get(key)?.id).filter((id) => id !== undefined));
    for (const group of graph.groups) {
      if (!sizedGroups.has(group.id) && group !== first && group !== last) continue;
      const visited = new Set([group.id]);
      let parent = byId.get(group.parentId);
      while (parent) {
        if (visited.has(parent.id)) throw new TypeError("Group hierarchy must not contain a cycle.");
        visited.add(parent.id);
        if (sizedGroups.has(parent.id)) {
          if (sizedGroups.has(group.id)) {
            throw new RangeError("Set target columns on either a subpipeline or its nested groups, not both.");
          }
          throw new RangeError("Target columns on a containing subpipeline conflict with a positioned nested subpipeline. Set columns on the nested subpipeline instead.");
        }
        parent = byId.get(parent.parentId);
      }
    }
    return { ...options, direction, startGroup, endGroup, groupColumns, graphWidth };
  }

  /** Reflow selected subtrees into columns, keeping their nested boxes intact. */
  function buildColumnLayout(graph, groupColumns, direction, groupChildren, groupNodes, phaseByNode) {
    const selected = graph.groups.filter((group) => Object.hasOwn(groupColumns, group.key || group.id));
    if (!selected.length) return null;

    // Source order is a stable tie-breaker; dependency order avoids making a
    // vertical column point back and forth when declarations are out of order.
    const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));
    const degrees = new Map(graph.nodes.map((node) => [node.id, 0]));
    for (const edge of graph.edges) {
      if (!outgoing.has(edge.from) || !outgoing.has(edge.to)) {
        throw new TypeError("Every graph edge must connect existing node IDs.");
      }
      outgoing.get(edge.from).push(edge.to);
      degrees.set(edge.to, degrees.get(edge.to) + 1);
    }
    const ready = graph.nodes.filter((node) => degrees.get(node.id) === 0).map((node) => node.id);
    const order = new Map();
    for (let position = 0; position < ready.length; position += 1) {
      const id = ready[position];
      order.set(id, order.size);
      for (const next of outgoing.get(id)) {
        degrees.set(next, degrees.get(next) - 1);
        if (degrees.get(next) === 0) ready.push(next);
      }
    }
    // Invalid cyclic pipelines still get a finite, deterministic preview.
    for (const node of graph.nodes) {
      if (!order.has(node.id)) order.set(node.id, order.size);
    }
    const firstByGroup = new Map(graph.groups.map((group) => [group.id, Infinity]));
    for (const node of graph.nodes) {
      if (node.groupId !== null) firstByGroup.set(node.groupId, Math.min(firstByGroup.get(node.groupId), order.get(node.id)));
    }
    const groupOrder = [];
    const pendingGroups = [...groupChildren.get(null)];
    while (pendingGroups.length) {
      const group = pendingGroups.pop();
      groupOrder.push(group);
      for (const child of groupChildren.get(group.id)) pendingGroups.push(child);
    }
    for (const group of groupOrder.reverse()) {
      if (group.parentId !== null) {
        firstByGroup.set(group.parentId, Math.min(firstByGroup.get(group.parentId), firstByGroup.get(group.id)));
      }
    }

    const ranks = [];
    const connections = [];
    const columns = new Map();
    const unitByNode = new Map(graph.nodes.map((node) => [node.id, node.id]));
    const horizontal = direction === "LR" || direction === "RL";
    for (const group of selected) {
      // Each child's rows form a separate band. Sharing a row across nested
      // boxes would force the boxes apart and defeat a narrow parent layout.
      const bands = [];
      const pending = [{ group }];
      while (pending.length) {
        const entry = pending.pop();
        if (entry.nodes) {
          bands.push(entry.nodes);
          continue;
        }
        const ownNodes = groupNodes.get(entry.group.id).slice().sort((a, b) => order.get(a.id) - order.get(b.id));
        const pieces = groupChildren.get(entry.group.id).map((child) => ({ group: child, first: firstByGroup.get(child.id) }));
        if (ownNodes.length) pieces.push({ nodes: ownNodes, first: order.get(ownNodes[0].id) });
        pieces.sort((a, b) => a.first - b.first);
        for (let position = pieces.length - 1; position >= 0; position -= 1) pending.push(pieces[position]);
      }
      const members = bands.flat();
      if (!members.length) continue;
      const count = Math.min(groupColumns[group.key || group.id], members.length);
      const regionRanks = [];
      if (horizontal) {
        const height = Math.ceil(members.length / count);
        for (let position = 0; position < members.length; position += height) {
          regionRanks.push(members.slice(position, position + height).map((node) => node.id));
        }
        for (let position = 1; position < regionRanks.length; position += 1) {
          connections.push([regionRanks[position - 1][0], regionRanks[position][0]]);
        }
      } else {
        const previousByColumn = new Map();
        for (const band of bands) {
          for (let position = 0; position < band.length; position += count) {
            const row = band.slice(position, position + count).map((node) => node.id);
            regionRanks.push(row);
            for (const [column, id] of row.entries()) {
              columns.set(id, `layout_column_${group.id}_${column}`);
              if (previousByColumn.has(column)) connections.push([previousByColumn.get(column), id]);
              previousByColumn.set(column, id);
            }
          }
        }
      }
      for (const rank of regionRanks) {
        ranks.push(rank);
        for (const id of rank) unitByNode.set(id, rank[0]);
      }
    }

    // Collapsing a -> outside -> b into one rank can create a ranking cycle
    // even though the dependency graph is acyclic. Find cycles on the quotient
    // graph and remove only their real-edge ranking constraints. All dependency
    // arrows remain visible; the explicit column layout takes precedence.
    const adjacency = new Map([...unitByNode.values()].map((id) => [id, []]));
    for (const [from, to] of connections) adjacency.get(unitByNode.get(from)).push(unitByNode.get(to));
    for (const edge of graph.edges) {
      const from = unitByNode.get(edge.from);
      const to = unitByNode.get(edge.to);
      if (from !== to && phaseByNode.get(edge.from) <= phaseByNode.get(edge.to)) adjacency.get(from).push(to);
    }
    const indices = new Map();
    const lowLinks = new Map();
    const stack = [];
    const onStack = new Set();
    const componentByUnit = new Map();
    let nextIndex = 0;
    let nextComponent = 0;
    const enter = (id) => {
      indices.set(id, nextIndex);
      lowLinks.set(id, nextIndex++);
      stack.push(id);
      onStack.add(id);
      return { id, neighbors: adjacency.get(id).values() };
    };
    for (const root of adjacency.keys()) {
      if (indices.has(root)) continue;
      const frames = [enter(root)];
      while (frames.length) {
        const frame = frames[frames.length - 1];
        const neighbor = frame.neighbors.next();
        if (!neighbor.done) {
          if (!indices.has(neighbor.value)) frames.push(enter(neighbor.value));
          else if (onStack.has(neighbor.value)) lowLinks.set(frame.id, Math.min(lowLinks.get(frame.id), indices.get(neighbor.value)));
          continue;
        }
        frames.pop();
        if (frames.length) {
          const parent = frames[frames.length - 1].id;
          lowLinks.set(parent, Math.min(lowLinks.get(parent), lowLinks.get(frame.id)));
        }
        if (lowLinks.get(frame.id) === indices.get(frame.id)) {
          let id;
          do {
            id = stack.pop();
            onStack.delete(id);
            componentByUnit.set(id, nextComponent);
          } while (id !== frame.id);
          nextComponent += 1;
        }
      }
    }
    const nonRankingEdges = new Set();
    for (const [position, edge] of graph.edges.entries()) {
      if (componentByUnit.get(unitByNode.get(edge.from)) === componentByUnit.get(unitByNode.get(edge.to))) {
        nonRankingEdges.add(position);
      }
    }
    return { ranks, connections, columns, nonRankingEdges };
  }

  /** Render the same graph data as Graphviz DOT for both the webview and export. */
  function buildGraphDot(graph, options = {}) {
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.groups)) {
      throw new TypeError("graph must contain nodes, edges, and groups arrays.");
    }
    // A saved pin may be absent from an upstream view. Keep it dormant until
    // the complete pipeline is restored; validate full-graph choices in the UI.
    const { direction, startGroup, endGroup, groupColumns } = validateGraphLayout(graph, options, true);
    if (options.scaleNodes !== undefined && typeof options.scaleNodes !== "boolean") {
      throw new TypeError("scaleNodes must be true or false.");
    }
    const palette = [
      ["#EDF5FF", "#9FBDE0"], ["#ECF7F0", "#9EC9AC"],
      ["#FFF4E6", "#D6B68F"], ["#F3EEFC", "#B8A6D6"],
      ["#E9F7F7", "#98C8CC"], ["#FCEDF2", "#D7A5B9"]
    ];
    const statusColors = {
      last_error: "#FADAD5", errored: "#FADAD5", error: "#FADAD5",
      last_warning: "#FFF0BD", warning: "#FFF0BD",
      canceled: "#E4E7ED", cancelled: "#E4E7ED",
      built: "#DCF0E2", uptodate: "#DCF0E2", completed: "#DCF0E2",
      unbuilt: "#E5EAF8", outdated: "#FBE4C5", missing: "#FBE4C5",
      started: "#D8EEFA", running: "#D8EEFA", queued: "#E9DFF8",
      dispatched: "#E9DFF8", skipped: "#ECEFF3", unknown: "#ECEFF3"
    };
    const statusLabels = {
      last_error: "Last build: error", last_warning: "Last build: warning",
      built: "Previously built", unbuilt: "No recorded build", canceled: "Last run: canceled"
    };
    const nodeIds = new Map(graph.nodes.map((node, position) => [node.id, `n${position}`]));
    const groupIds = new Map(graph.groups.map((group, position) => [group.id, `g${position}`]));
    const groupChildren = new Map([[null, []]]);
    const groupNodes = new Map([[null, []]]);
    for (const group of graph.groups) {
      groupChildren.set(group.id, []);
      groupNodes.set(group.id, []);
    }
    for (const group of graph.groups) {
      if (group.parentId !== null && !groupIds.has(group.parentId)) {
        throw new TypeError(`Group ${JSON.stringify(group.id)} has an unknown parent.`);
      }
      groupChildren.get(group.parentId).push(group);
    }
    for (const node of graph.nodes) {
      if (node.groupId !== null && !groupIds.has(node.groupId)) {
        throw new TypeError(`Node ${JSON.stringify(node.id)} has an unknown group.`);
      }
      groupNodes.get(node.groupId).push(node);
    }
    const pinnedStart = graph.groups.find((group) => (group.key || group.id) === startGroup);
    const pinnedEnd = graph.groups.find((group) => (group.key || group.id) === endGroup);
    const phaseByGroup = new Map([[null, 1]]);
    const phasesPending = groupChildren.get(null).map((group) => ({ group, phase: 1 }));
    while (phasesPending.length) {
      const { group, phase: inheritedPhase } = phasesPending.pop();
      if (phaseByGroup.has(group.id)) {
        throw new TypeError("Group hierarchy must not contain a cycle or duplicate IDs.");
      }
      const phase = group.id === pinnedStart?.id ? 0 : group.id === pinnedEnd?.id ? 2 : inheritedPhase;
      phaseByGroup.set(group.id, phase);
      for (const child of groupChildren.get(group.id)) {
        phasesPending.push({ group: child, phase });
      }
    }
    if (phaseByGroup.size - 1 !== graph.groups.length) {
      throw new TypeError("Group hierarchy must not contain a cycle or duplicate IDs.");
    }
    const phaseByNode = new Map(graph.nodes.map((node) => [node.id, phaseByGroup.get(node.groupId)]));
    const columnLayout = buildColumnLayout(graph, groupColumns, direction, groupChildren, groupNodes, phaseByNode);
    let maximumDegree = 1;
    for (const node of graph.nodes) {
      maximumDegree = Math.max(maximumDegree, node.inDegree + node.outDegree);
    }
    const focusNames = Array.isArray(graph.upstreamTargets) ? graph.upstreamTargets
      : graph.upstreamTarget ? [graph.upstreamTarget] : [];
    const focusCaption = focusNames.length === 1 ? `Upstream of ${focusNames[0]}`
      : [`Upstream of ${focusNames.length} targets`, ...focusNames.slice(0, 4),
        ...(focusNames.length > 4 ? [`and ${focusNames.length - 4} more selected targets`] : [])].join("\n");
    const caption = focusNames.length
      ? `${focusCaption}\n` + (graph.graphSource === "static"
        ? "Static dependency preview\nBuild colors show history; freshness unchecked"
        : "Dependencies and status supplied by targets")
      : graph.graphSource === "static"
        ? "Static dependencies | Colors describe the last recorded build, not current freshness"
        : "Dependencies and status supplied by targets";
    const output = [
      "digraph targets_pipeline {",
      `  graph [rankdir=${direction}, bgcolor=\"transparent\", compound=true, newrank=true,`,
      "    fontname=\"Arial\", fontsize=12, nodesep=0.30, ranksep=0.70, pad=0.30,",
      `    labelloc=b, label=${quoteDot(caption)}, fontcolor=\"#64748B\"];`,
      "  node [shape=box, style=\"rounded,filled\", fontname=\"Arial\", fontsize=11,",
      "    margin=\"0.16,0.10\", height=0.42, color=\"#AAB6C6\", fontcolor=\"#25334A\", penwidth=1.0];",
      "  edge [color=\"#7E8CA1\", arrowsize=0.65, penwidth=0.95];"
    ];

    // Emit a nested cluster tree, placing each target in exactly one cluster.
    const pending = [{ parentId: null, depth: 1, close: false }];
    const emittedGroups = new Set();
    while (pending.length) {
      const entry = pending.pop();
      const indent = "  ".repeat(entry.depth);
      if (entry.close) {
        output.push(`${indent}}`);
        continue;
      }
      const group = entry.group;
      if (group) {
        if (emittedGroups.has(group.id)) {
          throw new TypeError("Group hierarchy must not contain a cycle.");
        }
        emittedGroups.add(group.id);
        const id = groupIds.get(group.id);
        const colorIndex = Number.isInteger(group.colorIndex) && group.colorIndex >= 0
          ? group.colorIndex : Number(id.slice(1));
        const colors = palette[colorIndex % palette.length];
        output.push(`${indent}subgraph cluster_${id} {`);
        output.push(`${indent}  graph [id=${quoteDot(`group_${id}`)}, label=${quoteDot(group.label)},`);
        output.push(`${indent}    style=\"rounded,filled\", color=${quoteDot(colors[1])}, fillcolor=${quoteDot(colors[0])},`);
        output.push(`${indent}    fontcolor=\"#334155\", fontsize=14, labelloc=t, labeljust=l, margin=20, penwidth=1.2];`);
        pending.push({ depth: entry.depth, close: true });
      }
      const contentIndent = group ? `${indent}  ` : indent;
      for (const node of groupNodes.get(entry.parentId)) {
        const id = nodeIds.get(node.id);
        const degree = node.inDegree + node.outDegree;
        const scale = options.scaleNodes ? Math.sqrt(degree / maximumDegree) : 0;
        const color = statusColors[node.status] || statusColors.unknown;
        const statusText = graph.graphSource === "static" ? (statusLabels[node.status] || node.status) : node.status;
        const tooltip = `${node.name}\n${statusText}\n${node.inDegree} upstream, ${node.outDegree} downstream`
          + (node.file ? `\n${node.file}:${node.line}` : "");
        output.push(`${contentIndent}${id} [id=${quoteDot(`node_${id}`)}, label=${quoteDot(node.name)},`);
        output.push(`${contentIndent}  fillcolor=${quoteDot(color)}, tooltip=${quoteDot(tooltip)}, fontsize=${(11 + 4 * scale).toFixed(2)}, penwidth=${(1 + scale).toFixed(2)}];`);
      }
      const children = groupChildren.get(entry.parentId);
      for (let position = children.length - 1; position >= 0; position -= 1) {
        pending.push({ group: children[position], parentId: children[position].id, depth: group ? entry.depth + 1 : entry.depth, close: false });
      }
    }
    if (emittedGroups.size !== graph.groups.length) {
      throw new TypeError("Group hierarchy must not contain a cycle or duplicate IDs.");
    }
    for (const [position, edge] of graph.edges.entries()) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        throw new TypeError("Every graph edge must connect existing node IDs.");
      }
      // Explicit box positions take precedence over rank suggestions from
      // conflicting dependencies. Their visible arrows retain their direction.
      const ranking = phaseByNode.get(edge.from) > phaseByNode.get(edge.to) || columnLayout?.nonRankingEdges.has(position)
        ? " [constraint=false]" : "";
      output.push(`  ${nodeIds.get(edge.from)} -> ${nodeIds.get(edge.to)}${ranking};`);
    }

    if (columnLayout) {
      for (const rank of columnLayout.ranks) {
        output.push(`  { rank=same; ${rank.map((id) => nodeIds.get(id)).join("; ")}; }`);
      }
      for (const [id, column] of columnLayout.columns) {
        output.push(`  ${nodeIds.get(id)} [group=${quoteDot(column)}];`);
      }
      for (const [from, to] of columnLayout.connections) {
        output.push(`  ${nodeIds.get(from)} -> ${nodeIds.get(to)} [style=invis, weight=1000];`);
      }
    }

    // Invisible boundary nodes separate every target in a pinned subtree from
    // all other targets, without flattening the subtree's internal DAG ranks.
    // Two linear-size fans avoid generating every pair of cross-group edges.
    for (const [phase, boundary] of [[0, "layout_start_boundary"], [2, "layout_end_boundary"]]) {
      if (!graph.nodes.some((node) => phaseByNode.get(node.id) === phase)
        || !graph.nodes.some((node) => phaseByNode.get(node.id) !== phase)) {
        continue;
      }
      output.push(`  ${boundary} [shape=point, width=0, height=0, fixedsize=true, label="", style=invis];`);
      for (const node of graph.nodes) {
        const inGroup = phaseByNode.get(node.id) === phase;
        const before = phase === 0 ? inGroup : !inGroup;
        const id = nodeIds.get(node.id);
        output.push(`  ${before ? id : boundary} -> ${before ? boundary : id} [style=invis, weight=100, minlen=1];`);
      }
    }

    if (options.legend !== false && graph.nodes.length) {
      const statuses = [...new Set(graph.nodes.map((node) => node.status))];
      output.push("  subgraph cluster_legend {");
      output.push(`    label=${quoteDot(graph.graphSource === "static" ? "Last recorded build" : "Targets status")};`);
      output.push("    style=\"rounded\"; color=\"#D9E0EA\"; fontcolor=\"#64748B\"; fontsize=10; labelloc=t; margin=10;");
      for (const [position, status] of statuses.entries()) {
        const label = graph.graphSource === "static" ? (statusLabels[status] || status) : status;
        output.push(`    legend_${position} [label=${quoteDot(label)}, fillcolor=${quoteDot(statusColors[status] || statusColors.unknown)}, fontsize=9, height=0.25, margin=\"0.09,0.05\"];`);
        if (position) {
          output.push(`    legend_${position - 1} -> legend_${position} [style=invis];`);
        }
      }
      output.push("  }");
    }
    output.push("}");
    return output.join("\n");
  }

  /** Measure pipeline content, excluding invisible layout helpers and padding. */
  function measureGraphWidth(layout) {
    let left = Infinity;
    let right = -Infinity;
    let firstCenter = Infinity;
    let lastCenter = -Infinity;
    for (const object of layout.objects || []) {
      if (/^node_n\d+$/.test(object.id)) {
        const center = Number(object.pos.split(",")[0]);
        const halfWidth = Number(object.width) * 36;
        left = Math.min(left, center - halfWidth);
        right = Math.max(right, center + halfWidth);
        firstCenter = Math.min(firstCenter, center);
        lastCenter = Math.max(lastCenter, center);
      } else if (/^group_g\d+$/.test(object.id)) {
        const box = object.bb.split(",").map(Number);
        left = Math.min(left, box[0]);
        right = Math.max(right, box[2]);
      }
    }
    // DOT positions and cluster bounds are points; the control uses CSS pixels.
    return {
      width: Number.isFinite(left) && Number.isFinite(right) ? (right - left) * 4 / 3 : 0,
      span: Number.isFinite(firstCenter) && Number.isFinite(lastCenter) ? (lastCenter - firstCenter) * 4 / 3 : 0
    };
  }

  /** Expand horizontal spacing with a bounded number of measured DOT layouts. */
  function renderGraphLayout(viz, dot, graphWidth = null) {
    validateGraphWidth(graphWidth);
    if (graphWidth === null) {
      return { dot, svg: viz.renderString(dot, { engine: "dot", format: "svg" }), widthInfo: null };
    }
    const naturalLayout = JSON.parse(viz.renderString(dot, { engine: "dot", format: "json" }));
    const natural = measureGraphWidth(naturalLayout);
    const tolerance = Math.max(2, graphWidth * 0.02);
    let best = { dot, ...natural };
    let reason = graphWidth < natural.width - tolerance ? "natural-minimum" : null;
    if (graphWidth > natural.width + tolerance) {
      if (natural.span < 0.5) {
        reason = "no-horizontal-room";
      } else {
        const horizontal = naturalLayout.rankdir === "LR" || naturalLayout.rankdir === "RL";
        const attribute = horizontal ? "ranksep" : "nodesep";
        const baseSpacing = Number.parseFloat(naturalLayout[attribute]) || (horizontal ? 0.7 : 0.3);
        const maximumSpacing = Math.max(baseSpacing, graphWidth / 96);
        let spacing = Math.min(maximumSpacing, Math.max(baseSpacing + 0.05, baseSpacing * graphWidth / natural.width));
        const attempted = new Set();
        // One natural layout and at most three candidates, followed by the SVG
        // render. The final DOT records ordinary spacing attributes, so exporting
        // and rendering it elsewhere reproduces the same positions and fonts.
        for (let pass = 0; pass < 3; pass += 1) {
          const value = spacing.toFixed(6);
          if (attempted.has(value)) break;
          attempted.add(value);
          const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"[^"]*"|[^,;\\]\\s]+)`);
          const candidateDot = pattern.test(dot) ? dot.replace(pattern, `${attribute}=${value}`)
            : `${dot.slice(0, dot.lastIndexOf("}"))}\n  graph [${attribute}=${value}];\n}`;
          const candidate = measureGraphWidth(JSON.parse(viz.renderString(candidateDot, { engine: "dot", format: "json" })));
          if (candidate.span > natural.span + 0.5 && candidate.width >= natural.width
            && Math.abs(candidate.width - graphWidth) <= Math.abs(best.width - graphWidth)) {
            best = { dot: candidateDot, ...candidate };
          }
          if (Math.abs(best.width - graphWidth) <= tolerance) break;
          const growth = candidate.width - natural.width;
          const estimate = growth > 0.5
            ? baseSpacing + (graphWidth - natural.width) * (spacing - baseSpacing) / growth
            : Math.max(spacing * 2, spacing + 0.5);
          spacing = Math.min(maximumSpacing, Math.max(baseSpacing + 0.01, estimate));
        }
        if (Math.abs(best.width - graphWidth) > tolerance) {
          reason = best.span <= natural.span + 0.5 ? "no-horizontal-room" : "layout-limit";
        }
      }
    }
    return {
      dot: best.dot,
      svg: viz.renderString(best.dot, { engine: "dot", format: "svg" }),
      widthInfo: {
        requested: graphWidth,
        natural: Math.round(natural.width * 100) / 100,
        actual: Math.round(best.width * 100) / 100,
        limited: reason !== null,
        reason
      }
    };
  }

  const api = { buildGraphDot, filterGraphUpstream, validateGraphLayout, renderGraphLayout };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TarboristGraphModel = api;
  }
})();
