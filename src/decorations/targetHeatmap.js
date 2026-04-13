"use strict";

const vscode = require("vscode");

const { normalizeFile } = require("../util/paths");
const { toVsCodeRange } = require("../util/vscode");

const DEFAULT_TARGET_HEATMAP_OPTIONS = Object.freeze({
  enabled: false,
  metric: "size",
  minRuntimeSeconds: 1,
  minSizeBytes: 1024,
  notBuiltColor: "rgba(156, 132, 255, 0.18)",
  palette: [
    "rgba(255, 157, 0, 0.06)",
    "rgba(255, 157, 0, 0.12)",
    "rgba(255, 157, 0, 0.18)",
    "rgba(255, 157, 0, 0.24)"
  ],
  runtimeBreaksSeconds: [5, 30, 120],
  sizeBreaksBytes: [10 * 1024, 100 * 1024, 1024 * 1024]
});
const DEFAULT_TARGET_STATUS_DECORATION_OPTIONS = Object.freeze({
  enabled: true,
  errorColor: "rgba(220, 38, 38, 0.95)",
  style: "icon",
  warningColor: "rgba(234, 179, 8, 0.95)"
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
    notBuiltColor: String(config.get("targetHeatmap.notBuiltColor", DEFAULT_TARGET_HEATMAP_OPTIONS.notBuiltColor) || "").trim()
      || DEFAULT_TARGET_HEATMAP_OPTIONS.notBuiltColor,
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

function getTargetStatusDecorationOptions(config = vscode.workspace.getConfiguration("tarborist")) {
  const style = config.get("targetStatusDecorations.style", DEFAULT_TARGET_STATUS_DECORATION_OPTIONS.style) === "icon"
    ? "icon"
    : "underline";
  return {
    enabled: Boolean(config.get("targetStatusDecorations.enabled", DEFAULT_TARGET_STATUS_DECORATION_OPTIONS.enabled)),
    errorColor: String(config.get("targetStatusDecorations.errorColor", DEFAULT_TARGET_STATUS_DECORATION_OPTIONS.errorColor) || "").trim()
      || DEFAULT_TARGET_STATUS_DECORATION_OPTIONS.errorColor,
    style,
    warningColor: String(config.get("targetStatusDecorations.warningColor", DEFAULT_TARGET_STATUS_DECORATION_OPTIONS.warningColor) || "").trim()
      || DEFAULT_TARGET_STATUS_DECORATION_OPTIONS.warningColor
  };
}

function getTargetHeatmapMetricValue(meta, metric) {
  if (!meta) {
    return null;
  }

  return metric === "runtime" ? meta.secondsValue : meta.bytesValue;
}

function isHeatmapExcludedTarget(meta) {
  return Boolean(meta && meta.format === "file");
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

function isTargetNotBuilt(meta) {
  return !meta || !meta.time;
}

function collectTargetHeatmapAssignments(index, filePath, options) {
  const assignments = {
    buckets: new Map(),
    error: [],
    notBuilt: [],
    warning: []
  };
  if (!index || !options) {
    return assignments;
  }

  const normalizedFile = normalizeFile(filePath);
  for (const target of getHeatmapTargets(index).values()) {
    if (!target || target.generated || !target.nameRange || normalizeFile(target.file) !== normalizedFile) {
      continue;
    }

    const meta = index.targetsMeta && index.targetsMeta.get(target.name);
    if (meta && meta.hasError) {
      assignments.error.push({
        range: target.nameRange,
        targetName: target.name
      });
    } else if (meta && meta.hasWarnings) {
      assignments.warning.push({
        range: target.nameRange,
        targetName: target.name
      });
    }

    if (isHeatmapExcludedTarget(meta)) {
      continue;
    }

    if (isTargetNotBuilt(meta)) {
      assignments.notBuilt.push({
        range: target.nameRange,
        targetName: target.name
      });
      continue;
    }

    const metricValue = getTargetHeatmapMetricValue(meta, options.metric);
    const bucket = getTargetHeatmapBucket(metricValue, options);
    if (bucket === null) {
      continue;
    }

    if (!assignments.buckets.has(bucket)) {
      assignments.buckets.set(bucket, []);
    }

    assignments.buckets.get(bucket).push({
      range: target.nameRange,
      targetName: target.name
    });
  }

  return assignments;
}

function createStatusDecorationOptions(color, style, iconText) {
  const baseOptions = {
    rangeBehavior: vscode.DecorationRangeBehavior
      ? vscode.DecorationRangeBehavior.ClosedClosed
      : undefined
  };

  if (style === "icon") {
    return {
      ...baseOptions,
      after: {
        color,
        contentText: iconText,
        fontSize: "1.05em",
        margin: "0"
      }
    };
  }

  return {
    ...baseOptions,
    textDecoration: `underline wavy ${color}`
  };
}

class TargetHeatmapController {
  constructor(indexManager) {
    this.indexManager = indexManager;
    this.decorationKey = "";
    this.errorDecorationType = null;
    this.notBuiltDecorationType = null;
    this.decorationTypes = [];
    this.warningDecorationType = null;
  }

  dispose() {
    this.disposeDecorationTypes();
  }

  disposeDecorationTypes() {
    for (const decorationType of this.decorationTypes) {
      decorationType.dispose();
    }

    if (this.notBuiltDecorationType) {
      this.notBuiltDecorationType.dispose();
    }

    if (this.errorDecorationType) {
      this.errorDecorationType.dispose();
    }

    if (this.warningDecorationType) {
      this.warningDecorationType.dispose();
    }

    this.decorationTypes = [];
    this.errorDecorationType = null;
    this.notBuiltDecorationType = null;
    this.warningDecorationType = null;
    this.decorationKey = "";
  }

  ensureDecorationTypes(options, statusOptions) {
    const key = JSON.stringify({
      notBuiltColor: options.notBuiltColor,
      palette: options.palette,
      status: statusOptions
    });
    if (this.decorationKey === key && this.decorationTypes.length === options.palette.length) {
      return;
    }

    this.disposeDecorationTypes();
    this.notBuiltDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: options.notBuiltColor,
      rangeBehavior: vscode.DecorationRangeBehavior
        ? vscode.DecorationRangeBehavior.ClosedClosed
        : undefined
    });
    this.errorDecorationType = vscode.window.createTextEditorDecorationType(
      createStatusDecorationOptions(statusOptions.errorColor, statusOptions.style, "\u2716")
    );
    this.decorationTypes = options.palette.map((backgroundColor) => vscode.window.createTextEditorDecorationType({
      backgroundColor,
      rangeBehavior: vscode.DecorationRangeBehavior
        ? vscode.DecorationRangeBehavior.ClosedClosed
        : undefined
    }));
    this.warningDecorationType = vscode.window.createTextEditorDecorationType(
      createStatusDecorationOptions(statusOptions.warningColor, statusOptions.style, "\u25B2")
    );
    this.decorationKey = key;
  }

  clearEditor(editor) {
    if (this.notBuiltDecorationType) {
      editor.setDecorations(this.notBuiltDecorationType, []);
    }

    if (this.errorDecorationType) {
      editor.setDecorations(this.errorDecorationType, []);
    }

    for (const decorationType of this.decorationTypes) {
      editor.setDecorations(decorationType, []);
    }

    if (this.warningDecorationType) {
      editor.setDecorations(this.warningDecorationType, []);
    }
  }

  getStatusDecorationEntries(assignments, style) {
    if (style !== "icon") {
      return assignments.map((assignment) => toVsCodeRange(assignment.range));
    }

    return assignments.map((assignment) => toVsCodeRange({
      start: assignment.range.start,
      end: assignment.range.start
    }));
  }

  async updateEditor(editor, indexOverride = null) {
    if (!editor || !editor.document || editor.document.uri.scheme !== "file" || editor.document.languageId !== "r") {
      return;
    }

    const config = vscode.workspace.getConfiguration("tarborist");
    const options = getTargetHeatmapOptions(config);
    const statusOptions = getTargetStatusDecorationOptions(config);
    if (!options.enabled && !statusOptions.enabled) {
      this.clearEditor(editor);
      return;
    }

    const index = indexOverride || await this.indexManager.getIndexForUri(editor.document.uri);
    if (!index) {
      this.clearEditor(editor);
      return;
    }

    this.ensureDecorationTypes(options, statusOptions);
    const assignments = collectTargetHeatmapAssignments(index, editor.document.uri.fsPath, options);
    if (this.notBuiltDecorationType) {
      editor.setDecorations(
        this.notBuiltDecorationType,
        options.enabled
          ? assignments.notBuilt.map((assignment) => toVsCodeRange(assignment.range))
          : []
      );
    }

    if (this.errorDecorationType) {
      editor.setDecorations(
        this.errorDecorationType,
        statusOptions.enabled
          ? this.getStatusDecorationEntries(assignments.error, statusOptions.style)
          : []
      );
    }

    for (let bucket = 0; bucket < this.decorationTypes.length; bucket += 1) {
      const ranges = options.enabled
        ? (assignments.buckets.get(bucket) || []).map((assignment) => toVsCodeRange(assignment.range))
        : [];
      editor.setDecorations(this.decorationTypes[bucket], ranges);
    }

    if (this.warningDecorationType) {
      editor.setDecorations(
        this.warningDecorationType,
        statusOptions.enabled
          ? this.getStatusDecorationEntries(assignments.warning, statusOptions.style)
          : []
      );
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
  DEFAULT_TARGET_STATUS_DECORATION_OPTIONS,
  TargetHeatmapController,
  collectTargetHeatmapAssignments,
  createStatusDecorationOptions,
  getTargetHeatmapBucket,
  getTargetHeatmapMetricValue,
  getTargetHeatmapOptions,
  getTargetStatusDecorationOptions,
  isTargetNotBuilt
};
