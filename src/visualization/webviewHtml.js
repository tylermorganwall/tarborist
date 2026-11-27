"use strict";

// Render only SVG produced by our DOT renderer. Pipeline metadata is kept in
// inert JSON and read with textContent so names and commands cannot become HTML.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function getPipelineGraphHtml({
  graph,
  viewGraph = graph,
  svg,
  nonce,
  scriptUri,
  modelScriptUri,
  styleUri,
  cspSource = "",
  scriptText,
  modelScriptText,
  styleText,
  dot = "",
  renderOptions = {},
  widthInfo = null,
  layoutWorkerText
}) {
  const payload = JSON.stringify({ graph, viewGraph, dot, renderOptions, widthInfo, layoutWorkerText })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const escapedNonce = escapeHtml(nonce);
  const policy = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src ${cspSource} 'nonce-${nonce}'${layoutWorkerText ? " 'wasm-unsafe-eval'" : ""}`,
    `worker-src ${layoutWorkerText ? "blob:" : "'none'"}`,
    `font-src ${cspSource || "'none'"}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
  const stylesheet = typeof styleText === "string"
    ? `<style nonce="${escapedNonce}">${styleText.replace(/<\/style/gi, "<\\/style")}</style>`
    : `<link rel="stylesheet" href="${escapeHtml(styleUri)}" nonce="${escapedNonce}">`;
  const script = typeof scriptText === "string"
    ? `<script nonce="${escapedNonce}">${scriptText.replace(/<\/script/gi, "<\\/script")}</script>`
    : `<script src="${escapeHtml(scriptUri)}" nonce="${escapedNonce}"></script>`;
  const modelScript = typeof modelScriptText === "string"
    ? `<script nonce="${escapedNonce}">${modelScriptText.replace(/<\/script/gi, "<\\/script")}</script>`
    : modelScriptUri ? `<script src="${escapeHtml(modelScriptUri)}" nonce="${escapedNonce}"></script>` : "";
  const svgMarkup = String(svg).replace(/<\?xml[^>]*\?>\s*/i, "")
    .replace(/<!DOCTYPE[^>]*>\s*/i, "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">
  <title>tarborist | Pipeline graph</title>
  ${stylesheet}
</head>
<body>
  <header class="page-header">
    <div class="heading">
      <div class="eyebrow">TARBORIST <span class="mode-badge" id="graph-mode">PIPELINE</span></div>
      <h1>Pipeline graph</h1>
      <p id="pipeline-summary" class="pipeline-summary"></p>
    </div>
    <div class="header-actions" aria-label="Graph actions">
      <button id="refresh" type="button" title="Rebuild the graph from the current pipeline">Refresh</button>
      <button id="export-dot" type="button" title="Export Graphviz source">Export DOT</button>
      <button id="export-svg" class="primary-button" type="button" title="Export a vector image">Export SVG</button>
    </div>
  </header>
  <p id="analysis-note" class="analysis-note"></p>
  <details id="analysis-notice" class="analysis-notice" hidden>
    <summary id="analysis-title">Partial static analysis</summary>
    <p id="analysis-description"></p>
    <ul id="diagnostics-list"></ul>
  </details>
  <main class="workspace">
    <section class="graph-panel" aria-label="Grouped dependency graph">
      <div class="graph-toolbar">
        <label class="search-label" for="target-search">Find target
          <input id="target-search" type="search" placeholder="Search by target name" autocomplete="off" spellcheck="false">
        </label>
        <label class="group-label" for="group-filter">Subpipeline
          <select id="group-filter"><option value="">All subpipelines</option></select>
        </label>
        <label class="direction-label" for="flow-direction">Flow
          <select id="flow-direction">
            <option value="LR">Left to right</option>
            <option value="TB">Top to bottom</option>
            <option value="RL">Right to left</option>
            <option value="BT">Bottom to top</option>
          </select>
        </label>
        <div class="zoom-controls" aria-label="Graph zoom">
          <button id="zoom-out" type="button" aria-label="Zoom out" title="Zoom out (-)">-</button>
          <output id="zoom-level" aria-label="Zoom level">100%</output>
          <button id="zoom-in" type="button" aria-label="Zoom in" title="Zoom in (+)">+</button>
          <button id="fit-graph" type="button" title="Fit the whole graph (0)">Fit</button>
        </div>
      </div>
      <div class="layout-bar">
        <div class="layout-controls">
          <div class="graph-width-control">
            <label for="graph-width">Target graph width (px)</label>
            <input id="graph-width" type="number" min="1" max="100000" step="1" placeholder="Automatic" aria-describedby="graph-width-help graph-width-result">
            <button id="apply-graph-width" type="button">Apply</button>
            <button id="clear-graph-width" type="button" title="Use automatic graph width">Clear width</button>
          </div>
          <div class="layout-reset-actions">
            <button id="clear-pins" type="button" hidden>Clear all pins</button>
            <button id="reset-layout" type="button" title="Restore left-to-right flow and remove all pins and width settings">Reset layout</button>
          </div>
        </div>
        <p id="graph-width-help" class="graph-width-help">Width of targets and boxes, in CSS pixels. Adds spacing without shrinking labels; export margins can make the canvas wider.</p>
        <p id="graph-width-result" class="graph-width-result" role="status" aria-live="polite" hidden></p>
        <span id="layout-summary">Click a subpipeline box to set its position and width.</span>
      </div>
      <div id="upstream-banner" class="upstream-banner" hidden>
        <div><strong id="upstream-focus"></strong><span id="upstream-summary"></span></div>
        <button id="show-all" type="button">Show all</button>
      </div>
      <p id="graph-status" class="graph-status" role="status" aria-live="polite" hidden></p>
      <div id="graph-viewport" class="graph-viewport" tabindex="0" aria-label="Pipeline graph. Drag the background or hold Space and drag from a target to pan. Scroll to zoom. Shift-click to select multiple targets. Right-click a target to open its definition. Select a subpipeline box to set its position and width.">
        ${svgMarkup}
        <div id="empty-graph" class="empty-graph" hidden>
          <h2>No targets to display</h2>
          <p>Check the pipeline and the analysis diagnostics above.</p>
        </div>
      </div>
      <div class="graph-footer">
        <span id="filter-summary" role="status" aria-live="polite"></span>
        <span class="interaction-hint">Shift-click to select multiple targets. Right-click for definition. Hold Space and drag to pan. Scroll to zoom.</span>
      </div>
    </section>
    <aside class="inspector" aria-label="Graph inspector">
      <div class="inspector-heading">
        <span class="eyebrow" id="inspector-title">TARGET INSPECTOR</span>
        <button id="clear-selection" class="text-button" type="button" hidden>Clear selection</button>
        <button id="back-to-targets" class="text-button" type="button" hidden>Back to targets</button>
      </div>
      <div id="inspector-empty" class="inspector-empty">
        <div class="inspector-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2>Follow your targets</h2>
        <p>Select a node to inspect its source and dependencies. Shift-click to add or remove targets, then choose Upstream only to keep everything that feeds into the selection.</p>
        <p>Right-click a target to open its definition. With a target focused, press Shift+F10 for the same menu.</p>
        <p>Click a subpipeline box or label to pin its position and change its width.</p>
        <p class="quiet">Arrows point from an input to the target that depends on it.</p>
      </div>
      <div id="group-details" hidden>
        <div class="target-heading"><h2 id="selected-group-name"></h2><span id="selected-group-visibility" class="status-badge"></span></div>
        <p id="selected-group-count" class="group-description"></p>
        <dl class="target-facts">
          <dt>Source</dt><dd id="selected-group-location" class="source-location"></dd>
          <dt>Position</dt><dd id="selected-group-pin"></dd>
        </dl>
        <div class="target-actions">
          <button id="pin-start" type="button">Pin left</button>
          <button id="pin-end" type="button">Pin right</button>
          <button id="clear-group-pin" type="button">Clear pin</button>
        </div>
        <p class="upstream-help">Choose one subpipeline for each end of the flow. Pins apply to the complete box and its nested subpipelines. Hidden groups keep their pins until they are shown again.</p>
        <section class="group-width-section" aria-labelledby="group-width-title">
          <h3 id="group-width-title">Box width</h3>
          <label for="group-columns">Target columns
            <input id="group-columns" type="number" min="1" step="1" placeholder="Automatic" aria-describedby="group-width-help">
          </label>
          <div class="target-actions">
            <button id="apply-group-width" type="button">Apply width</button>
            <button id="clear-group-width" type="button">Clear width</button>
          </div>
          <p id="group-width-help" class="upstream-help">Limit horizontal target columns. Use 1 for a narrow, tall box, or leave blank for Automatic. Labels determine the minimum width; target text stays the same size.</p>
          <p class="upstream-help">Set columns on this subpipeline or its nested groups. Hidden groups keep their width settings.</p>
        </section>
      </div>
      <div id="target-details" hidden>
        <section class="selection-summary" aria-label="Selected targets">
          <strong id="selection-count" role="status" aria-live="polite"></strong>
          <ul id="selected-targets"></ul>
          <button id="upstream-only" class="primary-button" type="button" title="Keep all selected targets and the union of their transitive dependencies">Upstream only</button>
          <p class="upstream-help">Shift-click to add or remove targets. Upstream only keeps the selection and all of its dependencies.</p>
        </section>
        <div class="target-heading"><h2 id="target-name"></h2><span id="target-status" class="status-badge"></span></div>
        <dl class="target-facts">
          <dt>Subpipeline</dt><dd id="target-group"></dd>
          <dt>Source</dt><dd id="target-location" class="source-location"></dd>
          <dt>Definition</dt><dd id="target-origin"></dd>
        </dl>
        <div class="target-actions">
          <button id="open-source" class="source-button" type="button">Open source</button>
        </div>
        <p id="source-navigation-help" class="upstream-help">Requires the updated tarborist extension and the matching project open in Positron. Your browser may ask to open Positron.</p>
        <div class="degree-summary">
          <div><strong id="upstream-count">0</strong><span>dependencies</span></div>
          <div><strong id="downstream-count">0</strong><span>dependents</span></div>
        </div>
        <section class="command-section"><h3>Command</h3><pre><code id="target-command"></code></pre></section>
        <section class="neighbors-section"><h3>Direct dependencies</h3><ul id="upstream-list"></ul></section>
        <section class="neighbors-section"><h3>Direct dependents</h3><ul id="downstream-list"></ul></section>
      </div>
    </aside>
  </main>
  <div id="target-context-menu" class="target-context-menu" role="menu" aria-label="Target actions" hidden>
    <div id="context-target-name" class="context-target-name" aria-hidden="true"></div>
    <button id="context-open-source" type="button" role="menuitem" tabindex="-1" aria-describedby="context-source-note">Open definition in Positron</button>
    <p id="context-source-note" class="context-source-note" role="presentation"></p>
  </div>
  <script id="pipeline-data" type="application/json" nonce="${escapedNonce}">${payload}</script>
  ${modelScript}
  ${script}
</body>
</html>`;
}

module.exports = { getPipelineGraphHtml };
