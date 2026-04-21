"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const os = require("os");
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

function writeWorkspace(root, text, metaText = null) {
  fs.writeFileSync(path.join(root, "_targets.R"), text, "utf8");

  const metaDir = path.join(root, "_targets", "meta");
  if (metaText == null) {
    fs.rmSync(path.join(root, "_targets"), {
      force: true,
      recursive: true
    });
    return;
  }

  fs.mkdirSync(metaDir, {
    recursive: true
  });
  fs.writeFileSync(path.join(metaDir, "meta"), metaText, "utf8");
}

function buildIndexFromText(text, metaText = null, root = null) {
  const workspaceRoot = root || fs.mkdtempSync(path.join(os.tmpdir(), "targetside-target-heatmap-"));
  writeWorkspace(workspaceRoot, text, metaText);
  const file = path.join(workspaceRoot, "_targets.R");
  return {
    file,
    index: buildStaticWorkspaceIndex({
      readFile: (file) => fs.readFileSync(file, "utf8"),
      workspaceRoot
    }),
    readFile(filePath) {
      return path.resolve(filePath) === path.resolve(file)
        ? text
        : fs.readFileSync(filePath, "utf8");
    },
    root: workspaceRoot
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

test("getTargetInvalidationDecorationOptions() reads invalidation icon settings", () => {
  const {
    DEFAULT_TARGET_INVALIDATION_DECORATION_OPTIONS,
    getTargetInvalidationDecorationOptions
  } = loadTargetHeatmapWithMockVscode({
    "targetInvalidationDecorations.color": "#0055ff",
    "targetInvalidationDecorations.enabled": false,
    "targetInvalidationDecorations.includeReferences": false
  });

  const options = getTargetInvalidationDecorationOptions();

  assert.equal(options.enabled, false);
  assert.equal(options.color, "#0055ff");
  assert.equal(options.includeReferences, false);
  assert.ok(DEFAULT_TARGET_INVALIDATION_DECORATION_OPTIONS.color);
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

test("collectTargetHeatmapAssignments() uses dynamic branch metadata for parent pattern targets", () => {
  const { collectTargetHeatmapAssignments } = loadTargetHeatmapWithMockVscode();
  const { index, root } = buildIndex("meta_dynamic_branches");
  const assignments = collectTargetHeatmapAssignments(index, path.join(root, "_targets.R"), {
    enabled: true,
    metric: "size",
    minRuntimeSeconds: 1,
    minSizeBytes: 100,
    notBuiltColor: "purple",
    palette: ["c1", "c2"],
    runtimeBreaksSeconds: [5, 30, 120],
    sizeBreaksBytes: [300]
  });

  assert.ok(!assignments.notBuilt.some((assignment) => assignment.targetName === "mapped"));
  assert.deepEqual((assignments.buckets.get(1) || []).map((assignment) => assignment.targetName), ["mapped"]);
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

test("collectTargetHeatmapAssignments() excludes file-format targets from heatmap backgrounds", () => {
  const { collectTargetHeatmapAssignments } = loadTargetHeatmapWithMockVscode();
  const { index, root } = buildIndex("meta_file_hover");
  const filePath = path.join(root, "_targets.R");

  const sizeAssignments = collectTargetHeatmapAssignments(index, filePath, {
    enabled: true,
    metric: "size",
    minRuntimeSeconds: 0,
    minSizeBytes: 1,
    notBuiltColor: "purple",
    palette: ["c1", "c2"],
    runtimeBreaksSeconds: [0.1],
    sizeBreaksBytes: [1024]
  });
  const runtimeAssignments = collectTargetHeatmapAssignments(index, filePath, {
    enabled: true,
    metric: "runtime",
    minRuntimeSeconds: 0,
    minSizeBytes: 1,
    notBuiltColor: "purple",
    palette: ["c1", "c2"],
    runtimeBreaksSeconds: [0.1],
    sizeBreaksBytes: [1024]
  });

  assert.equal(sizeAssignments.buckets.size, 0);
  assert.equal(runtimeAssignments.buckets.size, 0);
  assert.deepEqual(sizeAssignments.notBuilt, []);
  assert.deepEqual(runtimeAssignments.notBuilt, []);
});

test("reconcileTargetInvalidationState() marks changed targets and downstream targets separately", () => {
  const {
    reconcileTargetInvalidationState
  } = loadTargetHeatmapWithMockVscode();
  const initialText = [
    "list(",
    "  tar_target(a, 1),",
    "  tar_target(b, a + 1)",
    ")",
    ""
  ].join("\n");
  const changedText = [
    "list(",
    "  tar_target(a, 2),",
    "  tar_target(b, a + 1)",
    ")",
    ""
  ].join("\n");
  const workspace = buildIndexFromText(initialText);
  const initial = buildIndexFromText(initialText, null, workspace.root);
  const changed = buildIndexFromText(changedText, null, workspace.root);

  const seededState = reconcileTargetInvalidationState(
    initial.index,
    (file) => initial.readFile(file),
    null
  );
  const changedState = reconcileTargetInvalidationState(
    changed.index,
    (file) => changed.readFile(file),
    seededState
  );

  assert.deepEqual([...changedState.changedTargets], ["a"]);
  assert.deepEqual([...changedState.downstreamTargets], ["b"]);
});

test("reconcileTargetInvalidationState() keeps downstream targets invalidated until they rebuild", () => {
  const {
    reconcileTargetInvalidationState
  } = loadTargetHeatmapWithMockVscode();
  const initialText = [
    "list(",
    "  tar_target(a, 1),",
    "  tar_target(b, a + 1)",
    ")",
    ""
  ].join("\n");
  const changedText = [
    "list(",
    "  tar_target(a, 2),",
    "  tar_target(b, a + 1)",
    ")",
    ""
  ].join("\n");
  const metaV1 = [
    "name|type|data|command|depend|seed|path|time|size|bytes|format|repository|iteration|parent|children|seconds|warnings|error",
    "a|stem||||||t1s|s1b|1|rds|local|vector|||0.1||",
    "b|stem||||||t1s|s1b|1|rds|local|vector|||0.1||"
  ].join("\n");
  const metaV2 = [
    "name|type|data|command|depend|seed|path|time|size|bytes|format|repository|iteration|parent|children|seconds|warnings|error",
    "a|stem||||||t2s|s1b|1|rds|local|vector|||0.1||",
    "b|stem||||||t1s|s1b|1|rds|local|vector|||0.1||"
  ].join("\n");
  const metaV3 = [
    "name|type|data|command|depend|seed|path|time|size|bytes|format|repository|iteration|parent|children|seconds|warnings|error",
    "a|stem||||||t2s|s1b|1|rds|local|vector|||0.1||",
    "b|stem||||||t3s|s1b|1|rds|local|vector|||0.1||"
  ].join("\n");
  const workspace = buildIndexFromText(initialText, metaV1);
  const initial = buildIndexFromText(initialText, metaV1, workspace.root);
  const changed = buildIndexFromText(changedText, metaV1, workspace.root);
  const upstreamBuilt = buildIndexFromText(changedText, metaV2, workspace.root);
  const downstreamBuilt = buildIndexFromText(changedText, metaV3, workspace.root);

  let state = reconcileTargetInvalidationState(
    initial.index,
    (file) => initial.readFile(file),
    null
  );
  state = reconcileTargetInvalidationState(
    changed.index,
    (file) => changed.readFile(file),
    state
  );
  assert.deepEqual([...state.changedTargets], ["a"]);
  assert.deepEqual([...state.downstreamTargets], ["b"]);

  state = reconcileTargetInvalidationState(
    upstreamBuilt.index,
    (file) => upstreamBuilt.readFile(file),
    state
  );
  assert.deepEqual([...state.changedTargets], []);
  assert.deepEqual([...state.downstreamTargets], ["b"]);

  state = reconcileTargetInvalidationState(
    downstreamBuilt.index,
    (file) => downstreamBuilt.readFile(file),
    state
  );
  assert.deepEqual([...state.changedTargets], []);
  assert.deepEqual([...state.downstreamTargets], []);
});

test("reconcileTargetInvalidationState() does not propagate through targets with cue = tar_cue(\"never\")", () => {
  const {
    reconcileTargetInvalidationState
  } = loadTargetHeatmapWithMockVscode();
  const initialText = [
    "list(",
    "  tar_target(a, 1),",
    "  tar_target(b, a + 1, cue = tar_cue(\"never\")),",
    "  tar_target(c, b + 1)",
    ")",
    ""
  ].join("\n");
  const changedText = [
    "list(",
    "  tar_target(a, 2),",
    "  tar_target(b, a + 1, cue = tar_cue(\"never\")),",
    "  tar_target(c, b + 1)",
    ")",
    ""
  ].join("\n");
  const workspace = buildIndexFromText(initialText);
  const initial = buildIndexFromText(initialText, null, workspace.root);
  const changed = buildIndexFromText(changedText, null, workspace.root);

  const seededState = reconcileTargetInvalidationState(
    initial.index,
    (file) => initial.readFile(file),
    null
  );
  const changedState = reconcileTargetInvalidationState(
    changed.index,
    (file) => changed.readFile(file),
    seededState
  );

  assert.deepEqual([...changedState.changedTargets], ["a"]);
  assert.deepEqual([...changedState.downstreamTargets], []);
});

test("reconcileTargetInvalidationState() treats targets with cue = tar_cue(\"always\") as persistent invalidation sources", () => {
  const {
    reconcileTargetInvalidationState
  } = loadTargetHeatmapWithMockVscode();
  const text = [
    "list(",
    "  tar_target(a, 1),",
    "  tar_target(b, a + 1, cue = tar_cue(\"always\")),",
    "  tar_target(c, b + 1)",
    ")",
    ""
  ].join("\n");
  const meta = [
    "name|type|data|command|depend|seed|path|time|size|bytes|format|repository|iteration|parent|children|seconds|warnings|error",
    "a|stem||||||t1s|s1b|1|rds|local|vector|||0.1||",
    "b|stem||||||t1s|s1b|1|rds|local|vector|||0.1||",
    "c|stem||||||t1s|s1b|1|rds|local|vector|||0.1||"
  ].join("\n");
  const workspace = buildIndexFromText(text, meta);
  const state = reconcileTargetInvalidationState(
    workspace.index,
    (file) => workspace.readFile(file),
    null
  );

  assert.deepEqual([...state.changedTargets], ["b"]);
  assert.deepEqual([...state.downstreamTargets], ["c"]);
});

test("collectTargetHeatmapAssignments() marks changed targets on both definitions and references", () => {
  const { collectTargetHeatmapAssignments } = loadTargetHeatmapWithMockVscode();
  const { index, root } = buildIndex("direct");
  const assignments = collectTargetHeatmapAssignments(index, path.join(root, "_targets.R"), {
    enabled: false,
    metric: "size",
    minRuntimeSeconds: 1,
    minSizeBytes: 1024,
    notBuiltColor: "purple",
    palette: ["c1", "c2"],
    runtimeBreaksSeconds: [5, 30, 120],
    sizeBreaksBytes: [1000]
  }, {
    changedTargets: new Set(["a"]),
    downstreamTargets: new Set(["b"])
  }, {
    enabled: true,
    includeReferences: true
  });

  assert.equal(assignments.changed.length, 2);
  assert.deepEqual(assignments.changed.map((assignment) => assignment.targetName), ["a", "a"]);
  assert.equal(assignments.downstream.length, 1);
  assert.deepEqual(assignments.downstream.map((assignment) => assignment.targetName), ["b"]);
  assert.match(assignments.changed[0].hoverMessage, /changed since the last tracked build/);
  assert.match(assignments.downstream[0].hoverMessage, /may be invalidated by upstream code changes/);
});

test("collectTargetHeatmapAssignments() can keep invalidation markers on definitions only", () => {
  const { collectTargetHeatmapAssignments } = loadTargetHeatmapWithMockVscode();
  const { index, root } = buildIndex("direct");
  const assignments = collectTargetHeatmapAssignments(index, path.join(root, "_targets.R"), {
    enabled: false,
    metric: "size",
    minRuntimeSeconds: 1,
    minSizeBytes: 1024,
    notBuiltColor: "purple",
    palette: ["c1", "c2"],
    runtimeBreaksSeconds: [5, 30, 120],
    sizeBreaksBytes: [1000]
  }, {
    changedTargets: new Set(["a"]),
    downstreamTargets: new Set(["b"])
  }, {
    enabled: true,
    includeReferences: false
  });

  assert.equal(assignments.changed.length, 1);
  assert.equal(assignments.changed[0].targetName, "a");
  assert.equal(assignments.downstream.length, 1);
  assert.equal(assignments.downstream[0].targetName, "b");
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
  assert.match(errorCall.ranges[0].hoverMessage, /Last build recorded an error/);
  assert.match(warningCall.ranges[0].hoverMessage, /Last build recorded a warning/);
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
  assert.deepEqual(errorCall.ranges[0].range.start, errorCall.ranges[0].range.end);
  assert.deepEqual(warningCall.ranges[0].range.start, warningCall.ranges[0].range.end);
  assert.equal(errorCall.ranges[0].hoverMessage, undefined);
  assert.equal(warningCall.ranges[0].hoverMessage, undefined);
});

test("TargetHeatmapController can render invalidation icons for changed and downstream targets", async () => {
  const {
    TargetHeatmapController,
    createdDecorationTypes
  } = loadTargetHeatmapWithMockVscode({
    "targetHeatmap.enabled": false,
    "targetInvalidationDecorations.color": "#0055ff",
    "targetInvalidationDecorations.enabled": true,
    "targetStatusDecorations.enabled": false
  });
  const initialText = [
    "list(",
    "  tar_target(a, 1),",
    "  tar_target(b, a + 1)",
    ")",
    ""
  ].join("\n");
  const changedText = [
    "list(",
    "  tar_target(a, 2),",
    "  tar_target(b, a + 1)",
    ")",
    ""
  ].join("\n");
  const workspace = buildIndexFromText(initialText);
  const initial = buildIndexFromText(initialText, null, workspace.root);
  const changed = buildIndexFromText(changedText, null, workspace.root);
  let currentText = initialText;
  const calls = [];
  const editor = {
    document: {
      languageId: "r",
      uri: {
        fsPath: path.join(workspace.root, "_targets.R"),
        scheme: "file"
      }
    },
    setDecorations(decorationType, ranges) {
      calls.push({ decorationType, ranges });
    }
  };
  const controller = new TargetHeatmapController({
    getPipelineRootForUri() {
      return workspace.root;
    },
    async getIndexForUri() {
      return changed.index;
    },
    readFile() {
      return currentText;
    }
  });

  await controller.updateEditor(editor, initial.index);
  calls.length = 0;
  currentText = changedText;
  await controller.updateEditor(editor, changed.index);

  const changedDecorationType = createdDecorationTypes.find((decorationType) => (
    decorationType.options.before
    && decorationType.options.before.contentText === "\u25CF"
    && decorationType.options.before.color === "#0055ff"
  ));
  const downstreamDecorationType = createdDecorationTypes.find((decorationType) => (
    decorationType.options.before
    && decorationType.options.before.contentText === "\u25D0"
    && decorationType.options.before.color === "#0055ff"
  ));

  assert.ok(changedDecorationType);
  assert.ok(downstreamDecorationType);

  const changedCall = calls.find((call) => call.decorationType === changedDecorationType);
  const downstreamCall = calls.find((call) => call.decorationType === downstreamDecorationType);

  assert.equal(changedCall.ranges.length, 2);
  assert.equal(downstreamCall.ranges.length, 1);
  assert.equal(changedCall.ranges[0].hoverMessage, undefined);
  assert.equal(downstreamCall.ranges[0].hoverMessage, undefined);
});
