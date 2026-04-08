"use strict";

const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const test = require("node:test");

const { createTarboristMakeController, STATE_KEY } = require("../../src/tarboristMakeCommands");
const { normalizeFile } = require("../../src/util/paths");

function createEphemeralState() {
  const values = new Map();
  return {
    get(key) {
      return values.get(key);
    },
    async update(key, value) {
      values.set(key, value);
    }
  };
}

function createIndex() {
  return {
    targets: new Map([
      ["alpha", {
        file: "/project/_targets.R",
        name: "alpha",
        nameRange: {
          start: { character: 2, line: 2 }
        }
      }]
    ])
  };
}

function createIndexManager(root, index) {
  return {
    async refreshWorkspace() {},
    getPipelineRootForUri() {
      return null;
    },
    indices: new Map([[normalizeFile(root), index]])
  };
}

function listTrackedManifestDirs(ephemeralState) {
  const state = ephemeralState.get(STATE_KEY);
  if (!state || !state.sessions) {
    return [];
  }

  return Object.values(state.sessions)
    .flatMap((workspaces) => Object.values(workspaces))
    .map((entry) => entry.dir);
}

async function cleanupTrackedDirs(ephemeralState) {
  await Promise.all(listTrackedManifestDirs(ephemeralState).map((dir) => fs.rm(dir, {
    force: true,
    recursive: true
  })));
}

test("installTarboristMake installs the helper and sets a fresh manifest in the chosen session", async () => {
  const workspaceRoot = path.resolve(__dirname, "..", "fixtures", "direct");
  const ephemeralState = createEphemeralState();
  const executions = [];
  const adapter = {
    async ensureRConsoleSession(preferredSessionId) {
      assert.equal(preferredSessionId, undefined);
      return {
        metadata: {
          sessionId: "session-1"
        }
      };
    },
    async executeInSession(code, options) {
      executions.push({ code, options });
    },
    getEphemeralState() {
      return ephemeralState;
    }
  };
  const controller = createTarboristMakeController({
    extensionPath: "/extension",
    indexManager: createIndexManager(workspaceRoot, createIndex()),
    stateStore: ephemeralState,
    sessionAdapterFactory() {
      return adapter;
    }
  });

  try {
    const installation = await controller.installTarboristMake({
      activeDocumentUri: null,
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
    });

    assert.equal(installation.sessionId, "session-1");
    assert.equal(executions.length, 1);
    assert.match(executions[0].code, /source\("\/extension\/r\/tarborist_make\.R", local = \.GlobalEnv\)/);
    assert.match(executions[0].code, /tarborist_set_manifest\(".*targets-manifest\.tsv"\)/);
    assert.equal(executions[0].options.sessionId, "session-1");
    assert.equal(executions[0].options.focus, true);

    const state = ephemeralState.get(STATE_KEY);
    assert.ok(state.sessions["session-1"][normalizeFile(workspaceRoot)].manifestPath.endsWith("targets-manifest.tsv"));
    assert.equal(await fs.readFile(installation.manifestPath, "utf8"), "name\tfile\tline\tcolumn\nalpha\t/project/_targets.R\t3\t3\n");
  } finally {
    await cleanupTrackedDirs(ephemeralState);
  }
});

