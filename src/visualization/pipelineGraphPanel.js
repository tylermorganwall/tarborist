"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const vscode = require("vscode");
const { buildGroupedPipelineGraph, buildGraphDot, filterGraphUpstream, validateGraphLayout } = require("./pipelineGraph");
const { renderGraphLayout } = require("./renderGraph");
const { getPipelineGraphHtml } = require("./webviewHtml");
const { openTargetDefinition } = require("./targetNavigation");

const DEFAULT_LAYOUT_OPTIONS = Object.freeze({
  direction: "LR", startGroup: null, endGroup: null, groupColumns: Object.freeze({}), graphWidth: null
});

// Own webview lifetimes and keep each view attached to its pipeline snapshot.
class PipelineGraphPanelController {
  constructor(context, indexManager, outputChannel) {
    this.context = context;
    this.indexManager = indexManager;
    this.outputChannel = outputChannel;
    this.panels = new Map();
    this.disposed = false;
    this.subscriptions = [
      indexManager.onDidRefresh(({ root, index }) => {
        void this.render(root, index).catch((error) => this.reportError(error));
      }),
      indexManager.onDidRemove(({ root }) => {
        this.panels.get(root)?.panel.dispose();
      })
    ];
  }

  reportError(error) {
    const message = `Unable to show the grouped pipeline: ${error.message || String(error)}`;
    this.outputChannel?.appendLine(message);
    void vscode.window.showErrorMessage(message);
  }

