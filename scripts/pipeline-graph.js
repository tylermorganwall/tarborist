#!/usr/bin/env node
"use strict";

// The CLI and R bridge use exactly the same index and renderer as the editor.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { parseArgs } = require("node:util");
const { buildStaticWorkspaceIndex } = require("../src/index/pipelineResolver");
const { runParserOperation } = require("../src/parser/treeSitter");
const { buildGroupedPipelineGraph, buildGraphDot, validateGraphLayout } = require("../src/visualization/pipelineGraph");
const { renderGraphSvg, renderGraphLayout } = require("../src/visualization/renderGraph");
const { getPipelineGraphHtml } = require("../src/visualization/webviewHtml");

async function createPipelineGraph(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("The graph request must be a JSON object.");
  }
  if (request.script !== undefined && (typeof request.script !== "string" || !request.script.trim())) {
    throw new TypeError("script must be a nonempty path to a pipeline script.");
  }
  if (request.exclude !== undefined && (!Array.isArray(request.exclude)
    || request.exclude.some((name) => typeof name !== "string"))) {
    throw new TypeError("exclude must be an array of target names.");
  }
  if (request.direction !== undefined && !["LR", "TB", "RL", "BT"].includes(request.direction)) {
    throw new TypeError("direction must be LR, TB, RL, or BT.");
  }
  if (request.scaleNodes !== undefined && typeof request.scaleNodes !== "boolean") {
    throw new TypeError("scaleNodes must be true or false.");
  }
  if (request.additionalSingleTargetFactories !== undefined
    && (!Array.isArray(request.additionalSingleTargetFactories)
      || request.additionalSingleTargetFactories.some((name) => typeof name !== "string"))) {
    throw new TypeError("additionalSingleTargetFactories must be an array of factory names.");
  }

  const script = path.resolve(request.script || "_targets.R");
  if (!fs.statSync(script).isFile()) {
    throw new Error(`Pipeline script is not a file: ${script}`);
  }
  const index = await runParserOperation(() => buildStaticWorkspaceIndex({
    script,
    workspaceRoot: path.dirname(script),
    readFile: (file) => fs.readFileSync(file, "utf8"),
    additionalSingleTargetFactories: request.additionalSingleTargetFactories
  }));
  const graph = buildGroupedPipelineGraph(index, request);
  const options = validateGraphLayout(graph, request);
  const dot = buildGraphDot(graph, options);
  if (options.graphWidth !== null) {
    return { graph, ...await renderGraphLayout(dot, options.graphWidth) };
  }
  return { graph, dot };
}

// Keep standalone pages offline and responsive: the Graphviz runtime lives in
// a lazily created Blob worker, while graph filtering uses the shared model.
function loadStandaloneGraphAssets() {
  const media = path.join(__dirname, "../media");
  const vizPath = path.join(path.dirname(require.resolve("@viz-js/viz")), "viz-global.js");
  const modelScriptText = fs.readFileSync(path.join(media, "pipelineGraphModel.js"), "utf8");
  return {
    scriptText: fs.readFileSync(path.join(media, "pipelineGraph.js"), "utf8"),
    modelScriptText,
    styleText: fs.readFileSync(path.join(media, "pipelineGraph.css"), "utf8"),
    layoutWorkerText: `${fs.readFileSync(vizPath, "utf8")}\n${modelScriptText}\n
const renderer = Viz.instance();
self.onmessage = async ({ data }) => {
  try {
    const viz = await renderer;
    const layout = TarboristGraphModel.renderGraphLayout(viz, data.dot, data.graphWidth);
    self.postMessage({ id: data.id, ...layout });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message || String(error) });
  }
};\n`
  };
}

async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      request: { type: "string" },
      format: { type: "string", default: "json" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (values.help) {
    process.stdout.write([
      "Usage: node scripts/pipeline-graph.js [pipeline.R] [--format json|dot|svg|html] [--output path]",
      "       node scripts/pipeline-graph.js --request request.json",
      "",
      "Parses the pipeline with Tree-sitter without executing R code.",
      "JSON output contains { graph, dot }. The R helper uses --request.",
      "HTML output includes pan, zoom, search, upstream filtering, and SVG/DOT export.",
      ""
    ].join("\n"));
    return;
  }
  if (positionals.length > 1 || (values.request && positionals.length)) {
    throw new Error("Supply one pipeline path or --request, not both.");
  }
  if (!["json", "dot", "svg", "html"].includes(values.format)) {
    throw new Error("--format must be json, dot, svg, or html.");
  }
  const request = values.request
    ? JSON.parse(fs.readFileSync(values.request, "utf8"))
    : { script: positionals[0] || "_targets.R" };
  const result = await createPipelineGraph(request);
  const { graph, dot } = result;
  let output;
  if (values.format === "json") {
    output = JSON.stringify({ graph, dot }, null, 2);
  } else if (values.format === "dot") {
    output = dot;
  } else {
    const svg = result.svg || await renderGraphSvg(dot);
    output = values.format === "svg" ? svg : getPipelineGraphHtml({
      graph,
      dot,
      svg,
      widthInfo: result.widthInfo || null,
      nonce: crypto.randomBytes(18).toString("base64"),
      renderOptions: {
        direction: request.direction, scaleNodes: request.scaleNodes, legend: request.legend,
        startGroup: request.startGroup, endGroup: request.endGroup, groupColumns: request.groupColumns,
        graphWidth: request.graphWidth
      },
      ...loadStandaloneGraphAssets()
    });
  }
  if (values.output) {
    fs.writeFileSync(path.resolve(values.output), `${output}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`tarborist: ${error.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createPipelineGraph, loadStandaloneGraphAssets, main };
