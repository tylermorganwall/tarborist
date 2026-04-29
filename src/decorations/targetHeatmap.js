"use strict";

const crypto = require("crypto");
const vscode = require("vscode");

const { normalizeFile } = require("../util/paths");
const { toVsCodeRange } = require("../util/vscode");

const TARGET_HEATMAP_METRICS = new Set(["directDescendants", "runtime", "size"]);
const DEFAULT_TARGET_HEATMAP_OPTIONS = Object.freeze({
  enabled: false,
  directDescendantBreaks: [2, 5, 10],
  metric: "directDescendants",
  minDirectDescendants: 1,
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
const DEFAULT_TARGET_INVALIDATION_DECORATION_OPTIONS = Object.freeze({
  color: "rgba(37, 99, 235, 0.95)",
  enabled: true,
  includeReferences: true
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

function normalizeTargetHeatmapMetric(value) {
  const metric = String(value || "").trim();
  return TARGET_HEATMAP_METRICS.has(metric)
    ? metric
    : DEFAULT_TARGET_HEATMAP_OPTIONS.metric;
}

function getTargetHeatmapOptions(config = vscode.workspace.getConfiguration("tarborist")) {
  const enabled = Boolean(config.get("targetHeatmap.enabled", DEFAULT_TARGET_HEATMAP_OPTIONS.enabled));
  const metric = normalizeTargetHeatmapMetric(config.get("targetHeatmap.metric", DEFAULT_TARGET_HEATMAP_OPTIONS.metric));
  const minDirectDescendants = Number(config.get(
    "targetHeatmap.minDirectDescendants",
    DEFAULT_TARGET_HEATMAP_OPTIONS.minDirectDescendants
  ));
  const minSizeBytes = Number(config.get("targetHeatmap.minSizeBytes", DEFAULT_TARGET_HEATMAP_OPTIONS.minSizeBytes));
  const minRuntimeSeconds = Number(config.get("targetHeatmap.minRuntimeSeconds", DEFAULT_TARGET_HEATMAP_OPTIONS.minRuntimeSeconds));

  return {
    directDescendantBreaks: normalizeNumberArray(
      config.get("targetHeatmap.directDescendantBreaks", DEFAULT_TARGET_HEATMAP_OPTIONS.directDescendantBreaks),
      DEFAULT_TARGET_HEATMAP_OPTIONS.directDescendantBreaks
    ),
    enabled,
    metric,
    minDirectDescendants: Number.isFinite(minDirectDescendants) && minDirectDescendants >= 0
      ? minDirectDescendants
      : DEFAULT_TARGET_HEATMAP_OPTIONS.minDirectDescendants,
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

function getTargetInvalidationDecorationOptions(config = vscode.workspace.getConfiguration("tarborist")) {
  const color = String(
    config.get("targetInvalidationDecorations.color", DEFAULT_TARGET_INVALIDATION_DECORATION_OPTIONS.color) || ""
  ).trim() || DEFAULT_TARGET_INVALIDATION_DECORATION_OPTIONS.color;

  return {
    color,
    enabled: Boolean(config.get("targetInvalidationDecorations.enabled", DEFAULT_TARGET_INVALIDATION_DECORATION_OPTIONS.enabled)),
    includeReferences: Boolean(config.get("targetInvalidationDecorations.includeReferences", DEFAULT_TARGET_INVALIDATION_DECORATION_OPTIONS.includeReferences))
  };
}

function getHeatmapGraph(index) {
  return index && (index.completionGraph || index.graph)
    ? (index.completionGraph || index.graph)
    : null;
}

function getTargetDirectDescendantCount(index, targetName) {
  const graph = getHeatmapGraph(index);
  if (!graph || !graph.upstreamToDownstream || !targetName) {
    return null;
  }

  return (graph.upstreamToDownstream.get(targetName) || new Set()).size;
}

function getTargetHeatmapMetricValue(meta, metric, index = null, targetName = null) {
  const normalizedMetric = normalizeTargetHeatmapMetric(metric);
  if (normalizedMetric === "directDescendants") {
    return getTargetDirectDescendantCount(index, targetName);
  }

  if (!meta) {
    return null;
  }

  return normalizedMetric === "runtime" ? meta.secondsValue : meta.bytesValue;
}

function isHeatmapExcludedTarget(meta) {
  return Boolean(meta && meta.format === "file");
}

function isMetadataHeatmapMetric(metric) {
  return metric === "runtime" || metric === "size";
}

function getTargetHeatmapMinimum(options) {
  const metric = normalizeTargetHeatmapMetric(options.metric);
  let value;
  let fallback;
  if (metric === "directDescendants") {
    value = Number(options.minDirectDescendants);
    fallback = DEFAULT_TARGET_HEATMAP_OPTIONS.minDirectDescendants;
  } else if (metric === "runtime") {
    value = Number(options.minRuntimeSeconds);
    fallback = DEFAULT_TARGET_HEATMAP_OPTIONS.minRuntimeSeconds;
  } else {
    value = Number(options.minSizeBytes);
    fallback = DEFAULT_TARGET_HEATMAP_OPTIONS.minSizeBytes;
  }

  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getTargetHeatmapBreaks(options) {
  const metric = normalizeTargetHeatmapMetric(options.metric);
  if (metric === "directDescendants") {
    return normalizeNumberArray(options.directDescendantBreaks, DEFAULT_TARGET_HEATMAP_OPTIONS.directDescendantBreaks);
  }

  return metric === "runtime"
    ? normalizeNumberArray(options.runtimeBreaksSeconds, DEFAULT_TARGET_HEATMAP_OPTIONS.runtimeBreaksSeconds)
    : normalizeNumberArray(options.sizeBreaksBytes, DEFAULT_TARGET_HEATMAP_OPTIONS.sizeBreaksBytes);
}

function getTargetHeatmapBucket(metricValue, options) {
  if (!Number.isFinite(metricValue) || !options || !options.enabled || !Array.isArray(options.palette) || !options.palette.length) {
    return null;
  }

  const minimum = getTargetHeatmapMinimum(options);
  if (!Number.isFinite(minimum) || metricValue < minimum) {
    return null;
  }

  const breaks = getTargetHeatmapBreaks(options);
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

function getHeatmapRefs(index) {
  return index.completionRefs || index.refs || [];
}

function getIndexedFileText(index, file) {
  if (!index || !index.files || !file) {
    return null;
  }

  const record = index.files.get(normalizeFile(file));
  return record && typeof record.text === "string" ? record.text : null;
}

function isIndexedFileCurrent(index, file, readFile) {
  const indexedText = getIndexedFileText(index, file);
  if (indexedText === null || typeof readFile !== "function") {
    return true;
  }

  try {
    return readFile(normalizeFile(file)) === indexedText;
  } catch (_error) {
    return true;
  }
}

function getTargetCueMode(target) {
  const cueText = target && target.options ? target.options.cue : null;
  if (!cueText) {
    return null;
  }

  const namedMode = /\bmode\s*=\s*["'](always|never)["']/i.exec(cueText);
  if (namedMode) {
    return namedMode[1].toLowerCase();
  }

  const positionalMode = /(?:^|::)tar_cue\s*\(\s*["'](always|never)["']/i.exec(cueText);
  if (positionalMode) {
    return positionalMode[1].toLowerCase();
  }

  return null;
}

function getTargetCueModes(index, targetNames) {
  const cueModes = new Map();
  const targets = getHeatmapTargets(index);

  for (const name of targetNames) {
    cueModes.set(name, getTargetCueMode(targets.get(name)));
  }

  return cueModes;
}

function isTargetNotBuilt(meta) {
  return !meta || !Number.isFinite(meta.timestampMs);
}

function positionToOffset(text, position) {
  let offset = 0;
  let line = 0;

  while (line < position.line) {
    const nextBreak = text.indexOf("\n", offset);
    if (nextBreak === -1) {
      return text.length;
    }

    offset = nextBreak + 1;
    line += 1;
  }

  return Math.min(text.length, offset + position.character);
}

function sliceRangeText(text, range) {
  if (!text || !range) {
    return "";
  }

  const start = positionToOffset(text, range.start);
  const end = positionToOffset(text, range.end);
  return text.slice(start, end);
}

function hashText(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function buildTargetCodeHashes(index, readFile) {
  const hashes = new Map();
  if (!index || typeof readFile !== "function") {
    return hashes;
  }

  const textCache = new Map();
  const readSource = (file) => {
    const normalized = normalizeFile(file);
    if (!textCache.has(normalized)) {
      const indexedText = getIndexedFileText(index, normalized);
      textCache.set(normalized, indexedText === null ? readFile(normalized) : indexedText);
    }

    return textCache.get(normalized);
  };

  for (const target of getHeatmapTargets(index).values()) {
    if (!target || target.generated || !target.fullRange || !target.file) {
      continue;
    }

    try {
      const text = sliceRangeText(readSource(target.file), target.fullRange);
      hashes.set(target.name, hashText(`${target.origin || "tar_target"}\u0000${text}`));
    } catch (_error) {
      continue;
    }
  }

  return hashes;
}

function buildTargetMetaStamps(index) {
  const stamps = new Map();
  if (!index || !index.targetsMeta) {
    return stamps;
  }

  for (const [name, meta] of index.targetsMeta.entries()) {
    if (!meta) {
      stamps.set(name, "");
      continue;
    }

    if (meta.raw) {
      stamps.set(name, JSON.stringify({
        raw: meta.raw,
        timestampMs: Number.isFinite(meta.timestampMs) ? meta.timestampMs : ""
      }));
      continue;
    }

    stamps.set(name, JSON.stringify([
      Number.isFinite(meta.timestampMs) ? meta.timestampMs : "",
      meta.bytes || "",
      meta.runtime || "",
      meta.warnings || "",
      meta.error || ""
    ]));
  }

  return stamps;
}

function buildTargetDataStamps(index) {
  const stamps = new Map();
  if (!index || !index.targetsMeta) {
    return stamps;
  }

  for (const [name, meta] of index.targetsMeta.entries()) {
    const data = meta && meta.raw && typeof meta.raw.data === "string"
      ? meta.raw.data
      : "";
    stamps.set(name, data);
  }

  return stamps;
}

function normalizeInvalidationState(previousState = null) {
  const state = previousState || {};
  return {
    baselineHashes: new Map(state.baselineHashes || []),
    builtRevisions: new Map(state.builtRevisions || []),
    contentRevisions: new Map(state.contentRevisions || []),
    dataStamps: new Map(state.dataStamps || []),
    initialized: Boolean(state.initialized),
    metaStamps: new Map(state.metaStamps || []),
    nextRevision: Number.isFinite(state.nextRevision) && state.nextRevision > 0 ? state.nextRevision : 1,
    observedHashes: new Map(state.observedHashes || []),
    outputRevisions: new Map(state.outputRevisions || [])
  };
}

function emptyInvalidationState() {
  return {
    changedTargets: new Set(),
    downstreamTargets: new Set()
  };
}

function computeInvalidationRevisions(index, targetNames, sourceRevisions, state = null) {
  const graph = index && (index.completionGraph || index.graph);
  const downstream = graph && graph.upstreamToDownstream ? graph.upstreamToDownstream : new Map();
  const cueModes = getTargetCueModes(index, targetNames);
  const revisions = new Map();
  const queue = [];

  for (const name of targetNames) {
    const revision = sourceRevisions.get(name) || 0;
    revisions.set(name, revision);
    if (revision > 0) {
      queue.push({ name, revision });
    }
  }

  while (queue.length) {
    const { name, revision } = queue.pop();
    if (cueModes.get(name) === "never") {
      continue;
    }

    const builtRevision = state ? (state.builtRevisions.get(name) || 0) : 0;
    const outputRevision = state ? (state.outputRevisions.get(name) || 0) : revision;
    const propagationRevision = state && builtRevision >= revision
      ? outputRevision
      : revision;
    if (propagationRevision <= 0) {
      continue;
    }

    for (const child of downstream.get(name) || []) {
      if (cueModes.get(child) === "never") {
        continue;
      }

      if (propagationRevision > (revisions.get(child) || 0)) {
        revisions.set(child, propagationRevision);
        queue.push({ name: child, revision: propagationRevision });
      }
    }
  }

  return revisions;
}

function computePotentialSourceRevisions(targetNames, state, currentHashes) {
  const revisions = new Map();

  for (const name of targetNames) {
    const currentHash = currentHashes.get(name) || null;
    const builtHash = state.baselineHashes.get(name) || null;
    const builtRevision = state.builtRevisions.get(name) || 0;
    const contentRevision = state.contentRevisions.get(name) || 0;
    const directlyInvalidated = !builtHash || currentHash !== builtHash || builtRevision < contentRevision;
    const revision = directlyInvalidated
      ? contentRevision
      : (state.outputRevisions.get(name) || 0);
    revisions.set(name, revision);
  }

  return revisions;
}

function targetBuildMayHaveChangedOutput(previousDataStamp, currentDataStamp) {
  return !previousDataStamp || !currentDataStamp || previousDataStamp !== currentDataStamp;
}

function computeAlwaysAffectedTargets(index, targetNames) {
  const graph = index && (index.completionGraph || index.graph);
  const downstream = graph && graph.upstreamToDownstream ? graph.upstreamToDownstream : new Map();
  const cueModes = getTargetCueModes(index, targetNames);
  const changedTargets = new Set();
  const downstreamTargets = new Set();

  for (const name of targetNames) {
    if (cueModes.get(name) !== "always") {
      continue;
    }

    changedTargets.add(name);
    const queue = [name];
    const seen = new Set([name]);

    while (queue.length) {
      const current = queue.pop();
      for (const child of downstream.get(current) || []) {
        if (seen.has(child) || cueModes.get(child) === "never") {
          continue;
        }

        seen.add(child);
        if (cueModes.get(child) === "always") {
          changedTargets.add(child);
        } else {
          downstreamTargets.add(child);
        }
        queue.push(child);
      }
    }
  }

  return {
    changedTargets,
    downstreamTargets
  };
}

function reconcileTargetInvalidationState(index, readFile, previousState = null) {
  const state = normalizeInvalidationState(previousState);
  const currentHashes = buildTargetCodeHashes(index, readFile);
  const currentMetaStamps = buildTargetMetaStamps(index);
  const currentDataStamps = buildTargetDataStamps(index);
  const targetNames = new Set(currentHashes.keys());
  const alwaysAffectedTargets = computeAlwaysAffectedTargets(index, targetNames);

  if (!state.initialized) {
    for (const [name, hash] of currentHashes.entries()) {
      state.baselineHashes.set(name, hash);
      state.builtRevisions.set(name, 0);
      state.contentRevisions.set(name, 0);
      state.dataStamps.set(name, currentDataStamps.get(name) || "");
      state.metaStamps.set(name, currentMetaStamps.get(name) || "");
      state.observedHashes.set(name, hash);
      state.outputRevisions.set(name, 0);
    }

    state.initialized = true;
    return {
      ...state,
      changedTargets: alwaysAffectedTargets.changedTargets,
      downstreamTargets: alwaysAffectedTargets.downstreamTargets
    };
  }

  for (const name of [...state.observedHashes.keys()]) {
    if (!targetNames.has(name)) {
      state.baselineHashes.delete(name);
      state.builtRevisions.delete(name);
      state.contentRevisions.delete(name);
      state.dataStamps.delete(name);
      state.metaStamps.delete(name);
      state.observedHashes.delete(name);
      state.outputRevisions.delete(name);
    }
  }

  const pendingBuilds = new Map();
  for (const [name, currentHash] of currentHashes.entries()) {
    const currentStamp = currentMetaStamps.get(name) || "";
    const currentDataStamp = currentDataStamps.get(name) || "";

    if (!state.observedHashes.has(name)) {
      const revision = state.nextRevision;
      state.nextRevision += 1;
      state.observedHashes.set(name, currentHash);
      state.contentRevisions.set(name, revision);
      state.dataStamps.set(name, currentDataStamp);
      state.metaStamps.set(name, currentStamp);
      if (currentStamp) {
        state.baselineHashes.set(name, currentHash);
        state.builtRevisions.set(name, revision);
      } else {
        state.builtRevisions.set(name, 0);
      }
      state.outputRevisions.set(name, 0);
      continue;
    }

    const previousObservedHash = state.observedHashes.get(name);
    const previousBuiltHash = state.baselineHashes.get(name);
    const previousBuiltRevision = state.builtRevisions.get(name) || 0;
    if (currentHash !== previousObservedHash) {
      state.observedHashes.set(name, currentHash);
      if (previousBuiltHash && currentHash === previousBuiltHash) {
        state.contentRevisions.set(name, previousBuiltRevision);
      } else {
        state.contentRevisions.set(name, state.nextRevision);
        state.nextRevision += 1;
      }
    }

    const previousStamp = state.metaStamps.get(name) || "";
    if (currentStamp && currentStamp !== previousStamp) {
      const previousDataStamp = state.dataStamps.get(name) || "";
      state.baselineHashes.set(name, currentHash);
      pendingBuilds.set(name, {
        currentDataStamp,
        previousDataStamp
      });
    }

    state.dataStamps.set(name, currentDataStamp);
    state.metaStamps.set(name, currentStamp);
  }

  const preBuildSourceRevisions = computePotentialSourceRevisions(targetNames, state, currentHashes);
  const preBuildInvalidationRevisions = computeInvalidationRevisions(index, targetNames, preBuildSourceRevisions, state);
  for (const [name, build] of pendingBuilds.entries()) {
    const builtRevision = preBuildInvalidationRevisions.get(name) || 0;
    state.builtRevisions.set(name, builtRevision);
    if (builtRevision > 0 && targetBuildMayHaveChangedOutput(build.previousDataStamp, build.currentDataStamp)) {
      state.outputRevisions.set(name, builtRevision);
    }
  }

  const sourceRevisions = computePotentialSourceRevisions(targetNames, state, currentHashes);
  const invalidationRevisions = computeInvalidationRevisions(index, targetNames, sourceRevisions, state);
  const changedTargets = new Set();
  const downstreamTargets = new Set(alwaysAffectedTargets.downstreamTargets);
  for (const [name, currentHash] of currentHashes.entries()) {
    if (alwaysAffectedTargets.changedTargets.has(name)) {
      changedTargets.add(name);
      downstreamTargets.delete(name);
      continue;
    }

    const builtHash = state.baselineHashes.get(name) || null;
    const builtRevision = state.builtRevisions.get(name) || 0;
    const contentRevision = state.contentRevisions.get(name) || 0;
    const invalidationRevision = invalidationRevisions.get(name) || 0;
    const directlyInvalidated = !builtHash || currentHash !== builtHash || builtRevision < contentRevision;

    if (directlyInvalidated) {
      changedTargets.add(name);
      downstreamTargets.delete(name);
      continue;
    }

    if (builtRevision < invalidationRevision) {
      downstreamTargets.add(name);
    }
  }

  return {
    ...state,
    changedTargets,
    downstreamTargets
  };
}

function dedupeAssignments(assignments, options = {}) {
  const seen = new Set();
  const deduped = [];
  const {
    collapseSharedRanges = false
  } = options;

  for (const assignment of assignments) {
    const range = assignment && assignment.range;
    if (!range) {
      continue;
    }

    const key = [
      range.start.line,
      range.start.character,
      range.end.line,
      range.end.character,
      collapseSharedRanges ? "" : (assignment.targetName || ""),
      collapseSharedRanges ? "" : (assignment.hoverMessage || "")
    ].join(":");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(assignment);
  }

  return deduped;
}

function buildStatusHoverMessage(kind, targetName, detail = null) {
  const header = kind === "error"
    ? `Last build recorded an error for target '${targetName}'.`
    : `Last build recorded a warning for target '${targetName}'.`;
  const normalizedDetail = String(detail || "").trim();
  return normalizedDetail ? `${header}\n${normalizedDetail}` : header;
}

function buildInvalidationHoverMessage(kind, targetName) {
  return kind === "changed"
    ? `Target '${targetName}' has changed since the last tracked build.`
    : `Target '${targetName}' may be invalidated by upstream code changes.`;
}

function collectTargetMarkerAssignments(index, filePath, targetNames, options = {}) {
  if (!index || !targetNames || !targetNames.size) {
    return [];
  }

  const {
    hoverMessageBuilder = null,
    includeReferences = true
  } = options;
  const normalizedFile = normalizeFile(filePath);
  const assignments = [];
  for (const target of getHeatmapTargets(index).values()) {
    if (!target || target.generated || !target.nameRange || normalizeFile(target.file) !== normalizedFile || !targetNames.has(target.name)) {
      continue;
    }

    assignments.push({
      range: target.nameRange,
      targetName: target.name,
      hoverMessage: hoverMessageBuilder ? hoverMessageBuilder(target.name) : undefined
    });
  }

  if (includeReferences) {
    for (const ref of getHeatmapRefs(index)) {
      if (!ref || !ref.range || normalizeFile(ref.file) !== normalizedFile || !targetNames.has(ref.targetName)) {
        continue;
      }

      assignments.push({
        range: ref.range,
        targetName: ref.targetName,
        hoverMessage: hoverMessageBuilder ? hoverMessageBuilder(ref.targetName) : undefined
      });
    }
  }

  // Static tar_map() branches can produce several generated refs on one
  // template identifier; VS Code would otherwise render stacked icons there.
  return dedupeAssignments(assignments, {
    collapseSharedRanges: true
  });
}

function collectTargetHeatmapAssignments(index, filePath, options, invalidationState = null, invalidationOptions = DEFAULT_TARGET_INVALIDATION_DECORATION_OPTIONS) {
  const assignments = {
    buckets: new Map(),
    changed: [],
    downstream: [],
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
        hoverMessage: buildStatusHoverMessage("error", target.name, meta.error),
        range: target.nameRange,
        targetName: target.name
      });
    } else if (meta && meta.hasWarnings) {
      assignments.warning.push({
        hoverMessage: buildStatusHoverMessage("warning", target.name, meta.warnings),
        range: target.nameRange,
        targetName: target.name
      });
    }

    if (isMetadataHeatmapMetric(options.metric)) {
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
    }

    const metricValue = getTargetHeatmapMetricValue(meta, options.metric, index, target.name);
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

  assignments.changed = collectTargetMarkerAssignments(index, filePath, invalidationState && invalidationState.changedTargets, {
    hoverMessageBuilder: (targetName) => buildInvalidationHoverMessage("changed", targetName),
    includeReferences: invalidationOptions.includeReferences
  });
  assignments.downstream = collectTargetMarkerAssignments(index, filePath, invalidationState && invalidationState.downstreamTargets, {
    hoverMessageBuilder: (targetName) => buildInvalidationHoverMessage("downstream", targetName),
    includeReferences: invalidationOptions.includeReferences
  });

  return assignments;
}

function createIconDecorationOptions(color, iconText, placement = "after") {
  const baseOptions = {
    rangeBehavior: vscode.DecorationRangeBehavior
      ? vscode.DecorationRangeBehavior.ClosedClosed
      : undefined
  };

  return {
    ...baseOptions,
    [placement]: {
      color,
      contentText: iconText,
      fontSize: "1.05em",
      margin: "0"
    }
  };
}

function createStatusDecorationOptions(color, style, iconText) {
  const baseOptions = {
    rangeBehavior: vscode.DecorationRangeBehavior
      ? vscode.DecorationRangeBehavior.ClosedClosed
      : undefined
  };

  if (style === "icon") {
    return createIconDecorationOptions(color, iconText, "after");
  }

  return {
    ...baseOptions,
    textDecoration: `underline wavy ${color}`
  };
}

class TargetHeatmapController {
  constructor(indexManager) {
    this.indexManager = indexManager;
    this.changedDecorationType = null;
    this.decorationKey = "";
    this.errorDecorationType = null;
    this.invalidationStates = new Map();
    this.notBuiltDecorationType = null;
    this.decorationTypes = [];
    this.downstreamDecorationType = null;
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

    if (this.changedDecorationType) {
      this.changedDecorationType.dispose();
    }

    if (this.downstreamDecorationType) {
      this.downstreamDecorationType.dispose();
    }

    if (this.warningDecorationType) {
      this.warningDecorationType.dispose();
    }

    this.decorationTypes = [];
    this.changedDecorationType = null;
    this.downstreamDecorationType = null;
    this.errorDecorationType = null;
    this.notBuiltDecorationType = null;
    this.warningDecorationType = null;
    this.decorationKey = "";
  }

  ensureDecorationTypes(options, statusOptions, invalidationOptions) {
    const key = JSON.stringify({
      invalidation: invalidationOptions,
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
    this.changedDecorationType = vscode.window.createTextEditorDecorationType(
      createIconDecorationOptions(invalidationOptions.color, "\u25CF", "before")
    );
    this.decorationTypes = options.palette.map((backgroundColor) => vscode.window.createTextEditorDecorationType({
      backgroundColor,
      rangeBehavior: vscode.DecorationRangeBehavior
        ? vscode.DecorationRangeBehavior.ClosedClosed
        : undefined
    }));
    this.downstreamDecorationType = vscode.window.createTextEditorDecorationType(
      createIconDecorationOptions(invalidationOptions.color, "\u25D0", "before")
    );
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

    if (this.changedDecorationType) {
      editor.setDecorations(this.changedDecorationType, []);
    }

    for (const decorationType of this.decorationTypes) {
      editor.setDecorations(decorationType, []);
    }

    if (this.downstreamDecorationType) {
      editor.setDecorations(this.downstreamDecorationType, []);
    }

    if (this.warningDecorationType) {
      editor.setDecorations(this.warningDecorationType, []);
    }
  }

  getMarkerDecorationEntries(assignments, style) {
    return assignments.map((assignment) => ({
      hoverMessage: style === "icon" ? undefined : assignment.hoverMessage,
      range: toVsCodeRange(style === "icon"
        ? {
          start: assignment.range.start,
          end: assignment.range.start
        }
        : assignment.range)
    }));
  }

  getInvalidationState(root) {
    if (!root) {
      return emptyInvalidationState();
    }

    return this.invalidationStates.get(normalizeFile(root)) || emptyInvalidationState();
  }

  reconcileInvalidationState(root, index) {
    if (!root || !index || !this.indexManager || typeof this.indexManager.readFile !== "function") {
      return emptyInvalidationState();
    }

    const normalizedRoot = normalizeFile(root);
    const nextState = reconcileTargetInvalidationState(
      index,
      (file) => this.indexManager.readFile(file),
      this.invalidationStates.get(normalizedRoot) || null
    );
    this.invalidationStates.set(normalizedRoot, nextState);
    return nextState;
  }

  async updateEditor(editor, indexOverride = null, refreshOptions = {}) {
    if (!editor || !editor.document || editor.document.uri.scheme !== "file" || editor.document.languageId !== "r") {
      return;
    }

    const config = vscode.workspace.getConfiguration("tarborist");
    const options = getTargetHeatmapOptions(config);
    const statusOptions = getTargetStatusDecorationOptions(config);
    const invalidationOptions = getTargetInvalidationDecorationOptions(config);
    if (!options.enabled && !statusOptions.enabled && !invalidationOptions.enabled) {
      this.clearEditor(editor);
      return;
    }

    const index = indexOverride || await this.indexManager.getIndexForUri(editor.document.uri);
    if (!index) {
      this.clearEditor(editor);
      return;
    }

    const root = this.indexManager.getPipelineRootForUri
      ? this.indexManager.getPipelineRootForUri(editor.document.uri)
      : null;
    const readCurrentFile = this.indexManager && typeof this.indexManager.readFile === "function"
      ? (file) => this.indexManager.readFile(file)
      : null;
    const indexedFileCurrent = isIndexedFileCurrent(index, editor.document.uri.fsPath, readCurrentFile);
    const invalidationState = invalidationOptions.enabled && indexedFileCurrent
      ? (refreshOptions.refreshInvalidationState
        ? this.reconcileInvalidationState(root, index)
        : this.getInvalidationState(root))
      : null;

    this.ensureDecorationTypes(options, statusOptions, invalidationOptions);
    const assignments = collectTargetHeatmapAssignments(index, editor.document.uri.fsPath, options, invalidationState, invalidationOptions);
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
          ? this.getMarkerDecorationEntries(assignments.error, statusOptions.style)
          : []
      );
    }

    if (this.changedDecorationType) {
      editor.setDecorations(
        this.changedDecorationType,
        invalidationOptions.enabled
          ? this.getMarkerDecorationEntries(assignments.changed, "icon")
          : []
      );
    }

    for (let bucket = 0; bucket < this.decorationTypes.length; bucket += 1) {
      const ranges = options.enabled
        ? (assignments.buckets.get(bucket) || []).map((assignment) => toVsCodeRange(assignment.range))
        : [];
      editor.setDecorations(this.decorationTypes[bucket], ranges);
    }

    if (this.downstreamDecorationType) {
      editor.setDecorations(
        this.downstreamDecorationType,
        invalidationOptions.enabled
          ? this.getMarkerDecorationEntries(assignments.downstream, "icon")
          : []
      );
    }

    if (this.warningDecorationType) {
      editor.setDecorations(
        this.warningDecorationType,
        statusOptions.enabled
          ? this.getMarkerDecorationEntries(assignments.warning, statusOptions.style)
          : []
      );
    }
  }

  async refreshEditorsForRoot(root, index) {
    const normalizedRoot = normalizeFile(root);
    this.reconcileInvalidationState(normalizedRoot, index);
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
  DEFAULT_TARGET_INVALIDATION_DECORATION_OPTIONS,
  DEFAULT_TARGET_STATUS_DECORATION_OPTIONS,
  TargetHeatmapController,
  buildTargetCodeHashes,
  buildTargetMetaStamps,
  collectTargetHeatmapAssignments,
  computeAlwaysAffectedTargets,
  computeInvalidationRevisions,
  createStatusDecorationOptions,
  getTargetHeatmapBucket,
  getTargetHeatmapMetricValue,
  getTargetHeatmapOptions,
  getTargetInvalidationDecorationOptions,
  getTargetStatusDecorationOptions,
  isTargetNotBuilt,
  normalizeInvalidationState,
  reconcileTargetInvalidationState
};
