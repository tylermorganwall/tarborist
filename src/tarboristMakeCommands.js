"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const { createPositronSessionAdapter } = require("./runtime/positronSession");
const {
  buildManifestUpdateCode,
  buildTarboristBootstrap,
  writeTarboristManifest
} = require("./tarboristMake");
const { normalizeFile } = require("./util/paths");

const STATE_KEY = "tarborist.make.v1";

function emptyManifestState() {
  return {
    sessions: {}
  };
}

function getManifestState(memento) {
  const state = memento.get(STATE_KEY);
  if (!state || typeof state !== "object" || typeof state.sessions !== "object") {
    return emptyManifestState();
  }

  return state;
}

async function setManifestState(memento, state) {
  await memento.update(STATE_KEY, state);
}

function findTrackedWorkspace(state, workspaceRoot) {
  for (const [sessionId, workspaces] of Object.entries(state.sessions || {})) {
    if (workspaces && Object.prototype.hasOwnProperty.call(workspaces, workspaceRoot)) {
      return {
        entry: workspaces[workspaceRoot],
        sessionId
      };
    }
  }

  return null;
}

async function removeTrackedWorkspace(state, workspaceRoot) {
  const tracked = findTrackedWorkspace(state, workspaceRoot);
  if (!tracked) {
    return null;
  }

  delete state.sessions[tracked.sessionId][workspaceRoot];
  if (!Object.keys(state.sessions[tracked.sessionId]).length) {
    delete state.sessions[tracked.sessionId];
  }

  return tracked;
}

async function cleanupManifestDir(dir) {
  if (!dir) {
    return;
  }

  await fsp.rm(dir, {
    force: true,
    recursive: true
  });
}

function findTopLevelTargetsRoot(workspaceFolders = []) {
  for (const folder of workspaceFolders) {
    const candidate = path.join(folder.uri.fsPath, "_targets.R");
    if (fs.existsSync(candidate)) {
      return folder.uri.fsPath;
    }
  }

  return null;
}

function resolvePipelineRoot(indexManager, options = {}) {
  const activeUri = options.activeDocumentUri || null;
  const pipelineRoot = activeUri ? indexManager.getPipelineRootForUri(activeUri) : null;
  return pipelineRoot || findTopLevelTargetsRoot(options.workspaceFolders || []);
}

async function getFreshIndex(indexManager, workspaceRoot) {
  await indexManager.refreshWorkspace(workspaceRoot);
  const index = indexManager.indices.get(normalizeFile(workspaceRoot));
  if (!index) {
    throw new Error(`tarborist could not build an index for ${workspaceRoot}.`);
  }

  return index;
}

function getHelperPath(extensionPath) {
  return path.join(extensionPath, "r", "tarborist_make.R");
}

function getStateStore(providedStateStore, adapter) {
  if (providedStateStore && typeof providedStateStore.get === "function" && typeof providedStateStore.update === "function") {
    return providedStateStore;
  }

  if (adapter && typeof adapter.getEphemeralState === "function") {
    const ephemeralState = adapter.getEphemeralState();
    if (ephemeralState && typeof ephemeralState.get === "function" && typeof ephemeralState.update === "function") {
      return ephemeralState;
    }
  }

  throw new Error("tarborist could not access extension state for tarborist_make() manifest tracking.");
}

async function writeTrackedManifest(index, workspaceRoot, sessionId, ephemeralState, log) {
  const normalizedRoot = normalizeFile(workspaceRoot);
  const state = getManifestState(ephemeralState);
  const previous = await removeTrackedWorkspace(state, normalizedRoot);
  const next = await writeTarboristManifest(index);

  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {};
  }

  state.sessions[sessionId][normalizedRoot] = {
    dir: next.dir,
    manifestPath: next.manifestPath
  };
  await setManifestState(ephemeralState, state);

  if (previous && previous.entry && previous.entry.dir && previous.entry.dir !== next.dir) {
    try {
      await cleanupManifestDir(previous.entry.dir);
    } catch (error) {
      if (log) {
        log(`Failed to clean previous tarborist manifest dir ${previous.entry.dir}: ${error.message || error}`);
      }
    }
  }

  return next;
}

