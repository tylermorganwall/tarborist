"use strict";

const { normalizeFile } = require("./util/paths");

function createSessionWorkspaceRegistry() {
  const sessionRoots = new Map();

  return {
    clear() {
      sessionRoots.clear();
    },

    delete(sessionId) {
      if (!sessionId) {
        return;
      }

      sessionRoots.delete(sessionId);
    },

    entries() {
      return [...sessionRoots.entries()];
    },

    get(sessionId) {
      if (!sessionId) {
        return null;
      }

      return sessionRoots.get(sessionId) || null;
    },

    set(sessionId, workspaceRoot) {
      if (!sessionId || !workspaceRoot) {
        return;
      }

      sessionRoots.set(sessionId, normalizeFile(workspaceRoot));
    }
  };
}

module.exports = {
  createSessionWorkspaceRegistry
};
