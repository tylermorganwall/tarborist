"use strict";

(() => {
  const payload = JSON.parse(document.getElementById("pipeline-data").textContent);
  const fullGraph = payload.graph;
  let graph = payload.viewGraph || fullGraph;
  let dot = payload.dot;
  let widthInfo = payload.widthInfo || null;
  let renderOptions = { direction: "LR", startGroup: null, endGroup: null, groupColumns: {}, graphWidth: null, ...payload.renderOptions };
  const fullGroups = new Map(fullGraph.groups.map((group) => [group.key, group]));
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  const elements = {};
  for (const element of document.querySelectorAll("[id]")) {
    elements[element.id] = element;
  }
  let nodes = new Map();
  let groups = new Map();
  let upstreamTargets = [];
  const nodeElements = new Map();
  const edgeElements = new Map();
  const groupElements = new Map();
  const viewport = elements["graph-viewport"];
  let svg = viewport.querySelector("svg");
  const state = {
    selected: new Set(), inspected: null, inspectedGroup: null,
    search: "", group: "", pan: null, suppressGroupClick: false, busy: false, contextMenu: null
  };
  let originalBox = [0, 0, 1, 1];
  let viewBox = originalBox.slice();
  let layoutWorker;
  let layoutRequest = 0;
  let pendingLayout;

  function relativeFile(file) {
    const root = String(fullGraph.workspaceRoot || "").replace(/\\/g, "/").replace(/\/$/, "");
    const normalized = String(file || "").replace(/\\/g, "/");
    return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  }

  function openTargetDefinition(node) {
    if (!node?.file) {
      return;
    }
    if (vscode) {
      vscode.postMessage({ type: "openTarget", name: node.name });
      return;
    }
    const query = new URLSearchParams({ target: node.name });
    if (fullGraph.rootFile) {
      query.set("pipeline", fullGraph.rootFile);
    }
    const link = document.createElement("a");
    // The editor decodes its URI query before handing it to the extension.
    link.href = `positron://tylermorganwall.tarborist/open-target?${encodeURIComponent(query.toString())}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.click();
  }

  function closeContextMenu(restoreFocus = false) {
    const menu = state.contextMenu;
    if (!menu) {
      return;
    }
    elements["target-context-menu"].hidden = true;
    menu.owner.setAttribute("aria-expanded", "false");
    state.contextMenu = null;
    if (restoreFocus) {
      (menu.owner.isConnected ? menu.owner : viewport).focus({ preventScroll: true });
    }
  }

  function openContextMenu(id, clientX, clientY) {
    const node = nodes.get(id);
    const owner = nodeElements.get(id);
    if (!node || !owner) {
      return;
    }
    closeContextMenu();
    state.contextMenu = { name: node.name, owner };
    owner.setAttribute("aria-expanded", "true");
    const menu = elements["target-context-menu"];
    menu.setAttribute("aria-label", `Actions for target ${node.name}`);
    elements["context-target-name"].textContent = node.name;
    elements["context-open-source"].textContent = vscode ? "Open definition" : "Open definition in Positron";
    elements["context-open-source"].setAttribute("aria-disabled", String(!node.file));
    elements["context-source-note"].textContent = !node.file ? "No source definition was found for this target."
      : vscode ? `${relativeFile(node.file)}:${node.line || 1}:${node.character || 1}`
        : "Requires updated tarborist and the matching project open in Positron.";
    menu.style.left = "0px";
    menu.style.top = "0px";
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    const targetBox = owner.getBoundingClientRect();
    const x = clientX ?? targetBox.left + targetBox.width / 2;
    const y = clientY ?? targetBox.bottom;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    elements["context-open-source"].focus({ preventScroll: true });
  }

  function groupPath(groupId) {
    const labels = [];
    const visited = new Set();
    while (groups.has(groupId) && !visited.has(groupId)) {
      visited.add(groupId);
      const group = groups.get(groupId);
      labels.unshift(group.label);
      groupId = group.parentId;
    }
    return labels.join(" / ") || "Ungrouped";
  }

  function selectedTargetNames() {
    return [...state.selected].map((id) => nodes.get(id)?.name).filter((name) => name !== undefined);
  }

  function matchesUpstreamFilter(names) {
    const focus = new Set(upstreamTargets);
    return names.length === focus.size && names.every((name) => focus.has(name));
  }

  function saveState() {
    vscode?.setState({
      selectedNames: selectedTargetNames(),
      inspectedName: nodes.get(state.inspected)?.name || null,
      inspectedGroup: state.inspectedGroup,
      search: state.search,
      group: state.group,
      groupPath: state.group ? groupPath(state.group) : null,
      upstreamTargets
    });
  }

  function nodeMatchesFilter(node) {
    if (state.search && !node.name.toLowerCase().includes(state.search)) {
      return false;
    }
    if (!state.group) {
      return true;
    }
    if (state.group === "__ungrouped__") {
      return !node.groupId;
    }
    const visited = new Set();
    let groupId = node.groupId;
    while (groupId && !visited.has(groupId)) {
      if (groupId === state.group) {
        return true;
      }
      visited.add(groupId);
      groupId = groups.get(groupId)?.parentId;
    }
    return false;
  }

  function updateHighlight() {
    const matching = new Set(graph.nodes.filter(nodeMatchesFilter).map((node) => node.id));
    const neighborhood = new Set(state.selected);
    for (const edge of graph.edges) {
      if (state.selected.has(edge.from) || state.selected.has(edge.to)) {
        neighborhood.add(edge.from);
        neighborhood.add(edge.to);
      }
    }
    const filtering = Boolean(state.search || state.group);
    const focused = upstreamTargets.length > 0;
    const highlightedNodes = new Set();
    for (const [id, element] of nodeElements) {
      // An upstream view shows every retained ancestor at full opacity.
      // Selecting an ancestor inspects it without changing the filter's focus.
      const selected = state.selected.has(id);
      const highlighted = focused ? matching.has(id) || selected
        : (matching.has(id) && (!state.selected.size || filtering)) || neighborhood.has(id);
      element.classList.toggle("is-muted", !highlighted);
      element.classList.toggle("is-selected", selected);
      element.classList.toggle("is-match", filtering && matching.has(id) && !selected);
      element.setAttribute("aria-pressed", String(selected));
      if (highlighted) {
        highlightedNodes.add(id);
      }
    }
    for (const edge of graph.edges) {
      const element = edgeElements.get(`${edge.from}->${edge.to}`);
      if (element) {
        const related = state.selected.has(edge.from) || state.selected.has(edge.to);
        const muted = !focused && state.selected.size && !filtering ? !related
          : !highlightedNodes.has(edge.from) || !highlightedNodes.has(edge.to);
        element.classList.toggle("is-muted", muted);
        element.classList.toggle("is-related", related);
      }
    }
    const highlightedGroups = new Set();
    for (const id of highlightedNodes) {
      let groupId = nodes.get(id)?.groupId;
      const visited = new Set();
      while (groupId && !visited.has(groupId)) {
        visited.add(groupId);
        highlightedGroups.add(groupId);
        groupId = groups.get(groupId)?.parentId;
      }
    }
    for (const [id, element] of groupElements) {
      const selected = groups.get(id)?.key === state.inspectedGroup;
      element.classList.toggle("is-muted", !highlightedGroups.has(id) && !selected);
      element.classList.toggle("is-group-selected", selected);
      element.setAttribute("aria-pressed", String(selected));
    }
    elements["filter-summary"].textContent = filtering
      ? `${matching.size} of ${nodes.size} displayed targets match; ${state.selected.size} selected`
      : focused ? `Filter keeps ${upstreamTargets.length} focus ${upstreamTargets.length === 1 ? "target" : "targets"} and ${nodes.size - upstreamTargets.length} upstream dependencies`
        : state.selected.size ? `${state.selected.size} ${state.selected.size === 1 ? "target" : "targets"} selected; direct dependencies and dependents highlighted`
          : `${nodes.size} targets in ${groups.size} subpipelines`;
  }

  function selectTarget(id, toggle = false) {
    state.inspectedGroup = null;
    if (!nodes.has(id)) {
      state.selected.clear();
      state.inspected = null;
    } else if (toggle) {
      if (state.selected.has(id)) {
        state.selected.delete(id);
        if (state.inspected === id) {
          state.inspected = [...state.selected].at(-1) || null;
        }
      } else {
        state.selected.add(id);
        state.inspected = id;
      }
    } else {
      state.selected = new Set([id]);
      state.inspected = id;
    }
    updateSelection();
  }

  function selectGroup(key) {
    if (fullGroups.has(key)) {
      state.inspectedGroup = key;
      updateSelection();
    }
  }

  function restoreSelection(names, inspectedName) {
    const byName = new Map(graph.nodes.map((node) => [node.name, node.id]));
    state.selected = new Set(names.map((name) => byName.get(name)).filter((id) => id !== undefined));
    const inspected = byName.get(inspectedName);
    state.inspected = state.selected.has(inspected) ? inspected : [...state.selected].at(-1) || null;
    updateSelection();
  }

  function updateSelection() {
    const node = nodes.get(state.inspected);
    const group = fullGroups.get(state.inspectedGroup);
    const names = selectedTargetNames();
    elements["inspector-title"].textContent = group ? "SUBPIPELINE LAYOUT" : "TARGET INSPECTOR";
    elements["inspector-empty"].hidden = Boolean(node || group);
    elements["target-details"].hidden = !node || Boolean(group);
    elements["group-details"].hidden = !group;
    elements["clear-selection"].hidden = !node || Boolean(group);
    elements["back-to-targets"].hidden = !group;
    elements["upstream-only"].disabled = state.busy || !names.length || matchesUpstreamFilter(names);
    elements["selection-count"].textContent = `${names.length} ${names.length === 1 ? "target" : "targets"} selected`;
    elements["selected-targets"].replaceChildren();
    for (const name of names) {
      const item = document.createElement("li");
      item.textContent = name;
      elements["selected-targets"].appendChild(item);
    }
    if (node) {
      elements["target-name"].textContent = node.name;
      elements["target-status"].textContent = String(node.status || "unknown").replace(/_/g, " ");
      elements["target-group"].textContent = groupPath(node.groupId);
      elements["target-location"].textContent = node.file
        ? `${relativeFile(node.file)}:${node.line || 1}:${node.character || 1}`
        : "No static source location";
      elements["target-location"].title = node.file || "";
      elements["target-origin"].textContent = node.generated ? "Generated target" : "Direct target";
      elements["target-command"].textContent = node.command || "Command unavailable in static analysis.";
      elements["open-source"].disabled = !node.file;
      elements["open-source"].title = !node.file ? "No source definition was found for this target."
        : vscode ? "Open this target's definition" : "Open this target's definition in Positron";
      const upstream = graph.edges.filter((edge) => edge.to === node.id).map((edge) => nodes.get(edge.from)).filter(Boolean);
      const downstream = graph.edges.filter((edge) => edge.from === node.id).map((edge) => nodes.get(edge.to)).filter(Boolean);
      elements["upstream-count"].textContent = String(upstream.length);
      elements["downstream-count"].textContent = String(downstream.length);
      for (const [direction, neighbors] of [["upstream", upstream], ["downstream", downstream]]) {
        const list = elements[`${direction}-list`];
        list.replaceChildren();
        if (!neighbors.length) {
          const item = document.createElement("li");
          item.className = "empty-neighbors";
          item.textContent = "None";
          list.appendChild(item);
        }
        for (const neighbor of neighbors) {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = neighbor.name;
          button.addEventListener("click", (event) => selectTarget(neighbor.id, event.shiftKey));
          item.appendChild(button);
          list.appendChild(item);
        }
      }
    }
    updateLayoutControls();
    saveState();
    updateHighlight();
  }

  function updateLayoutControls() {
    const [startSide, endSide] = { LR: ["left", "right"], TB: ["top", "bottom"], RL: ["right", "left"], BT: ["bottom", "top"] }[renderOptions.direction];
    const pinned = Boolean(renderOptions.startGroup || renderOptions.endGroup);
    const widths = Object.entries(renderOptions.groupColumns);
    const visibleKeys = new Set(graph.groups.map((group) => group.key));
    const layoutDescriptions = [];
    for (const [side, key] of [[startSide, renderOptions.startGroup], [endSide, renderOptions.endGroup]]) {
      const group = fullGroups.get(key);
      if (group) {
        layoutDescriptions.push(`${side[0].toUpperCase()}${side.slice(1)}: ${group.label}${visibleKeys.has(key) ? "" : " (hidden)"}`);
      }
    }
    for (const [key, columns] of widths) {
      const group = fullGroups.get(key);
      if (group) {
        layoutDescriptions.push(`${group.label}: ${columns} ${columns === 1 ? "column" : "columns"}${visibleKeys.has(key) ? "" : " (hidden)"}`);
      }
    }
    elements["layout-summary"].textContent = layoutDescriptions.length
      ? layoutDescriptions.join("; ") : "Click a subpipeline box to set its position and width.";
    elements["clear-pins"].hidden = !pinned;
    elements["clear-pins"].disabled = state.busy;
    elements["reset-layout"].disabled = state.busy || (!pinned && !widths.length && !renderOptions.graphWidth && renderOptions.direction === "LR");
    elements["graph-width"].value = renderOptions.graphWidth || "";
    elements["graph-width"].disabled = state.busy;
    elements["apply-graph-width"].disabled = state.busy;
    elements["clear-graph-width"].disabled = state.busy || !renderOptions.graphWidth;
    elements["graph-width-result"].hidden = !widthInfo;
    elements["graph-width-result"].textContent = "";
    if (widthInfo) {
      const actual = Math.round(widthInfo.actual).toLocaleString("en-US");
      const requested = widthInfo.requested.toLocaleString("en-US");
      let message = `Drawing width: ${actual} px; requested ${requested} px.`;
      if (widthInfo.reason === "natural-minimum") {
        message += " The natural layout is wider, so it keeps its original size.";
      } else if (widthInfo.reason === "no-horizontal-room") {
        message += " This layout has no horizontal gaps to expand.";
      } else if (widthInfo.limited) {
        message += " The requested width could not be reached with additional spacing.";
      }
      elements["graph-width-result"].textContent = message;
    }
    elements["flow-direction"].disabled = state.busy;
    if (!state.busy) {
      elements["flow-direction"].value = renderOptions.direction;
    }
    const group = fullGroups.get(state.inspectedGroup);
    elements["pin-start"].textContent = `Pin ${startSide}`;
    elements["pin-end"].textContent = `Pin ${endSide}`;
    elements["pin-start"].disabled = state.busy || !group || renderOptions.startGroup === group.key;
    elements["pin-end"].disabled = state.busy || !group || renderOptions.endGroup === group.key;
    elements["clear-group-pin"].disabled = state.busy || !group
      || (renderOptions.startGroup !== group.key && renderOptions.endGroup !== group.key);
    elements["group-columns"].disabled = state.busy || !group;
    elements["group-columns"].value = group ? renderOptions.groupColumns[group.key] || "" : "";
    elements["apply-group-width"].disabled = state.busy || !group;
    elements["clear-group-width"].disabled = state.busy || !group || !renderOptions.groupColumns[group.key];
    if (!group) {
      return;
    }
    elements["selected-group-name"].textContent = group.label;
    elements["selected-group-visibility"].textContent = visibleKeys.has(group.key) ? "Shown in graph" : "Hidden by filter";
    elements["selected-group-location"].textContent = group.file
      ? `${relativeFile(group.file)}:${group.line || 1}:${group.character || 1}` : "No static source location";
    elements["selected-group-location"].title = group.file || "";
    elements["selected-group-pin"].textContent = renderOptions.startGroup === group.key ? `Pinned ${startSide}`
      : renderOptions.endGroup === group.key ? `Pinned ${endSide}` : "Automatic placement";
    let count = 0;
    for (const node of graph.nodes) {
      let groupId = node.groupId;
      const visited = new Set();
      while (groups.has(groupId) && !visited.has(groupId)) {
        visited.add(groupId);
        const ancestor = groups.get(groupId);
        if (ancestor.key === group.key) {
          count += 1;
          break;
        }
        groupId = ancestor.parentId;
      }
    }
    elements["selected-group-count"].textContent = `${count} displayed ${count === 1 ? "target" : "targets"}, including nested subpipelines.`;
  }

  function setBusy(busy) {
    state.busy = busy;
    if (busy) {
      closeContextMenu(true);
    }
    viewport.setAttribute("aria-busy", String(busy));
    elements["target-search"].disabled = busy;
    elements["group-filter"].disabled = busy;
    elements["export-dot"].disabled = busy || (!vscode && !dot);
    elements["export-svg"].disabled = busy || !svg;
    elements["show-all"].disabled = busy;
    elements["upstream-only"].disabled = busy || !state.selected.size || matchesUpstreamFilter(selectedTargetNames());
    elements["refresh"].disabled = busy || !vscode;
    updateLayoutControls();
  }

  function showStatus(message, error = false) {
    elements["graph-status"].textContent = message;
    elements["graph-status"].hidden = !message;
    elements["graph-status"].classList.toggle("is-error", error);
  }

  function setViewBox(next) {
    if (!svg) {
      return;
    }
    closeContextMenu(true);
    viewBox = next;
    svg.setAttribute("viewBox", viewBox.join(" "));
    elements["zoom-level"].textContent = `${Math.round(100 * originalBox[2] / viewBox[2])}%`;
  }

  function pointAt(clientX, clientY) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
  }

  function zoom(factor, anchor) {
    if (!svg) {
      return;
    }
    const width = Math.min(originalBox[2] * 8, Math.max(originalBox[2] * .015, viewBox[2] * factor));
    const ratio = width / viewBox[2];
    const center = anchor || { x: viewBox[0] + viewBox[2] / 2, y: viewBox[1] + viewBox[3] / 2 };
    setViewBox([
      center.x + (viewBox[0] - center.x) * ratio,
      center.y + (viewBox[1] - center.y) * ratio,
      width,
      viewBox[3] * ratio
    ]);
  }

  function download(contents, mime, extension) {
    const suffix = upstreamTargets.length > 1 ? `-upstream-${upstreamTargets.length}-targets`
      : upstreamTargets.length ? `-upstream-${upstreamTargets[0].replace(/[^A-Za-z0-9_.-]/g, "_")}` : "";
    const url = URL.createObjectURL(new Blob([contents], { type: mime }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pipeline${suffix}.${extension}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderStandaloneGraph(source, graphWidth) {
    if (!payload.layoutWorkerText) {
      return Promise.reject(new Error("The offline graph renderer is unavailable. Regenerate this HTML with the current tarborist CLI."));
    }
    if (!layoutWorker) {
      const url = URL.createObjectURL(new Blob([payload.layoutWorkerText], { type: "text/javascript" }));
      try {
        layoutWorker = new Worker(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      layoutWorker.onmessage = ({ data }) => {
        if (!pendingLayout || data.id !== pendingLayout.id) {
          return;
        }
        const task = pendingLayout;
        pendingLayout = null;
        if (data.error) {
          task.reject(new Error(data.error));
        } else {
          task.resolve({ dot: data.dot, svg: data.svg, widthInfo: data.widthInfo });
        }
      };
      layoutWorker.onerror = (event) => {
        pendingLayout?.reject(new Error(event.message || "Unable to lay out the graph."));
        pendingLayout = null;
        layoutWorker.terminate();
        layoutWorker = null;
      };
    }
    return new Promise((resolve, reject) => {
      const id = ++layoutRequest;
      pendingLayout = { id, resolve, reject };
      layoutWorker.postMessage({ id, dot: source, graphWidth });
    });
  }

  async function setUpstreamFilter(names) {
    if (state.busy || matchesUpstreamFilter(names)) {
      return;
    }
    state.search = "";
    state.group = "";
    elements["target-search"].value = "";
    elements["group-filter"].value = "";
    await updateGraph(names, renderOptions, "filter");
  }

  async function setLayout(changes) {
    const options = { ...renderOptions, ...changes };
    const sameWidths = Object.keys(options.groupColumns).length === Object.keys(renderOptions.groupColumns).length
      && Object.entries(options.groupColumns).every(([key, columns]) => renderOptions.groupColumns[key] === columns);
    if (state.busy || (sameWidths && ["direction", "startGroup", "endGroup", "graphWidth"].every((key) => options[key] === renderOptions[key]))) {
      return;
    }
    await updateGraph(upstreamTargets.slice(), options, "layout");
  }

  function applyGroupWidth() {
    if (state.busy || !fullGroups.has(state.inspectedGroup) || !elements["group-columns"].reportValidity()) {
      return;
    }
    const groupColumns = { ...renderOptions.groupColumns };
    const value = elements["group-columns"].value;
    if (value === "") {
      delete groupColumns[state.inspectedGroup];
    } else {
      groupColumns[state.inspectedGroup] = Number(value);
    }
    void setLayout({ groupColumns });
  }

  function applyGraphWidth() {
    if (!state.busy && elements["graph-width"].reportValidity()) {
      const value = elements["graph-width"].value;
      void setLayout({ graphWidth: value === "" ? null : Number(value) });
    }
  }

  async function updateGraph(names, options, action) {
    let nextOptions;
    try {
      nextOptions = globalThis.TarboristGraphModel.validateGraphLayout(fullGraph, options);
    } catch (error) {
      updateLayoutControls();
      showStatus(`Unable to update the layout: ${error.message || String(error)}`, true);
      return;
    }
    saveState();
    setBusy(true);
    showStatus(action === "layout" ? "Updating the pipeline layout..."
      : names.length ? "Laying out the selected targets and their upstream dependencies..." : "Restoring the complete pipeline...");
    if (vscode) {
      vscode.postMessage(action === "filter" ? { type: "setUpstreamFilter", names } : {
        type: "setLayout", direction: nextOptions.direction, startGroup: nextOptions.startGroup,
        endGroup: nextOptions.endGroup, groupColumns: nextOptions.groupColumns, graphWidth: nextOptions.graphWidth
      });
      return;
    }
    try {
      const nextGraph = globalThis.TarboristGraphModel.filterGraphUpstream(fullGraph, names);
      const nextDot = globalThis.TarboristGraphModel.buildGraphDot(nextGraph, nextOptions);
      const layout = await renderStandaloneGraph(nextDot, nextOptions.graphWidth);
      const parsed = new DOMParser().parseFromString(layout.svg, "image/svg+xml");
      if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") {
        throw new Error("The renderer did not return a valid SVG image.");
      }
      const selectedNames = selectedTargetNames();
      const inspectedName = nodes.get(state.inspected)?.name;
      const replacement = document.importNode(parsed.documentElement, true);
      if (svg) {
        svg.replaceWith(replacement);
      } else {
        viewport.prepend(replacement);
      }
      svg = replacement;
      graph = nextGraph;
      dot = layout.dot;
      widthInfo = layout.widthInfo;
      renderOptions = nextOptions;
      mountGraph();
      restoreSelection(selectedNames, inspectedName);
      showStatus("");
    } catch (error) {
      showStatus(`Unable to update the graph: ${error.message || String(error)}`, true);
    } finally {
      setBusy(false);
      updateHighlight();
    }
  }

  function mountGraph() {
    closeContextMenu(true);
    nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    groups = new Map(graph.groups.map((group) => [group.id, group]));
    upstreamTargets = graph.upstreamTargets || (graph.upstreamTarget ? [graph.upstreamTarget] : []);
    nodeElements.clear();
    edgeElements.clear();
    groupElements.clear();
    state.pan = null;
    viewport.classList.remove("is-panning");
    elements["pipeline-summary"].textContent = `${relativeFile(graph.rootFile)} / ${upstreamTargets.length ? `${nodes.size} of ${fullGraph.nodes.length}` : nodes.size} targets / ${graph.edges.length} dependencies / ${groups.size} subpipelines`;
    elements["empty-graph"].hidden = nodes.size > 0;
    elements["upstream-banner"].hidden = !upstreamTargets.length;
    elements["upstream-focus"].textContent = upstreamTargets.length ? `Upstream of ${upstreamTargets.join(", ")}` : "";
    elements["upstream-focus"].title = elements["upstream-focus"].textContent;
    elements["upstream-summary"].textContent = `${nodes.size} of ${fullGraph.nodes.length} targets shown; ${fullGraph.nodes.length - nodes.size} hidden. Exports use this graph.`;
    elements["export-dot"].title = upstreamTargets.length ? "Export this upstream graph as Graphviz source" : "Export the complete graph as Graphviz source";
    elements["export-svg"].title = upstreamTargets.length ? "Export this upstream graph as a vector image" : "Export the complete graph as a vector image";
    elements["fit-graph"].title = "Fit the displayed graph (0)";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "All subpipelines";
    elements["group-filter"].replaceChildren(defaultOption);
    for (const group of graph.groups) {
      const option = document.createElement("option");
      option.value = group.id;
      option.textContent = groupPath(group.id);
      elements["group-filter"].appendChild(option);
    }
    if (graph.nodes.some((node) => !node.groupId)) {
      const option = document.createElement("option");
      option.value = "__ungrouped__";
      option.textContent = "Ungrouped";
      elements["group-filter"].appendChild(option);
    }
    elements["group-filter"].value = state.group;
    if (!svg) {
      return;
    }
    originalBox = svg.getAttribute("viewBox").split(/[ ,]+/).map(Number);
    viewBox = originalBox.slice();
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("aria-label", upstreamTargets.length ? `Upstream dependencies of ${upstreamTargets.join(", ")}` : "Grouped pipeline dependencies");
    elements["zoom-level"].textContent = "100%";
    for (const element of svg.querySelectorAll(".node")) {
      const id = element.querySelector("title")?.textContent;
      if (!nodes.has(id)) {
        continue;
      }
      nodeElements.set(id, element);
      element.setAttribute("tabindex", "0");
      element.setAttribute("role", "button");
      element.setAttribute("aria-label", `Inspect target ${nodes.get(id).name}`);
      element.setAttribute("aria-haspopup", "menu");
      element.setAttribute("aria-expanded", "false");
      element.setAttribute("aria-controls", "target-context-menu");
      element.setAttribute("aria-keyshortcuts", "Shift+F10");
      element.addEventListener("click", (event) => {
        if (event.button === 0) {
          selectTarget(id, event.shiftKey);
        }
      });
      element.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const keyboard = event.clientX === 0 && event.clientY === 0;
        openContextMenu(id, keyboard ? undefined : event.clientX, keyboard ? undefined : event.clientY);
      });
      element.addEventListener("dblclick", (event) => {
        if (!event.shiftKey) {
          openTargetDefinition(nodes.get(id));
        }
      });
      element.addEventListener("keydown", (event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          event.stopPropagation();
          openContextMenu(id);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectTarget(id, event.shiftKey);
        }
      });
    }
    for (const element of svg.querySelectorAll(".edge")) {
      edgeElements.set(element.querySelector("title")?.textContent, element);
    }
    for (const element of svg.querySelectorAll(".cluster")) {
      const id = element.querySelector("title")?.textContent.replace(/^cluster_/, "");
      if (groups.has(id)) {
        const group = groups.get(id);
        groupElements.set(id, element);
        element.setAttribute("tabindex", "0");
        element.setAttribute("role", "button");
        element.setAttribute("aria-label", `Select subpipeline ${group.label}`);
        element.addEventListener("click", (event) => {
          if (event.target.closest(".node") || event.target.closest(".cluster") !== element) {
            return;
          }
          event.stopPropagation();
          selectGroup(group.key);
        });
        element.addEventListener("keydown", (event) => {
          if (event.target === element && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            event.stopPropagation();
            selectGroup(group.key);
          }
        });
      }
    }
  }

  elements["graph-mode"].textContent = graph.graphSource === "network" ? "TARGETS NETWORK" : "SOURCE PREVIEW";
  elements["analysis-note"].textContent = graph.graphSource === "network"
    ? "Dependencies and statuses come from the supplied targets network. Subpipeline groups come from source structure."
    : "Static dependency preview. Build colors show the last recorded result; they do not certify that a target is up to date.";
  elements["refresh"].title = vscode ? "Rebuild the graph from the current pipeline" : "Refresh is available inside Positron or VS Code";
  elements["source-navigation-help"].hidden = Boolean(vscode);
  elements["analysis-notice"].hidden = !graph.partial && !(graph.diagnostics || []).length;
  elements["analysis-title"].textContent = graph.partial ? "Partial static analysis" : "Analysis diagnostics";
  elements["analysis-description"].textContent = !graph.partial
    ? "Review the reported pipeline issues below."
    : graph.graphSource === "network"
      ? "The supplied network is shown, but some source groups or source locations may be unresolved."
      : "Some pipeline expressions could not be resolved statically. The visible graph may omit targets or dependencies.";
  for (const diagnostic of graph.diagnostics || []) {
    const item = document.createElement("li");
    const message = document.createElement("span");
    message.textContent = diagnostic.message;
    item.appendChild(message);
    if (diagnostic.file) {
      const location = document.createElement("span");
      location.className = "diagnostic-location";
      location.textContent = `${relativeFile(diagnostic.file)}:${diagnostic.line || 1}:${diagnostic.character || 1}`;
      item.appendChild(location);
    }
    elements["diagnostics-list"].appendChild(item);
  }

  viewport.addEventListener("wheel", (event) => {
    if (svg) {
      event.preventDefault();
      zoom(Math.exp(Math.max(-.4, Math.min(.4, event.deltaY * .001))), pointAt(event.clientX, event.clientY));
    }
  }, { passive: false });
  viewport.addEventListener("pointerdown", (event) => {
    state.suppressGroupClick = false;
    if (!svg || event.button !== 0 || event.target.closest(".node")) {
      return;
    }
    state.pan = { x: event.clientX, y: event.clientY, box: viewBox.slice(), matrix: svg.getScreenCTM().inverse(), moved: false };
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!state.pan) {
      return;
    }
    if (!(event.buttons & 1)) {
      state.pan = null;
      viewport.classList.remove("is-panning");
      return;
    }
    const dx = event.clientX - state.pan.x;
    const dy = event.clientY - state.pan.y;
    if (!state.pan.moved && Math.hypot(dx, dy) < 4) {
      return;
    }
    if (!state.pan.moved) {
      state.pan.moved = true;
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add("is-panning");
    }
    setViewBox([
      state.pan.box[0] - dx * state.pan.matrix.a - dy * state.pan.matrix.c,
      state.pan.box[1] - dx * state.pan.matrix.b - dy * state.pan.matrix.d,
      state.pan.box[2],
      state.pan.box[3]
    ]);
  });
  for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
    viewport.addEventListener(eventName, () => {
      if (state.pan) {
        state.suppressGroupClick = state.pan.moved;
      }
      state.pan = null;
      viewport.classList.remove("is-panning");
    });
  }
  viewport.addEventListener("click", (event) => {
    if (state.suppressGroupClick) {
      event.preventDefault();
      event.stopPropagation();
      state.suppressGroupClick = false;
    }
  }, true);
  viewport.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(.8);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(1.25);
    } else if (event.key === "0") {
      event.preventDefault();
      setViewBox(originalBox.slice());
    } else if (event.key === "Escape") {
      if (state.inspectedGroup) {
        state.inspectedGroup = null;
        updateSelection();
      } else {
        selectTarget(null);
      }
    }
  });
  elements["target-search"].addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    saveState();
    updateHighlight();
  });
  elements["target-search"].addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const match = graph.nodes.find(nodeMatchesFilter);
      if (match) {
        event.preventDefault();
        selectTarget(match.id, event.shiftKey);
      }
    }
  });
  elements["group-filter"].addEventListener("change", (event) => {
    state.group = event.target.value;
    saveState();
    updateHighlight();
  });
  elements["clear-selection"].addEventListener("click", () => selectTarget(null));
  elements["back-to-targets"].addEventListener("click", () => {
    state.inspectedGroup = null;
    updateSelection();
  });
  elements["flow-direction"].addEventListener("change", (event) => {
    void setLayout({ direction: event.target.value });
  });
  elements["pin-start"].addEventListener("click", () => {
    if (state.inspectedGroup) {
      void setLayout({
        startGroup: state.inspectedGroup,
        endGroup: renderOptions.endGroup === state.inspectedGroup ? null : renderOptions.endGroup
      });
    }
  });
  elements["pin-end"].addEventListener("click", () => {
    if (state.inspectedGroup) {
      void setLayout({
        endGroup: state.inspectedGroup,
        startGroup: renderOptions.startGroup === state.inspectedGroup ? null : renderOptions.startGroup
      });
    }
  });
  elements["clear-group-pin"].addEventListener("click", () => {
    void setLayout({
      startGroup: renderOptions.startGroup === state.inspectedGroup ? null : renderOptions.startGroup,
      endGroup: renderOptions.endGroup === state.inspectedGroup ? null : renderOptions.endGroup
    });
  });
  elements["clear-pins"].addEventListener("click", () => { void setLayout({ startGroup: null, endGroup: null }); });
  elements["apply-group-width"].addEventListener("click", applyGroupWidth);
  elements["group-columns"].addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyGroupWidth();
    }
  });
  elements["clear-group-width"].addEventListener("click", () => {
    const groupColumns = { ...renderOptions.groupColumns };
    delete groupColumns[state.inspectedGroup];
    void setLayout({ groupColumns });
  });
  elements["apply-graph-width"].addEventListener("click", applyGraphWidth);
  elements["graph-width"].addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyGraphWidth();
    }
  });
  elements["clear-graph-width"].addEventListener("click", () => { void setLayout({ graphWidth: null }); });
  elements["reset-layout"].addEventListener("click", () => {
    void setLayout({ direction: "LR", startGroup: null, endGroup: null, groupColumns: {}, graphWidth: null });
  });
  elements["upstream-only"].addEventListener("click", () => {
    const names = selectedTargetNames();
    if (names.length) {
      void setUpstreamFilter(names);
    }
  });
  elements["show-all"].addEventListener("click", () => { void setUpstreamFilter([]); });
  elements["zoom-in"].addEventListener("click", () => zoom(.8));
  elements["zoom-out"].addEventListener("click", () => zoom(1.25));
  elements["fit-graph"].addEventListener("click", () => setViewBox(originalBox.slice()));
  elements["open-source"].addEventListener("click", () => openTargetDefinition(nodes.get(state.inspected)));
  elements["context-open-source"].addEventListener("click", () => {
    const node = graph.nodes.find((target) => target.name === state.contextMenu?.name);
    if (node?.file) {
      closeContextMenu(true);
      openTargetDefinition(node);
    }
  });
  elements["target-context-menu"].addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenu(true);
    } else if (event.key === "Tab") {
      closeContextMenu(true);
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      elements["context-open-source"].focus({ preventScroll: true });
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!elements["target-context-menu"].contains(event.target)) {
      closeContextMenu();
    }
  });
  window.addEventListener("resize", () => closeContextMenu(true));
  document.addEventListener("scroll", (event) => {
    if (!elements["target-context-menu"].contains(event.target)) {
      closeContextMenu(true);
    }
  }, true);
  elements["refresh"].addEventListener("click", () => vscode?.postMessage({ type: "refresh" }));
  elements["export-dot"].addEventListener("click", () => {
    if (state.busy) {
      return;
    }
    if (vscode) {
      vscode.postMessage({ type: "exportDot" });
    } else if (dot) {
      download(dot, "text/vnd.graphviz;charset=utf-8", "dot");
    }
  });
  elements["export-svg"].addEventListener("click", () => {
    if (state.busy) {
      return;
    }
    if (vscode) {
      vscode.postMessage({ type: "exportSvg" });
    } else if (svg) {
      // The displayed SVG is a new layout of the filtered graph. Remove only
      // transient inspection styles and export its full, uncropped viewBox.
      const exported = svg.cloneNode(true);
      exported.setAttribute("viewBox", originalBox.join(" "));
      exported.setAttribute("width", `${originalBox[2]}pt`);
      exported.setAttribute("height", `${originalBox[3]}pt`);
      for (const element of exported.querySelectorAll("[class]")) {
        element.classList.remove("is-muted", "is-selected", "is-match", "is-related", "is-group-selected");
      }
      for (const element of exported.querySelectorAll('.node[role="button"], .cluster[role="button"]')) {
        for (const attribute of ["role", "tabindex", "aria-label", "aria-pressed", "aria-haspopup", "aria-expanded", "aria-controls", "aria-keyshortcuts"]) {
          element.removeAttribute(attribute);
        }
      }
      download(new XMLSerializer().serializeToString(exported), "image/svg+xml;charset=utf-8", "svg");
    }
  });
  window.addEventListener("message", ({ data }) => {
    if (vscode && data?.type === "filterError") {
      setBusy(false);
      showStatus(data.message || "Unable to update the graph.", true);
      updateHighlight();
    }
  });
  window.addEventListener("beforeunload", () => layoutWorker?.terminate());

  mountGraph();
  const previous = vscode?.getState();
  if (previous) {
    state.inspectedGroup = fullGroups.has(previous.inspectedGroup) ? previous.inspectedGroup : null;
    state.search = typeof previous.search === "string" ? previous.search : "";
    state.group = previous.group === "__ungrouped__" ? "__ungrouped__"
      : previous.groupPath ? graph.groups.find((group) => groupPath(group.id) === previous.groupPath)?.id || ""
        : groups.has(previous.group) ? previous.group : "";
    elements["target-search"].value = state.search;
    elements["group-filter"].value = state.group;
  }
  const previousName = previous?.selectedName || nodes.get(previous?.selected)?.name;
  const selectedNames = Array.isArray(previous?.selectedNames) ? previous.selectedNames
    : previousName ? [previousName] : [];
  restoreSelection(selectedNames, previous?.inspectedName || previousName);
  setBusy(false);
})();