function createTarboristMakeController({
  extensionPath,
  indexManager,
  outputChannel,
  sessionAdapterFactory = createPositronSessionAdapter,
  stateStore = null
}) {
  const log = (message) => {
    if (outputChannel) {
      outputChannel.appendLine(message);
    }
  };

  function getTrackedWorkspaceEntry(workspaceRoot, manifestStateStore) {
    if (!workspaceRoot) {
      return null;
    }

    return findTrackedWorkspace(getManifestState(manifestStateStore), normalizeFile(workspaceRoot));
  }

  async function installTarboristMake(options = {}) {
    const workspaceRoot = resolvePipelineRoot(indexManager, options);
    if (!workspaceRoot) {
      throw new Error("tarborist could not find a nearby _targets.R for tarborist_make().");
    }

    const adapter = sessionAdapterFactory();
    const manifestStateStore = getStateStore(stateStore, adapter);
    const previous = findTrackedWorkspace(getManifestState(manifestStateStore), normalizeFile(workspaceRoot));
    const session = await adapter.ensureRConsoleSession(previous && previous.sessionId ? previous.sessionId : undefined);
    const index = await getFreshIndex(indexManager, workspaceRoot);
    const manifest = await writeTrackedManifest(index, workspaceRoot, session.metadata.sessionId, manifestStateStore, log);
    const helperPath = getHelperPath(extensionPath);
    const bootstrap = buildTarboristBootstrap(helperPath, manifest.manifestPath);

    await adapter.executeInSession(bootstrap, {
      documentUri: options.activeDocumentUri,
      focus: true,
      sessionId: session.metadata.sessionId
    });

    log(`Installed tarborist_make() for ${workspaceRoot} in session ${session.metadata.sessionId}.`);
    return {
      manifestPath: manifest.manifestPath,
      sessionId: session.metadata.sessionId,
      workspaceRoot
    };
  }

  async function updateTarboristManifest(options = {}) {
    const workspaceRoot = resolvePipelineRoot(indexManager, options);
    if (!workspaceRoot) {
      throw new Error("tarborist could not find a nearby _targets.R for tarborist_make().");
    }

    const adapter = sessionAdapterFactory();
    const manifestStateStore = getStateStore(stateStore, adapter);
    const previous = getTrackedWorkspaceEntry(workspaceRoot, manifestStateStore);
    if (options.skipIfNotInstalled && !previous) {
      return null;
    }
    const session = await adapter.ensureRConsoleSession(previous && previous.sessionId ? previous.sessionId : undefined);
    const index = await getFreshIndex(indexManager, workspaceRoot);
    const manifest = await writeTrackedManifest(index, workspaceRoot, session.metadata.sessionId, manifestStateStore, log);

    await adapter.executeInSession(buildManifestUpdateCode(manifest.manifestPath), {
      documentUri: options.activeDocumentUri,
      focus: false,
      sessionId: session.metadata.sessionId
    });

    if (!options.quiet) {
      log(`Updated tarborist manifest for ${workspaceRoot} in session ${session.metadata.sessionId}.`);
    }
    return {
      manifestPath: manifest.manifestPath,
      sessionId: session.metadata.sessionId,
      workspaceRoot
    };
  }

  async function runTarboristMake(options = {}) {
    const installation = await installTarboristMake(options);
    const adapter = sessionAdapterFactory();
    await adapter.executeInSession("tarborist_make()", {
      documentUri: options.activeDocumentUri,
      focus: true,
      sessionId: installation.sessionId
    });
    log(`Ran tarborist_make() in session ${installation.sessionId}.`);
    return installation;
  }

  return {
    hasTrackedManifest(options = {}) {
      const workspaceRoot = resolvePipelineRoot(indexManager, options);
      if (!workspaceRoot) {
        return false;
      }

      const manifestStateStore = getStateStore(stateStore, null);
      return Boolean(getTrackedWorkspaceEntry(workspaceRoot, manifestStateStore));
    },
    installTarboristMake,
    runTarboristMake,
    updateTarboristManifest
  };
}

module.exports = {
  STATE_KEY,
  createTarboristMakeController,
  emptyManifestState,
  findTopLevelTargetsRoot,
  getManifestState,
  resolvePipelineRoot
};
