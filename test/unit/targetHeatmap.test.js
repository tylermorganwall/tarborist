"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const test = require("node:test");

const { buildStaticWorkspaceIndex } = require("../../src/index/pipelineResolver");
const { ensureParserReady } = require("../../src/parser/treeSitter");

function buildIndex(fixtureName) {
  const root = path.resolve(__dirname, "..", "fixtures", fixtureName);
  return {
    index: buildStaticWorkspaceIndex({
      readFile: (file) => fs.readFileSync(file, "utf8"),
      workspaceRoot: root
    }),
    root
  };
}

function loadTargetHeatmapWithMockVscode(configValues = {}) {
  const createdDecorationTypes = [];
  const mockVscode = {
    DecorationRangeBehavior: {
      ClosedClosed: "closedClosed"
    },
    Range: class Range {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(configValues, key)
              ? configValues[key]
              : fallback;
          }
        };
      }
    },
    window: {
      createTextEditorDecorationType(options) {
        const decorationType = {
          options,
          dispose() {}
        };
        createdDecorationTypes.push(decorationType);
        return decorationType;
      }
    }
  };

  const modulePath = require.resolve("../../src/decorations/targetHeatmap");
  delete require.cache[modulePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return mockVscode;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return {
      ...require("../../src/decorations/targetHeatmap"),
      createdDecorationTypes
    };
  } finally {
    Module._load = originalLoad;
  }
}

test.before(async () => {
  await ensureParserReady();
});

test("getTargetHeatmapOptions() reads target heatmap settings with sane defaults", () => {
  const {
    DEFAULT_TARGET_HEATMAP_OPTIONS,
    getTargetHeatmapOptions
  } = loadTargetHeatmapWithMockVscode({
    "targetHeatmap.enabled": true,
    "targetHeatmap.metric": "runtime",
    "targetHeatmap.minRuntimeSeconds": 2,
    "targetHeatmap.runtimeBreaksSeconds": [10, 60],
    "targetHeatmap.palette": ["rgba(1, 2, 3, 0.1)"]
  });

  const options = getTargetHeatmapOptions();

  assert.equal(options.enabled, true);
  assert.equal(options.metric, "runtime");
  assert.equal(options.minRuntimeSeconds, 2);
  assert.equal(options.notBuiltColor, "rgba(156, 132, 255, 0.18)");
  assert.deepEqual(options.runtimeBreaksSeconds, [10, 60]);
  assert.deepEqual(options.palette, ["rgba(1, 2, 3, 0.1)"]);
  assert.deepEqual(options.sizeBreaksBytes, DEFAULT_TARGET_HEATMAP_OPTIONS.sizeBreaksBytes);
});

test("getTargetStatusDecorationOptions() reads warning/error underline settings", () => {
  const {
    DEFAULT_TARGET_STATUS_DECORATION_OPTIONS,
    getTargetStatusDecorationOptions
  } = loadTargetHeatmapWithMockVscode({
    "targetStatusDecorations.enabled": true,
    "targetStatusDecorations.errorColor": "#ff0000",
    "targetStatusDecorations.style": "icon",
    "targetStatusDecorations.warningColor": "#ffff00"
  });

  const options = getTargetStatusDecorationOptions();

  assert.equal(options.enabled, true);
  assert.equal(options.errorColor, "#ff0000");
  assert.equal(options.style, "icon");
  assert.equal(options.warningColor, "#ffff00");
  assert.ok(DEFAULT_TARGET_STATUS_DECORATION_OPTIONS.errorColor);
});

test("collectTargetHeatmapAssignments() buckets targets by size metadata", () => {
  const { collectTargetHeatmapAssignments } = loadTargetHeatmapWithMockVscode();
  const { index, root } = buildIndex("meta_hover");
  const assignments = collectTargetHeatmapAssignments(index, path.join(root, "_targets.R"), {
    enabled: true,
    metric: "size",
    minRuntimeSeconds: 1,
    minSizeBytes: 100,
    palette: ["c1", "c2"],
    runtimeBreaksSeconds: [5, 30, 120],
    sizeBreaksBytes: [1000]
  });

  assert.deepEqual(assignments.notBuilt.map((assignment) => assignment.targetName), ["y"]);
  assert.deepEqual(assignments.error.map((assignment) => assignment.targetName), ["x"]);
  assert.deepEqual(assignments.warning.map((assignment) => assignment.targetName), []);
  assert.deepEqual((assignments.buckets.get(1) || []).map((assignment) => assignment.targetName), ["x"]);
});

test("collectTargetHeatmapAssignments() buckets targets by runtime metadata", () => {
  const { collectTargetHeatmapAssignments } = loadTargetHeatmapWithMockVscode();
  const { index, root } = buildIndex("meta_hover");
  const assignments = collectTargetHeatmapAssignments(index, path.join(root, "_targets.R"), {
    enabled: true,
    metric: "runtime",
    minRuntimeSeconds: 0.1,
    minSizeBytes: 1024,
    palette: ["c1", "c2"],
    runtimeBreaksSeconds: [0.15],
    sizeBreaksBytes: [10 * 1024, 100 * 1024, 1024 * 1024]
  });

  assert.deepEqual(assignments.notBuilt.map((assignment) => assignment.targetName), ["y"]);
  assert.deepEqual(assignments.error.map((assignment) => assignment.targetName), ["x"]);
  assert.deepEqual(assignments.warning.map((assignment) => assignment.targetName), []);
  assert.deepEqual((assignments.buckets.get(1) || []).map((assignment) => assignment.targetName), ["x"]);
});

