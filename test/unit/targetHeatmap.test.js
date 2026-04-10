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
  const mockVscode = {
    DecorationRangeBehavior: {
      ClosedClosed: "closedClosed"
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
      createTextEditorDecorationType() {
        return {
          dispose() {}
        };
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
    return require("../../src/decorations/targetHeatmap");
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
  assert.deepEqual(options.runtimeBreaksSeconds, [10, 60]);
  assert.deepEqual(options.palette, ["rgba(1, 2, 3, 0.1)"]);
  assert.deepEqual(options.sizeBreaksBytes, DEFAULT_TARGET_HEATMAP_OPTIONS.sizeBreaksBytes);
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

  assert.deepEqual((assignments.get(0) || []).map((assignment) => assignment.targetName), ["y"]);
  assert.deepEqual((assignments.get(1) || []).map((assignment) => assignment.targetName), ["x"]);
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

  assert.deepEqual((assignments.get(0) || []).map((assignment) => assignment.targetName), ["y"]);
  assert.deepEqual((assignments.get(1) || []).map((assignment) => assignment.targetName), ["x"]);
});
