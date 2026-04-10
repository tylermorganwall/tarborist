"use strict";

const vscode = require("vscode");

const { normalizeFile } = require("../util/paths");
const { toVsCodeRange } = require("../util/vscode");

const DEFAULT_TARGET_HEATMAP_OPTIONS = Object.freeze({
  enabled: false,
  metric: "size",
  minRuntimeSeconds: 1,
  minSizeBytes: 1024,
  palette: [
    "rgba(124, 92, 255, 0.07)",
    "rgba(124, 92, 255, 0.12)",
    "rgba(124, 92, 255, 0.18)",
    "rgba(124, 92, 255, 0.26)"
  ],
  runtimeBreaksSeconds: [5, 30, 120],
  sizeBreaksBytes: [10 * 1024, 100 * 1024, 1024 * 1024]
});

function normalizeNumberArray(value, fallback) {
  if (!Array.isArray(value)) {
    return fallback.slice();
  }

  const numbers = [...new Set(value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry >= 0))]
    .sort((left, right) => left - right);

  return numbers.length ? numbers : fallback.slice();
}

function normalizePalette(value, fallback) {
  if (!Array.isArray(value)) {
    return fallback.slice();
  }

  const colors = value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);

  return colors.length ? colors : fallback.slice();
}

function getTargetHeatmapOptions(config = vscode.workspace.getConfiguration("tarborist")) {
  const enabled = Boolean(config.get("targetHeatmap.enabled", DEFAULT_TARGET_HEATMAP_OPTIONS.enabled));
  const metric = config.get("targetHeatmap.metric", DEFAULT_TARGET_HEATMAP_OPTIONS.metric) === "runtime"
    ? "runtime"
    : "size";
  const minSizeBytes = Number(config.get("targetHeatmap.minSizeBytes", DEFAULT_TARGET_HEATMAP_OPTIONS.minSizeBytes));
  const minRuntimeSeconds = Number(config.get("targetHeatmap.minRuntimeSeconds", DEFAULT_TARGET_HEATMAP_OPTIONS.minRuntimeSeconds));

  return {
    enabled,
    metric,
    minRuntimeSeconds: Number.isFinite(minRuntimeSeconds) && minRuntimeSeconds >= 0
      ? minRuntimeSeconds
      : DEFAULT_TARGET_HEATMAP_OPTIONS.minRuntimeSeconds,
    minSizeBytes: Number.isFinite(minSizeBytes) && minSizeBytes >= 0
      ? minSizeBytes
      : DEFAULT_TARGET_HEATMAP_OPTIONS.minSizeBytes,
    palette: normalizePalette(config.get("targetHeatmap.palette", DEFAULT_TARGET_HEATMAP_OPTIONS.palette), DEFAULT_TARGET_HEATMAP_OPTIONS.palette),
    runtimeBreaksSeconds: normalizeNumberArray(
      config.get("targetHeatmap.runtimeBreaksSeconds", DEFAULT_TARGET_HEATMAP_OPTIONS.runtimeBreaksSeconds),
      DEFAULT_TARGET_HEATMAP_OPTIONS.runtimeBreaksSeconds
    ),
    sizeBreaksBytes: normalizeNumberArray(
      config.get("targetHeatmap.sizeBreaksBytes", DEFAULT_TARGET_HEATMAP_OPTIONS.sizeBreaksBytes),
      DEFAULT_TARGET_HEATMAP_OPTIONS.sizeBreaksBytes
    )
  };
}

function getTargetHeatmapMetricValue(meta, metric) {
  if (!meta) {
    return null;
  }

  return metric === "runtime" ? meta.secondsValue : meta.bytesValue;
}

function getTargetHeatmapBucket(metricValue, options) {
  if (!Number.isFinite(metricValue) || !options || !options.enabled || !Array.isArray(options.palette) || !options.palette.length) {
    return null;
  }

  const minimum = options.metric === "runtime" ? options.minRuntimeSeconds : options.minSizeBytes;
  if (!Number.isFinite(minimum) || metricValue < minimum) {
    return null;
  }

  const breaks = options.metric === "runtime" ? options.runtimeBreaksSeconds : options.sizeBreaksBytes;
  let bucketIndex = 0;
  for (const breakpoint of breaks) {
    if (metricValue >= breakpoint) {
      bucketIndex += 1;
      continue;
    }

    break;
  }

  return Math.min(bucketIndex, options.palette.length - 1);
}