test("updateTarboristManifest refreshes the manifest without re-sourcing the helper and cleans the previous temp dir", async () => {
  const workspaceRoot = path.resolve(__dirname, "..", "fixtures", "direct");
  const ephemeralState = createEphemeralState();
  const executions = [];
  const adapter = {
    async ensureRConsoleSession(preferredSessionId) {
      return {
        metadata: {
          sessionId: preferredSessionId || "session-1"
        }
      };
    },
    async executeInSession(code, options) {
      executions.push({ code, options });
    },
    getEphemeralState() {
      return ephemeralState;
    }
  };
  const controller = createTarboristMakeController({
    extensionPath: "/extension",
    indexManager: createIndexManager(workspaceRoot, createIndex()),
    stateStore: ephemeralState,
    sessionAdapterFactory() {
      return adapter;
    }
  });

  try {
    const first = await controller.installTarboristMake({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
    });
    const oldDir = path.dirname(first.manifestPath);
    const updated = await controller.updateTarboristManifest({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
    });

    assert.equal(executions.length, 2);
    assert.match(executions[1].code, /^tarborist_set_manifest\(".*targets-manifest\.tsv"\)$/);
    assert.doesNotMatch(executions[1].code, /source\(/);
    assert.equal(executions[1].options.focus, false);
    assert.notEqual(updated.manifestPath, first.manifestPath);
    await assert.rejects(() => fs.access(oldDir));
    await fs.access(path.dirname(updated.manifestPath));
  } finally {
    await cleanupTrackedDirs(ephemeralState);
  }
});

test("runTarboristMake installs the helper and then invokes tarborist_make()", async () => {
  const workspaceRoot = path.resolve(__dirname, "..", "fixtures", "direct");
  const ephemeralState = createEphemeralState();
  const executions = [];
  const adapter = {
    async ensureRConsoleSession(preferredSessionId) {
      return {
        metadata: {
          sessionId: preferredSessionId || "session-1"
        }
      };
    },
    async executeInSession(code, options) {
      executions.push({ code, options });
    },
    getEphemeralState() {
      return ephemeralState;
    }
  };
  const controller = createTarboristMakeController({
    extensionPath: "/extension",
    indexManager: createIndexManager(workspaceRoot, createIndex()),
    stateStore: ephemeralState,
    sessionAdapterFactory() {
      return adapter;
    }
  });

  try {
    const installation = await controller.runTarboristMake({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
    });

    assert.equal(installation.sessionId, "session-1");
    assert.equal(executions.length, 2);
    assert.match(executions[0].code, /source\("/);
    assert.equal(executions[1].code, "tarborist_make()");
    assert.equal(executions[1].options.focus, true);
  } finally {
    await cleanupTrackedDirs(ephemeralState);
  }
});

test("installTarboristMake surfaces a clear session-adapter failure", async () => {
  const workspaceRoot = path.resolve(__dirname, "..", "fixtures", "direct");
  const controller = createTarboristMakeController({
    extensionPath: "/extension",
    indexManager: createIndexManager(workspaceRoot, createIndex()),
    stateStore: createEphemeralState(),
    sessionAdapterFactory() {
      throw new Error("Positron runtime unavailable");
    }
  });

  await assert.rejects(
    () => controller.installTarboristMake({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
    }),
    /Positron runtime unavailable/
  );
});

test("hasTrackedManifest reports whether a workspace already has an installed manifest", async () => {
  const workspaceRoot = path.resolve(__dirname, "..", "fixtures", "direct");
  const ephemeralState = createEphemeralState();
  const controller = createTarboristMakeController({
    extensionPath: "/extension",
    indexManager: createIndexManager(workspaceRoot, createIndex()),
    stateStore: ephemeralState,
    sessionAdapterFactory() {
      return {
        async ensureRConsoleSession() {
          return {
            metadata: {
              sessionId: "session-1"
            }
          };
        },
        async executeInSession() {},
        getEphemeralState() {
          return ephemeralState;
        }
      };
    }
  });

  try {
    assert.equal(controller.hasTrackedManifest({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
    }), false);

    await controller.installTarboristMake({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
    });

    assert.equal(controller.hasTrackedManifest({
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
    }), true);
  } finally {
    await cleanupTrackedDirs(ephemeralState);
  }
});

test("updateTarboristManifest can skip when no helper has been installed for the workspace", async () => {
  const workspaceRoot = path.resolve(__dirname, "..", "fixtures", "direct");
  const ephemeralState = createEphemeralState();
  let ensured = false;
  const controller = createTarboristMakeController({
    extensionPath: "/extension",
    indexManager: createIndexManager(workspaceRoot, createIndex()),
    stateStore: ephemeralState,
    sessionAdapterFactory() {
      return {
        async ensureRConsoleSession() {
          ensured = true;
          return {
            metadata: {
              sessionId: "session-1"
            }
          };
        },
        async executeInSession() {},
        getEphemeralState() {
          return ephemeralState;
        }
      };
    }
  });

  const result = await controller.updateTarboristManifest({
    skipIfNotInstalled: true,
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
  });

  assert.equal(result, null);
  assert.equal(ensured, false);
});
