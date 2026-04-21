"use strict";

const assert = require("node:assert/strict");
const Module = require("module");
const test = require("node:test");

function makeRange(startCharacter, endCharacter) {
  return {
    start: { line: 0, character: startCharacter },
    end: { line: 0, character: endCharacter }
  };
}

function makeLineRange(startLine, startCharacter, endLine, endCharacter) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter }
  };
}

function makeTarget(name, filePath, startCharacter, endCharacter) {
  return {
    file: filePath,
    name,
    nameRange: makeRange(startCharacter, endCharacter)
  };
}

function createEditor(lineText, options = {}) {
  const lines = lineText.split("\n");
  const positionToOffset = (position) => {
    let offset = 0;
    for (let line = 0; line < position.line; line += 1) {
      offset += lines[line].length + 1;
    }
    return offset + position.character;
  };
  const selectionStart = options.selectionStart ?? options.cursor ?? 0;
  const selectionEnd = options.selectionEnd ?? options.cursor ?? selectionStart;
  const cursor = options.cursor ?? selectionEnd;
  const filePath = options.filePath || "/tmp/_targets.R";
  const selection = {
    anchor: { line: 0, character: selectionStart },
    start: { line: 0, character: selectionStart },
    end: { line: 0, character: selectionEnd },
    active: { line: 0, character: cursor }
  };
  const visibleRange = options.visibleRange || makeRange(0, lineText.length);

  const document = {
    isDirty: Boolean(options.isDirty),
    languageId: options.languageId || "r",
    uri: {
      fsPath: filePath
    },
    getText(range) {
      if (!range) {
        return lineText;
      }
      return lineText.slice(positionToOffset(range.start), positionToOffset(range.end));
    },
    lineAt(line) {
      return {
        text: lines[line]
      };
    }
  };

  return {
    document,
    revealCalls: [],
    revealRange(range, revealType) {
      this.revealCalls.push({ range, revealType });
    },
    selection,
    selections: [selection],
    visibleRanges: options.visibleRanges || [visibleRange]
  };
}

function createIndexManager(index) {
  let currentIndex = index;

  return {
    getPipelineRootForUri(uri) {
      return uri && uri.fsPath ? uri.fsPath.replace(/\/_targets\.R$/i, "") : null;
    },
    async getIndexForUri() {
      return currentIndex;
    },
    async refreshWorkspace() {
      return currentIndex;
    },
    setIndex(nextIndex) {
      currentIndex = nextIndex;
    }
  };
}

function createIndex(options = {}) {
  return {
    completionRegions: options.completionRegions || [],
    completionRefs: options.completionRefs || [],
    completionTargets: options.completionTargets || new Map(),
    refs: options.refs || [],
    targets: options.targets || new Map()
  };
}