function getHeatmapTargets(index) {
  return index.completionTargets || index.targets || new Map();
}

function collectTargetHeatmapAssignments(index, filePath, options) {
  const assignments = new Map();
  if (!index || !options || !options.enabled) {
    return assignments;
  }

  const normalizedFile = normalizeFile(filePath);
  for (const target of getHeatmapTargets(index).values()) {
    if (!target || target.generated || !target.nameRange || normalizeFile(target.file) !== normalizedFile) {
      continue;
    }

    const metricValue = getTargetHeatmapMetricValue(index.targetsMeta && index.targetsMeta.get(target.name), options.metric);
    const bucket = getTargetHeatmapBucket(metricValue, options);
    if (bucket === null) {
      continue;
    }

    if (!assignments.has(bucket)) {
      assignments.set(bucket, []);
    }

    assignments.get(bucket).push({
      range: target.nameRange,
      targetName: target.name
    });
  }

  return assignments;
}

class TargetHeatmapController {
  constructor(indexManager) {
    this.indexManager = indexManager;
    this.decorationKey = "";
    this.decorationTypes = [];
  }

  dispose() {
    this.disposeDecorationTypes();
  }

  disposeDecorationTypes() {
    for (const decorationType of this.decorationTypes) {
      decorationType.dispose();
    }

    this.decorationTypes = [];
    this.decorationKey = "";
  }

  ensureDecorationTypes(options) {
    const key = JSON.stringify(options.palette);
    if (this.decorationKey === key && this.decorationTypes.length === options.palette.length) {
      return;
    }

    this.disposeDecorationTypes();
    this.decorationTypes = options.palette.map((backgroundColor) => vscode.window.createTextEditorDecorationType({
      backgroundColor,
      rangeBehavior: vscode.DecorationRangeBehavior
        ? vscode.DecorationRangeBehavior.ClosedClosed
        : undefined
    }));
    this.decorationKey = key;
  }

  clearEditor(editor) {
    for (const decorationType of this.decorationTypes) {
      editor.setDecorations(decorationType, []);
    }
  }

  async updateEditor(editor, indexOverride = null) {
    if (!editor || !editor.document || editor.document.uri.scheme !== "file" || editor.document.languageId !== "r") {
      return;
    }

    const options = getTargetHeatmapOptions();
    if (!options.enabled) {
      this.clearEditor(editor);
      return;
    }

    const index = indexOverride || await this.indexManager.getIndexForUri(editor.document.uri);
    if (!index) {
      this.clearEditor(editor);
      return;
    }

    this.ensureDecorationTypes(options);
    const assignments = collectTargetHeatmapAssignments(index, editor.document.uri.fsPath, options);
    for (let bucket = 0; bucket < this.decorationTypes.length; bucket += 1) {
      const ranges = (assignments.get(bucket) || []).map((assignment) => toVsCodeRange(assignment.range));
      editor.setDecorations(this.decorationTypes[bucket], ranges);
    }
  }

  async refreshEditorsForRoot(root, index) {
    const normalizedRoot = normalizeFile(root);
    const visibleEditors = vscode.window.visibleTextEditors || [];
    const updates = visibleEditors
      .filter((editor) => this.indexManager.getPipelineRootForUri(editor.document.uri) === normalizedRoot)
      .map((editor) => this.updateEditor(editor, index));
    await Promise.all(updates);
  }

  async refreshVisibleEditors() {
    await Promise.all((vscode.window.visibleTextEditors || []).map((editor) => this.updateEditor(editor)));
  }
}

module.exports = {
  DEFAULT_TARGET_HEATMAP_OPTIONS,
  TargetHeatmapController,
  collectTargetHeatmapAssignments,
  getTargetHeatmapBucket,
  getTargetHeatmapMetricValue,
  getTargetHeatmapOptions
};