test("collectTargetHeatmapAssignments() marks targets with no build timestamp as not built", () => {
  const { collectTargetHeatmapAssignments } = loadTargetHeatmapWithMockVscode();
  const { index, root } = buildIndex("meta_hover");
  const assignments = collectTargetHeatmapAssignments(index, path.join(root, "_targets.R"), {
    enabled: true,
    metric: "size",
    minRuntimeSeconds: 1,
    minSizeBytes: 100000,
    notBuiltColor: "purple",
    palette: ["c1", "c2"],
    runtimeBreaksSeconds: [5, 30, 120],
    sizeBreaksBytes: [1000]
  });

  assert.deepEqual(assignments.notBuilt.map((assignment) => assignment.targetName), ["y"]);
  assert.deepEqual(assignments.error.map((assignment) => assignment.targetName), ["x"]);
  assert.equal(assignments.buckets.size, 0);
});

test("collectTargetHeatmapAssignments() separates warning-only and error targets for status underlines", () => {
  const { collectTargetHeatmapAssignments } = loadTargetHeatmapWithMockVscode();
  const { index, root } = buildIndex("meta_status_decorations");
  const assignments = collectTargetHeatmapAssignments(index, path.join(root, "_targets.R"), {
    enabled: true,
    metric: "size",
    minRuntimeSeconds: 1,
    minSizeBytes: 999999,
    notBuiltColor: "purple",
    palette: ["c1", "c2"],
    runtimeBreaksSeconds: [5, 30, 120],
    sizeBreaksBytes: [1000]
  });

  assert.deepEqual(assignments.warning.map((assignment) => assignment.targetName), ["warn_only"]);
  assert.deepEqual(assignments.error.map((assignment) => assignment.targetName), ["error_only"]);
  assert.deepEqual(assignments.notBuilt.map((assignment) => assignment.targetName), ["not_built"]);
  assert.equal(assignments.buckets.size, 0);
});

test("TargetHeatmapController applies warning/error underline decorations without heatmap backgrounds", async () => {
  const {
    TargetHeatmapController,
    createdDecorationTypes
  } = loadTargetHeatmapWithMockVscode({
    "targetStatusDecorations.enabled": true,
    "targetStatusDecorations.errorColor": "#ff0000",
    "targetStatusDecorations.style": "underline",
    "targetStatusDecorations.warningColor": "#ffff00"
  });
  const { index, root } = buildIndex("meta_status_decorations");
  const filePath = path.join(root, "_targets.R");
  const calls = [];
  const editor = {
    document: {
      languageId: "r",
      uri: {
        fsPath: filePath,
        scheme: "file"
      }
    },
    setDecorations(decorationType, ranges) {
      calls.push({
        decorationType,
        ranges
      });
    }
  };
  const controller = new TargetHeatmapController({
    async getIndexForUri() {
      return index;
    }
  });

  await controller.updateEditor(editor, index);

  const errorDecorationType = createdDecorationTypes.find((decorationType) => decorationType.options.textDecoration === "underline wavy #ff0000");
  const warningDecorationType = createdDecorationTypes.find((decorationType) => decorationType.options.textDecoration === "underline wavy #ffff00");
  const notBuiltDecorationType = createdDecorationTypes.find((decorationType) => decorationType.options.backgroundColor === "rgba(156, 132, 255, 0.18)");

  assert.ok(errorDecorationType);
  assert.ok(warningDecorationType);
  assert.ok(notBuiltDecorationType);

  const errorCall = calls.find((call) => call.decorationType === errorDecorationType);
  const warningCall = calls.find((call) => call.decorationType === warningDecorationType);
  const notBuiltCall = calls.find((call) => call.decorationType === notBuiltDecorationType);

  assert.equal(errorCall.ranges.length, 1);
  assert.equal(warningCall.ranges.length, 1);
  assert.equal(notBuiltCall.ranges.length, 0);
});

test("TargetHeatmapController can render warning/error status as leading icons", async () => {
  const {
    TargetHeatmapController,
    createdDecorationTypes
  } = loadTargetHeatmapWithMockVscode({
    "targetStatusDecorations.enabled": true,
    "targetStatusDecorations.errorColor": "#ff0000",
    "targetStatusDecorations.style": "icon",
    "targetStatusDecorations.warningColor": "#ffaa00"
  });
  const { index, root } = buildIndex("meta_status_decorations");
  const filePath = path.join(root, "_targets.R");
  const calls = [];
  const editor = {
    document: {
      languageId: "r",
      uri: {
        fsPath: filePath,
        scheme: "file"
      }
    },
    setDecorations(decorationType, ranges) {
      calls.push({ decorationType, ranges });
    }
  };
  const controller = new TargetHeatmapController({
    async getIndexForUri() {
      return index;
    }
  });

  await controller.updateEditor(editor, index);

  const errorDecorationType = createdDecorationTypes.find((decorationType) => (
    decorationType.options.after
    && decorationType.options.after.contentText === "\u2716"
    && decorationType.options.after.color === "#ff0000"
  ));
  const warningDecorationType = createdDecorationTypes.find((decorationType) => (
    decorationType.options.after
    && decorationType.options.after.contentText === "\u25B2"
    && decorationType.options.after.color === "#ffaa00"
  ));

  assert.ok(errorDecorationType);
  assert.ok(warningDecorationType);
  assert.equal(errorDecorationType.options.after.fontSize, "1.05em");
  assert.equal(warningDecorationType.options.after.fontSize, "1.05em");
  const errorCall = calls.find((call) => call.decorationType === errorDecorationType);
  const warningCall = calls.find((call) => call.decorationType === warningDecorationType);

  assert.equal(errorCall.ranges.length, 1);
  assert.equal(warningCall.ranges.length, 1);
  assert.deepEqual(errorCall.ranges[0].start, errorCall.ranges[0].end);
  assert.deepEqual(warningCall.ranges[0].start, warningCall.ranges[0].end);
});