function loadExtensionWithMocks(options = {}) {
  const errorMessages = [];
  const executeCommandCalls = [];
  const registeredTextEditorCommands = [];
  const mockVscode = {
    Range: class Range {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    Selection: class Selection {
      constructor(anchorLine, anchorCharacter, activeLine, activeCharacter) {
        this.anchor = { line: anchorLine, character: anchorCharacter };
        this.active = { line: activeLine, character: activeCharacter };
        this.start = this.anchor.line < this.active.line || (this.anchor.line === this.active.line && this.anchor.character <= this.active.character)
          ? this.anchor
          : this.active;
        this.end = this.start === this.anchor ? this.active : this.anchor;
      }
    },
    TextEditorRevealType: {
      AtTop: "atTop",
      InCenterIfOutsideViewport: "inCenterIfOutsideViewport"
    },
    commands: {
      async executeCommand(command, ...args) {
        executeCommandCalls.push({ args, command });
        if (typeof options.executeCommandImpl === "function") {
          return options.executeCommandImpl(command, ...args);
        }
      },
      registerTextEditorCommand(command, handler) {
        const disposable = {
          dispose() {}
        };
        registeredTextEditorCommands.push({ command, disposable, handler });
        return disposable;
      }
    },
    window: {
      activeTextEditor: options.activeTextEditor || null,
      async showErrorMessage(message) {
        errorMessages.push(message);
      }
    }
  };

  const mockPositron = {
    RuntimeCodeExecutionMode: {
      Silent: "silent"
    },
    tryAcquirePositronApi() {
      return Object.prototype.hasOwnProperty.call(options, "positronApi")
        ? options.positronApi
        : null;
    }
  };

  const modulePath = require.resolve("../../src/extension");
  delete require.cache[modulePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return mockVscode;
    }

    if (request === "@posit-dev/positron") {
      return mockPositron;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return {
      ...require("../../src/extension"),
      errorMessages,
      executeCommandCalls,
      registeredTextEditorCommands
    };
  } finally {
    Module._load = originalLoad;
  }
}

test("getSelectedOrCurrentTarget() resolves a direct target definition name", async () => {
  const { getSelectedOrCurrentTarget } = loadExtensionWithMocks();
  const filePath = "/tmp/_targets.R";
  const editor = createEditor("tar_target(beta, 1)", {
    cursor: 11,
    filePath
  });
  const beta = makeTarget("beta", filePath, 11, 15);
  const indexManager = createIndexManager(createIndex({
    completionTargets: new Map([["beta", beta]]),
    targets: new Map([["beta", beta]])
  }));

  assert.equal(await getSelectedOrCurrentTarget(editor, indexManager), "beta");
});

test("getSelectedOrCurrentTarget() resolves a normal target reference", async () => {
  const { getSelectedOrCurrentTarget } = loadExtensionWithMocks();
  const filePath = "/tmp/_targets.R";
  const editor = createEditor("tar_target(beta, alpha + 1)", {
    cursor: 18,
    filePath
  });
  const alpha = makeTarget("alpha", filePath, 0, 5);
  const indexManager = createIndexManager(createIndex({
    completionRefs: [{
      enclosingTarget: "beta",
      file: filePath,
      range: makeRange(17, 22),
      synthetic: false,
      targetName: "alpha"
    }],
    completionTargets: new Map([["alpha", alpha]]),
    targets: new Map([["alpha", alpha]])
  }));

  assert.equal(await getSelectedOrCurrentTarget(editor, indexManager), "alpha");
});

test("getSelectedOrCurrentTarget() resolves disabled targets from the full target universe", async () => {
  const { getSelectedOrCurrentTarget } = loadExtensionWithMocks();
  const filePath = "/tmp/_targets.R";
  const editor = createEditor("tar_target(beta, 1)", {
    cursor: 11,
    filePath
  });
  const beta = makeTarget("beta", filePath, 11, 15);
  const indexManager = createIndexManager(createIndex({
    completionTargets: new Map([["beta", beta]]),
    targets: new Map()
  }));

  assert.equal(await getSelectedOrCurrentTarget(editor, indexManager), "beta");
});

test("getSelectedOrCurrentTarget() rejects selections that are not exactly one resolved target name", async () => {
  const { getSelectedOrCurrentTarget } = loadExtensionWithMocks();
  const filePath = "/tmp/_targets.R";
  const editor = createEditor("c(a, b)", {
    selectionStart: 0,
    selectionEnd: 7,
    filePath
  });
  const indexManager = createIndexManager(createIndex());

  assert.equal(await getSelectedOrCurrentTarget(editor, indexManager), undefined);
});

test("buildTarLoadCode() uses tar_load_raw() for a single target name", () => {
  const { buildTarLoadCode } = loadExtensionWithMocks();
  const code = buildTarLoadCode("my_target");

  assert.match(code, /targets::tar_load_raw\("my_target", envir = \.GlobalEnv\)/);
  assert.doesNotMatch(code, /tar_load\(/);
});

test("executeTarLoadHere() sends target loads to the Positron R runtime", async () => {
  const calls = [];
  const positronApi = {
    runtime: {
      async executeCode(languageId, code, focus, allowIncomplete, mode) {
        calls.push({ allowIncomplete, code, focus, languageId, mode });
      }
    }
  };
  const { buildTarLoadCode, executeTarLoadHere } = loadExtensionWithMocks({ positronApi });
  const filePath = "/tmp/_targets.R";
  const editor = createEditor("my_target", {
    cursor: 2,
    filePath
  });
  const myTarget = makeTarget("my_target", filePath, 0, 9);
  const indexManager = createIndexManager(createIndex({
    completionTargets: new Map([["my_target", myTarget]]),
    targets: new Map([["my_target", myTarget]])
  }));

  const succeeded = await executeTarLoadHere(editor, indexManager);

  assert.equal(succeeded, true);
  assert.deepEqual(calls, [{
    allowIncomplete: false,
    code: buildTarLoadCode("my_target"),
    focus: true,
    languageId: "r",
    mode: "silent"
  }]);
});

test("executeTarLoadHere() accepts an exact target-name selection", async () => {
  const calls = [];
  const positronApi = {
    runtime: {
      async executeCode(languageId, code, focus) {
        calls.push({ code, focus, languageId });
      }
    }
  };
  const { buildTarLoadCode, executeTarLoadHere } = loadExtensionWithMocks({ positronApi });
  const filePath = "/tmp/_targets.R";
  const editor = createEditor("my_target", {
    selectionStart: 0,
    selectionEnd: 9,
    filePath
  });
  const myTarget = makeTarget("my_target", filePath, 0, 9);
  const indexManager = createIndexManager(createIndex({
    completionTargets: new Map([["my_target", myTarget]]),
    targets: new Map([["my_target", myTarget]])
  }));

  await executeTarLoadHere(editor, indexManager);

  assert.deepEqual(calls, [{
    code: buildTarLoadCode("my_target"),
    focus: true,
    languageId: "r"
  }]);
});

test("executeTarLoadHere() reports invalid selections", async () => {
  const { errorMessages, executeTarLoadHere } = loadExtensionWithMocks({
    positronApi: {
      runtime: {
        async executeCode() {}
      }
    }
  });
  const editor = createEditor("c(a, b)", {
    selectionStart: 0,
    selectionEnd: 7,
    filePath: "/tmp/_targets.R"
  });
  const indexManager = createIndexManager(createIndex());

  const succeeded = await executeTarLoadHere(editor, indexManager);

  assert.equal(succeeded, false);
  assert.deepEqual(errorMessages, ["No valid target under the cursor or selection."]);
});

test("executeTarLoadHere() reports missing symbols", async () => {
  const { errorMessages, executeTarLoadHere } = loadExtensionWithMocks({
    positronApi: {
      runtime: {
        async executeCode() {}
      }
    }
  });
  const editor = createEditor("   ", {
    cursor: 1,
    filePath: "/tmp/_targets.R"
  });
  const indexManager = createIndexManager(createIndex());

  const succeeded = await executeTarLoadHere(editor, indexManager);

  assert.equal(succeeded, false);
  assert.deepEqual(errorMessages, ["No valid target under the cursor or selection."]);
});

test("executeTarLoadHere() reports non-R editors", async () => {
  const { errorMessages, executeTarLoadHere } = loadExtensionWithMocks({
    positronApi: {
      runtime: {
        async executeCode() {}
      }
    }
  });
  const editor = createEditor("my_target", {
    cursor: 2,
    filePath: "/tmp/_targets.R",
    languageId: "python"
  });
  const indexManager = createIndexManager(createIndex());

  const succeeded = await executeTarLoadHere(editor, indexManager);

  assert.equal(succeeded, false);
  assert.deepEqual(errorMessages, ["This command only works in R files."]);
});

test("executeTarLoadHere() reports missing Positron runtime access", async () => {
  const { errorMessages, executeTarLoadHere } = loadExtensionWithMocks({
    positronApi: null
  });
  const editor = createEditor("my_target", {
    cursor: 2,
    filePath: "/tmp/_targets.R"
  });
  const indexManager = createIndexManager(createIndex());

  const succeeded = await executeTarLoadHere(editor, indexManager);

  assert.equal(succeeded, false);
  assert.deepEqual(errorMessages, ["This command requires Positron."]);
});

test("updateTarLoadHereContext() enables the context key for valid target regions", async () => {
  const activeTextEditor = createEditor("my_target", {
    cursor: 2,
    filePath: "/tmp/_targets.R"
  });
  const { TAR_LOAD_HERE_CONTEXT_KEY, executeCommandCalls, updateTarLoadHereContext } = loadExtensionWithMocks({
    activeTextEditor
  });
  const myTarget = makeTarget("my_target", "/tmp/_targets.R", 0, 9);
  const indexManager = createIndexManager(createIndex({
    completionTargets: new Map([["my_target", myTarget]]),
    targets: new Map([["my_target", myTarget]])
  }));

  const enabled = await updateTarLoadHereContext(indexManager, activeTextEditor);

  assert.equal(enabled, true);
  assert.deepEqual(executeCommandCalls, [{
    args: [TAR_LOAD_HERE_CONTEXT_KEY, true],
    command: "setContext"
  }]);
});

test("updateTarLoadHereContext() clears the context key for invalid regions", async () => {
  const activeTextEditor = createEditor("not_a_target", {
    cursor: 2,
    filePath: "/tmp/_targets.R"
  });
  const { TAR_LOAD_HERE_CONTEXT_KEY, executeCommandCalls, updateTarLoadHereContext } = loadExtensionWithMocks({
    activeTextEditor
  });
  const indexManager = createIndexManager(createIndex());

  const enabled = await updateTarLoadHereContext(indexManager, activeTextEditor);

  assert.equal(enabled, false);
  assert.deepEqual(executeCommandCalls, [{
    args: [TAR_LOAD_HERE_CONTEXT_KEY, false],
    command: "setContext"
  }]);
});

test("registerTarLoadHereCommand() uses a text editor command registration", () => {
  const { registerTarLoadHereCommand, registeredTextEditorCommands } = loadExtensionWithMocks();
  const context = {
    subscriptions: []
  };

  const disposable = registerTarLoadHereCommand(context, createIndexManager(createIndex()));

  assert.equal(registeredTextEditorCommands.length, 1);
  assert.equal(registeredTextEditorCommands[0].command, "targetsTools.tarLoadHere");
  assert.equal(context.subscriptions[0], disposable);
});

test("updateExecuteInPlaceContext() enables the context key for valid completion regions", async () => {
  const activeTextEditor = createEditor("tar_target(beta, alpha + 1)", {
    cursor: 20,
    filePath: "/tmp/_targets.R"
  });
  const { EXECUTE_IN_PLACE_CONTEXT_KEY, executeCommandCalls, updateExecuteInPlaceContext } = loadExtensionWithMocks({
    activeTextEditor
  });
  const indexManager = createIndexManager(createIndex({
    completionRegions: [{
      file: "/tmp/_targets.R",
      range: makeRange(17, 26)
    }]
  }));

  const enabled = await updateExecuteInPlaceContext(indexManager, activeTextEditor);

  assert.equal(enabled, true);
  assert.deepEqual(executeCommandCalls, [{
    args: [EXECUTE_IN_PLACE_CONTEXT_KEY, true],
    command: "setContext"
  }]);
});

test("updateExecuteInPlaceContext() clears the context key outside valid completion regions", async () => {
  const activeTextEditor = createEditor("x <- 1", {
    cursor: 2,
    filePath: "/tmp/_targets.R"
  });
  const { EXECUTE_IN_PLACE_CONTEXT_KEY, executeCommandCalls, updateExecuteInPlaceContext } = loadExtensionWithMocks({
    activeTextEditor
  });
  const indexManager = createIndexManager(createIndex());

  const enabled = await updateExecuteInPlaceContext(indexManager, activeTextEditor);

  assert.equal(enabled, false);
  assert.deepEqual(executeCommandCalls, [{
    args: [EXECUTE_IN_PLACE_CONTEXT_KEY, false],
    command: "setContext"
  }]);
});

test("executeInPlace() runs the current selection and restores cursor and viewport", async () => {
  const editor = createEditor("alpha + beta", {
    selectionStart: 0,
    selectionEnd: 5,
    cursor: 5,
    filePath: "/tmp/_targets.R",
    visibleRange: makeRange(0, 12)
  });
  const { executeCommandCalls, executeInPlace } = loadExtensionWithMocks({
    positronApi: {},
    executeCommandImpl: async () => {}
  });
  const indexManager = createIndexManager(createIndex({
    completionRegions: [{
      file: "/tmp/_targets.R",
      range: makeRange(0, 12)
    }]
  }));

  const succeeded = await executeInPlace(editor, indexManager);

  assert.equal(succeeded, true);
  assert.deepEqual(executeCommandCalls, [{
    args: [{
      code: "alpha",
      focus: false,
      langId: "r"
    }],
    command: "workbench.action.executeCode.console"
  }]);
  assert.equal(editor.selection.start.character, 0);
  assert.equal(editor.selection.end.character, 5);
  assert.equal(editor.revealCalls[0].revealType, "atTop");
});

test("executeInPlace() runs the exact unbraced completion region and moves to the region end", async () => {
  const editor = createEditor("alpha + beta, tail", {
    cursor: 8,
    filePath: "/tmp/_targets.R",
    visibleRange: makeRange(0, 18)
  });
  editor.selection = {
    anchor: { line: 0, character: 8 },
    active: { line: 0, character: 8 },
    start: { line: 0, character: 8 },
    end: { line: 0, character: 8 }
  };
  editor.selections = [editor.selection];
  const { executeCommandCalls, executeInPlace } = loadExtensionWithMocks({
    positronApi: {},
    executeCommandImpl: async () => {}
  });
  const indexManager = createIndexManager(createIndex({
    completionRegions: [{
      file: "/tmp/_targets.R",
      range: makeRange(0, 12)
    }]
  }));

  const succeeded = await executeInPlace(editor, indexManager);

  assert.equal(succeeded, true);
  assert.deepEqual(executeCommandCalls, [{
    args: [{
      code: "alpha + beta",
      focus: false,
      langId: "r"
    }],
    command: "workbench.action.executeCode.console"
  }]);
  assert.equal(editor.selection.active.line, 0);
  assert.equal(editor.selection.active.character, 12);
  assert.equal(editor.revealCalls[0].revealType, "inCenterIfOutsideViewport");
});

test("executeInPlace() uses Positron's current-statement execution for braced regions and moves to the region end", async () => {
  const editor = createEditor("{\nalpha + beta\n}", {
    cursor: 8,
    filePath: "/tmp/_targets.R",
    visibleRange: makeLineRange(0, 0, 2, 1)
  });
  editor.selection = {
    anchor: { line: 0, character: 0 },
    active: { line: 0, character: 0 },
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 }
  };
  editor.selections = [editor.selection];
  const { executeCommandCalls, executeInPlace } = loadExtensionWithMocks({
    positronApi: {},
    executeCommandImpl: async () => {}
  });
  const indexManager = createIndexManager(createIndex({
    completionRegions: [{
      file: "/tmp/_targets.R",
      range: makeLineRange(0, 0, 2, 1)
    }]
  }));

  const succeeded = await executeInPlace(editor, indexManager);

  assert.equal(succeeded, true);
  assert.deepEqual(executeCommandCalls, [{
    args: [],
    command: "workbench.action.positronConsole.executeCodeWithoutAdvancing"
  }]);
  assert.equal(editor.selection.active.line, 2);
  assert.equal(editor.selection.active.character, 1);
  assert.equal(editor.revealCalls[0].revealType, "inCenterIfOutsideViewport");
});

test("executeInPlace() skips an empty blank line so the cursor stays indented", async () => {
  const source = [
    "{",
    "  #I have some text here",
    "  ggplot2::ggplot(mtcars) +",
    "    ggplot2::aes(x = mpg, y = cyl) + ",
    "    ggplot2::geom_line()",
    "",
    "  #Whoa",
    "  lm(mpg ~ cyl, data = mtcars)",
    "}"
  ].join("\n");
  const cursorLine = 3;
  const cursorCharacter = source.split("\n")[cursorLine].length;
  const expectedLine = 6;
  const expectedCharacter = 2;
  const editor = createEditor(source, {
    filePath: "/tmp/_targets.R",
    visibleRange: makeLineRange(0, 0, 8, 1)
  });
  editor.selection = {
    anchor: { line: cursorLine, character: cursorCharacter },
    active: { line: cursorLine, character: cursorCharacter },
    start: { line: cursorLine, character: cursorCharacter },
    end: { line: cursorLine, character: cursorCharacter }
  };
  editor.selections = [editor.selection];
  const { executeCommandCalls, executeInPlace } = loadExtensionWithMocks({
    positronApi: {},
    executeCommandImpl: async () => {}
  });
  const indexManager = createIndexManager(createIndex({
    completionRegions: [{
      file: "/tmp/_targets.R",
      range: makeLineRange(0, 0, 8, 1)
    }]
  }));

  const succeeded = await executeInPlace(editor, indexManager);

  assert.equal(succeeded, true);
  assert.deepEqual(executeCommandCalls, [{
    args: [],
    command: "workbench.action.positronConsole.executeCodeWithoutAdvancing"
  }]);
  assert.equal(editor.selection.active.line, expectedLine);
  assert.equal(editor.selection.active.character, expectedCharacter);
  assert.equal(editor.revealCalls[0].revealType, "inCenterIfOutsideViewport");
});

test("executeInPlace() moves to the next statement when no blank line follows the current expression", async () => {
  const source = [
    "{",
    "  ggplot2::ggplot(mtcars) +",
    "    ggplot2::aes(x = mpg, y = cyl) + ",
    "    ggplot2::geom_line()",
    "  lm(mpg ~ cyl, data = mtcars)",
    "}"
  ].join("\n");
  const cursorLine = 2;
  const cursorCharacter = source.split("\n")[cursorLine].length;
  const expectedLine = 4;
  const expectedCharacter = 2;
  const editor = createEditor(source, {
    filePath: "/tmp/_targets.R",
    visibleRange: makeLineRange(0, 0, 5, 1)
  });
  editor.selection = {
    anchor: { line: cursorLine, character: cursorCharacter },
    active: { line: cursorLine, character: cursorCharacter },
    start: { line: cursorLine, character: cursorCharacter },
    end: { line: cursorLine, character: cursorCharacter }
  };
  editor.selections = [editor.selection];
  const { executeCommandCalls, executeInPlace } = loadExtensionWithMocks({
    positronApi: {},
    executeCommandImpl: async () => {}
  });
  const indexManager = createIndexManager(createIndex({
    completionRegions: [{
      file: "/tmp/_targets.R",
      range: makeLineRange(0, 0, 5, 1)
    }]
  }));

  const succeeded = await executeInPlace(editor, indexManager);

  assert.equal(succeeded, true);
  assert.deepEqual(executeCommandCalls, [{
    args: [],
    command: "workbench.action.positronConsole.executeCodeWithoutAdvancing"
  }]);
  assert.equal(editor.selection.active.line, expectedLine);
  assert.equal(editor.selection.active.character, expectedCharacter);
  assert.equal(editor.revealCalls[0].revealType, "inCenterIfOutsideViewport");
});

test("executeInPlace() refreshes dirty documents before resolving the execution region", async () => {
  const editor = createEditor("engineer_features(raw_medium, sleep = 0.9)", {
    cursor: 10,
    filePath: "/tmp/_targets.R",
    isDirty: true,
    visibleRange: makeRange(0, 42)
  });
  editor.selection = {
    anchor: { line: 0, character: 10 },
    active: { line: 0, character: 10 },
    start: { line: 0, character: 10 },
    end: { line: 0, character: 10 }
  };
  editor.selections = [editor.selection];
  const { executeCommandCalls, executeInPlace } = loadExtensionWithMocks({
    positronApi: {},
    executeCommandImpl: async () => {}
  });
  const staleIndex = createIndex();
  const freshIndex = createIndex({
    completionRegions: [{
      file: "/tmp/_targets.R",
      range: makeRange(0, 42)
    }]
  });
  const indexManager = createIndexManager(staleIndex);
  let refreshes = 0;
  indexManager.refreshWorkspace = async () => {
    refreshes += 1;
    indexManager.setIndex(freshIndex);
    return freshIndex;
  };

  const succeeded = await executeInPlace(editor, indexManager);

  assert.equal(succeeded, true);
  assert.equal(refreshes, 1);
  assert.deepEqual(executeCommandCalls, [{
    args: [{
      code: "engineer_features(raw_medium, sleep = 0.9)",
      focus: false,
      langId: "r"
    }],
    command: "workbench.action.executeCode.console"
  }]);
});

test("executeInPlace() falls back to Positron's default execution outside valid target regions", async () => {
  const editor = createEditor("x <- 1", {
    cursor: 2,
    filePath: "/tmp/_targets.R"
  });
  const { errorMessages, executeCommandCalls, executeInPlace } = loadExtensionWithMocks({
    positronApi: {},
    executeCommandImpl: async () => {}
  });
  const indexManager = createIndexManager(createIndex());

  const succeeded = await executeInPlace(editor, indexManager);

  assert.equal(succeeded, true);
  assert.deepEqual(executeCommandCalls, [{
    args: [],
    command: "workbench.action.positronConsole.executeCode"
  }]);
  assert.deepEqual(errorMessages, []);
});

test("registerExecuteInPlaceCommand() uses a text editor command registration", () => {
  const { registerExecuteInPlaceCommand, registeredTextEditorCommands } = loadExtensionWithMocks();
  const context = {
    subscriptions: []
  };

  const disposable = registerExecuteInPlaceCommand(context, createIndexManager(createIndex()));

  assert.equal(registeredTextEditorCommands.length, 1);
  assert.equal(registeredTextEditorCommands[0].command, "targetsTools.executeInPlace");
  assert.equal(context.subscriptions[0], disposable);
});
