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

function makeTarget(name, filePath, startCharacter, endCharacter) {
  return {
    file: filePath,
    name,
    nameRange: makeRange(startCharacter, endCharacter)
  };
}

function createEditor(lineText, options = {}) {
  const selectionStart = options.selectionStart ?? options.cursor ?? 0;
  const selectionEnd = options.selectionEnd ?? options.cursor ?? selectionStart;
  const cursor = options.cursor ?? selectionEnd;
  const filePath = options.filePath || "/tmp/_targets.R";

  const document = {
    languageId: options.languageId || "r",
    uri: {
      fsPath: filePath
    },
    getText(range) {
      if (!range) {
        return lineText;
      }

      return lineText.slice(range.start.character, range.end.character);
    }
  };

  return {
    document,
    selection: {
      start: { line: 0, character: selectionStart },
      end: { line: 0, character: selectionEnd },
      active: { line: 0, character: cursor }
    }
  };
}

function createIndexManager(index) {
  return {
    async getIndexForUri() {
      return index;
    }
  };
}

function createIndex(options = {}) {
  return {
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
    commands: {
      async executeCommand(command, ...args) {
        executeCommandCalls.push({ args, command });
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
