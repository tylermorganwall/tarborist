"use strict";

const assert = require("node:assert/strict");
const Module = require("module");
const test = require("node:test");

const { createSessionWorkspaceRegistry } = require("../../src/sessionWorkspaceRegistry");

function loadConsoleProviderWithMockVscode(activeFsPath = null) {
  const mockVscode = {
    Uri: {
      file(filePath) {
        return {
          fsPath: filePath
        };
      }
    },
    window: {
      activeTextEditor: activeFsPath
        ? {
          document: {
            uri: {
              fsPath: activeFsPath
            }
          }
        }
        : null
    }
  };

  const modulePath = require.resolve("../../src/console/consoleLinkProvider");
  delete require.cache[modulePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return mockVscode;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/console/consoleLinkProvider");
  } finally {
    Module._load = originalLoad;
  }
}

function createIndex(targets) {
  return {
    targets: new Map(targets.map((target) => [target.name, target]))
  };
}

test("console link provider resolves matches from the active editor pipeline root", () => {
  const workspaceRoot = "/tmp/project";
  const { TarboristConsoleLinkProvider } = loadConsoleProviderWithMockVscode(`${workspaceRoot}/_targets.R`);
  const sessionWorkspaceRegistry = createSessionWorkspaceRegistry();
  const target = {
    name: "alpha",
    file: `${workspaceRoot}/_targets.R`,
    generated: false,
    nameRange: {
      start: { character: 2, line: 9 }
    }
  };
  const indexManager = {
    indices: new Map([[workspaceRoot, createIndex([target])]]),
    getPipelineRootForUri() {
      return workspaceRoot;
    }
  };

  const provider = new TarboristConsoleLinkProvider(indexManager, sessionWorkspaceRegistry);
  const links = provider.provideConsoleLinks({
    languageId: "r",
    line: "dispatched target alpha",
    sessionId: "session-1"
  });

  assert.equal(links.length, 1);
  assert.equal(links[0].startIndex, 18);
  assert.equal(links[0].length, 5);
  assert.equal(links[0].target.fsPath, `${workspaceRoot}/_targets.R`);
  assert.equal(links[0].line, 10);
  assert.equal(links[0].column, 3);
  assert.equal(sessionWorkspaceRegistry.get("session-1"), workspaceRoot);
});

test("console link provider uses generator destinations for generated targets", () => {
  const workspaceRoot = "/tmp/project";
  const { TarboristConsoleLinkProvider } = loadConsoleProviderWithMockVscode();
  const sessionWorkspaceRegistry = createSessionWorkspaceRegistry();
  sessionWorkspaceRegistry.set("session-2", workspaceRoot);
  const generated = {
    name: "report_alpha",
    file: `${workspaceRoot}/_targets.R`,
    generated: true,
    generator: {
      file: `${workspaceRoot}/helpers.R`,
      range: {
        start: { character: 6, line: 12 }
      }
    },
    nameRange: {
      start: { character: 2, line: 20 }
    }
  };
  const indexManager = {
    indices: new Map([[workspaceRoot, createIndex([generated])]]),
    getPipelineRootForUri() {
      return workspaceRoot;
    }
  };

  const provider = new TarboristConsoleLinkProvider(indexManager, sessionWorkspaceRegistry);
  const links = provider.provideConsoleLinks({
    languageId: "r",
    line: "completed report_alpha",
    sessionId: "session-2"
  });

  assert.equal(links.length, 1);
  assert.equal(links[0].target.fsPath, `${workspaceRoot}/helpers.R`);
  assert.equal(links[0].line, 13);
  assert.equal(links[0].column, 7);
});

test("console link provider does not guess across multiple indexed pipelines without context", () => {
  const { TarboristConsoleLinkProvider } = loadConsoleProviderWithMockVscode();
  const sessionWorkspaceRegistry = createSessionWorkspaceRegistry();
  const indexManager = {
    indices: new Map([
      ["/tmp/project-a", createIndex([{ name: "alpha", file: "/tmp/project-a/_targets.R", generated: false, nameRange: { start: { character: 0, line: 0 } } }])],
      ["/tmp/project-b", createIndex([{ name: "alpha", file: "/tmp/project-b/_targets.R", generated: false, nameRange: { start: { character: 0, line: 0 } } }])]
    ]),
    getPipelineRootForUri() {
      return null;
    }
  };

  const provider = new TarboristConsoleLinkProvider(indexManager, sessionWorkspaceRegistry);
  const links = provider.provideConsoleLinks({
    languageId: "r",
    line: "alpha",
    sessionId: "session-3"
  });

  assert.deepEqual(links, []);
});

test("console link provider ignores non-R contexts and token substrings", () => {
  const workspaceRoot = "/tmp/project";
  const { TarboristConsoleLinkProvider } = loadConsoleProviderWithMockVscode(`${workspaceRoot}/_targets.R`);
  const sessionWorkspaceRegistry = createSessionWorkspaceRegistry();
  const indexManager = {
    indices: new Map([[workspaceRoot, createIndex([{ name: "a", file: `${workspaceRoot}/_targets.R`, generated: false, nameRange: { start: { character: 0, line: 0 } } }])]]),
    getPipelineRootForUri() {
      return workspaceRoot;
    }
  };

  const provider = new TarboristConsoleLinkProvider(indexManager, sessionWorkspaceRegistry);
  assert.deepEqual(provider.provideConsoleLinks({
    languageId: "python",
    line: "a",
    sessionId: "session-4"
  }), []);
  assert.deepEqual(provider.provideConsoleLinks({
    languageId: "r",
    line: "alpha",
    sessionId: "session-4"
  }), []);
});

test("console link provider uses the full available target universe when present", () => {
  const workspaceRoot = "/tmp/project";
  const { TarboristConsoleLinkProvider } = loadConsoleProviderWithMockVscode(`${workspaceRoot}/_targets.R`);
  const sessionWorkspaceRegistry = createSessionWorkspaceRegistry();
  const beta = {
    name: "beta",
    file: `${workspaceRoot}/_targets.R`,
    generated: false,
    nameRange: {
      start: { character: 4, line: 6 }
    }
  };
  const indexManager = {
    indices: new Map([[
      workspaceRoot,
      {
        completionTargets: new Map([["beta", beta]]),
        targets: new Map()
      }
    ]]),
    getPipelineRootForUri() {
      return workspaceRoot;
    }
  };

  const provider = new TarboristConsoleLinkProvider(indexManager, sessionWorkspaceRegistry);
  const links = provider.provideConsoleLinks({
    languageId: "r",
    line: "skipped beta",
    sessionId: "session-5"
  });

  assert.equal(links.length, 1);
  assert.equal(links[0].target.fsPath, `${workspaceRoot}/_targets.R`);
  assert.equal(links[0].line, 7);
  assert.equal(links[0].column, 5);
});