  async open(uri = vscode.window.activeTextEditor?.document.uri) {
    let index;
    if (uri) {
      const root = this.indexManager.getPipelineRootForUri(uri);
      if (root) {
        // Explicitly opening a graph includes current unsaved editor buffers.
        await this.indexManager.refreshWorkspace(root);
        index = await this.indexManager.getIndexForUri(uri);
      }
    }
    if (!index) {
      await this.indexManager.refreshAll();
      const candidates = [...this.indexManager.indices.values()].filter((candidate) => !candidate.stale);
      if (candidates.length === 1) {
        index = candidates[0];
      } else if (candidates.length > 1) {
        const picked = await vscode.window.showQuickPick(candidates.map((candidate) => ({
          label: path.basename(path.dirname(candidate.rootFile)),
          description: candidate.rootFile,
          index: candidate
        })), { placeHolder: "Choose the pipeline to visualize" });
        index = picked?.index;
      }
    }
    if (!index || this.disposed) {
      if (!this.disposed) {
        void vscode.window.showInformationMessage("Open a workspace containing a _targets.R pipeline to show its grouped graph.");
      }
      return;
    }

    const root = path.dirname(index.rootFile);
    let entry = this.panels.get(root);
    if (entry) {
      entry.panel.reveal(vscode.ViewColumn.Beside);
      // The refresh above already sent this index to existing panels through
      // onDidRefresh. Only a newly created panel still needs its first render.
      return;
    } else {
      const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, "media");
      const panel = vscode.window.createWebviewPanel(
        "tarborist.pipelineGraph",
        `Pipeline: ${path.basename(root)}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, localResourceRoots: [mediaUri] }
      );
      entry = {
        panel,
        generation: 0,
        sourceGraph: null,
        graph: null,
        viewGraph: null,
        upstreamTargets: [],
        layoutOptions: { ...DEFAULT_LAYOUT_OPTIONS },
        renderOptions: { ...DEFAULT_LAYOUT_OPTIONS },
        widthInfo: null,
        dot: "",
        svg: ""
      };
      this.panels.set(root, entry);
      panel.onDidDispose(() => {
        entry.generation += 1;
        if (this.panels.get(root) === entry) {
          this.panels.delete(root);
        }
      });
      panel.webview.onDidReceiveMessage((message) => {
        void this.receiveMessage(root, entry, message).catch((error) => this.reportError(error));
      });
    }
    await this.render(root, index);
  }

  async render(root, index) {
    const entry = this.panels.get(root);
    if (!entry || this.disposed) {
      return;
    }
    const graph = index && !index.stale ? buildGroupedPipelineGraph(index) : {
      rootFile: path.join(root, "_targets.R"),
      workspaceRoot: root,
      graphSource: "static",
      statusSource: "metadata",
      partial: true,
      nodes: [],
      groups: [],
      edges: [],
      diagnostics: [{
        file: path.join(root, "_targets.R"),
        line: 1,
        character: 1,
        severity: "error",
        message: "The pipeline index is unavailable. Fix the source error and refresh the graph."
      }]
    };
    entry.sourceGraph = graph;
    // Keep surviving focus targets by name when source order or membership changes.
    const availableTargets = new Set(graph.nodes.map((node) => node.name));
    entry.upstreamTargets = entry.upstreamTargets.filter((name) => availableTargets.has(name));
    // Group keys survive changes to source line numbers and rendered IDs.
    const availableGroups = new Set(graph.groups.map((group) => group.key));
    entry.layoutOptions = {
      ...entry.layoutOptions,
      startGroup: availableGroups.has(entry.layoutOptions.startGroup) ? entry.layoutOptions.startGroup : null,
      endGroup: availableGroups.has(entry.layoutOptions.endGroup) ? entry.layoutOptions.endGroup : null,
      groupColumns: Object.fromEntries(Object.entries(entry.layoutOptions.groupColumns)
        .filter(([key]) => availableGroups.has(key)))
    };
    await this.renderView(root, entry, graph);
  }

  async renderView(root, entry, graph) {
    const generation = ++entry.generation;
    let viewGraph;
    let renderOptions;
    let dot;
    let svg;
    let widthInfo;
    try {
      // Validate against the full pipeline so a hidden group cannot conceal
      // incompatible layout choices. Filtering can then leave them dormant.
      renderOptions = validateGraphLayout(graph, entry.layoutOptions);
      entry.layoutOptions = renderOptions;
      viewGraph = filterGraphUpstream(graph, entry.upstreamTargets);
      dot = buildGraphDot(viewGraph, renderOptions);
      ({ dot, svg, widthInfo } = await renderGraphLayout(dot, renderOptions.graphWidth));
    } catch (error) {
      if (this.disposed || this.panels.get(root) !== entry || generation !== entry.generation) {
        return;
      }
      entry.upstreamTargets = entry.viewGraph?.upstreamTargets || [];
      entry.layoutOptions = { ...entry.renderOptions };
      await entry.panel.webview.postMessage?.({ type: "filterError", message: error.message || String(error) });
      throw error;
    }
    if (this.disposed || this.panels.get(root) !== entry || generation !== entry.generation) {
      return;
    }
    entry.graph = graph;
    entry.viewGraph = viewGraph;
    entry.renderOptions = renderOptions;
    entry.widthInfo = widthInfo;
    entry.dot = dot;
    entry.svg = svg;
    const webview = entry.panel.webview;
    webview.html = getPipelineGraphHtml({
      graph,
      viewGraph,
      svg,
      renderOptions,
      widthInfo,
      nonce: crypto.randomBytes(18).toString("base64"),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "pipelineGraph.js")),
      modelScriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "pipelineGraphModel.js")),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "pipelineGraph.css")),
      cspSource: webview.cspSource
    });
  }

  async receiveMessage(root, entry, message) {
    if (this.disposed || this.panels.get(root) !== entry || !message || typeof message.type !== "string") {
      return;
    }
    if (message.type === "refresh") {
      await this.indexManager.refreshWorkspace(root);
      return;
    }
    if (message.type === "setLayout") {
      const graph = entry.sourceGraph || entry.graph;
      const { direction, startGroup, endGroup } = message;
      // Omitted width fields preserve existing choices for older clients.
      const groupColumns = message.groupColumns === undefined ? entry.layoutOptions.groupColumns : message.groupColumns;
      const graphWidth = message.graphWidth === undefined ? entry.layoutOptions.graphWidth : message.graphWidth;
      if (!graph || !["LR", "TB", "RL", "BT"].includes(direction)
        || [startGroup, endGroup].some((key) => key !== null && (typeof key !== "string" || !key.length))
        || !groupColumns || typeof groupColumns !== "object" || Array.isArray(groupColumns)
        || Object.values(groupColumns).some((columns) => !Number.isSafeInteger(columns) || columns < 1)
        || (graphWidth !== null && (!Number.isSafeInteger(graphWidth) || graphWidth < 1 || graphWidth > 100000))) {
        return;
      }
      const availableGroups = new Set(graph.groups.map((group) => group.key));
      const missing = [startGroup, endGroup, ...Object.keys(groupColumns)]
        .filter((key) => key !== null && !availableGroups.has(key));
      if (missing.length) {
        if (entry.graph?.groups.some((group) => missing.includes(group.key))) {
          await entry.panel.webview.postMessage?.({
            type: "filterError",
            message: "One or more selected subpipelines are no longer in the current pipeline. Refresh the graph to see the updated subpipelines."
          });
        }
        return;
      }
      entry.layoutOptions = { ...entry.layoutOptions, direction, startGroup, endGroup, groupColumns, graphWidth };
      await this.renderView(root, entry, graph);
      return;
    }
    if (message.type === "setUpstreamFilter") {
      const graph = entry.sourceGraph || entry.graph;
      const requested = Object.prototype.hasOwnProperty.call(message, "names")
        ? message.names : message.name === null ? [] : [message.name];
      if (!graph || !Array.isArray(requested)
        || requested.some((name) => typeof name !== "string" || !name.length)) {
        return;
      }
      const names = [...new Set(requested)];
      const availableTargets = new Set(graph.nodes.map((node) => node.name));
      const missing = names.filter((name) => !availableTargets.has(name));
      if (missing.length) {
        // A failed refresh can leave the preceding snapshot on screen. Release
        // its pending action if a visible selection was removed in newer source.
        if (entry.viewGraph?.nodes.some((node) => missing.includes(node.name))) {
          await entry.panel.webview.postMessage?.({
            type: "filterError",
            message: "One or more selected targets are no longer in the current pipeline. Refresh the graph to see the updated targets."
          });
        }
        return;
      }
      entry.upstreamTargets = names;
      await this.renderView(root, entry, graph);
      return;
    }
    if (message.type === "openTarget") {
      // Authorize the name from the displayed graph, then resolve its current
      // indexed definition. Source edits can move it while layout is pending.
      const target = entry.viewGraph?.nodes.find((node) => typeof message.name === "string"
        ? node.name === message.name : node.id === message.id);
      if (!target?.file) {
        return;
      }
      await openTargetDefinition(this.indexManager, target.name, { pipelineRoot: root });
      return;
    }
    if (message.type === "exportSvg" || message.type === "exportDot") {
      const format = message.type === "exportSvg" ? "svg" : "dot";
      // Capture the published view before the save dialog. A pending layout or
      // source refresh must not change the graph being exported mid-save.
      const content = format === "svg" ? entry.svg : entry.dot;
      const focus = entry.viewGraph?.upstreamTargets || [];
      const filename = focus.length > 1 ? `pipeline-upstream-${focus.length}-targets`
        : focus.length ? `pipeline-upstream-${focus[0].replace(/[^A-Za-z0-9_.-]/g, "_")}` : "pipeline";
      if (!content) {
        return;
      }
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(root, `${filename}.${format}`)),
        filters: format === "svg" ? { "SVG image": ["svg"] } : { "Graphviz DOT": ["dot"] }
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      }
    }
  }

  dispose() {
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    for (const { panel } of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }
}

function registerPipelineGraphCommand(context, indexManager, outputChannel) {
  const controller = new PipelineGraphPanelController(context, indexManager, outputChannel);
  context.subscriptions.push(controller);
  context.subscriptions.push(vscode.commands.registerCommand("tarborist.showPipelineGraph", async (uri) => {
    try {
      await controller.open(uri);
    } catch (error) {
      controller.reportError(error);
    }
  }));
  return controller;
}

module.exports = { PipelineGraphPanelController, registerPipelineGraphCommand };
