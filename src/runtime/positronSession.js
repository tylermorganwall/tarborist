"use strict";

const { tryAcquirePositronApi } = require("@posit-dev/positron");
const positronPackage = require("@posit-dev/positron/package.json");

const SUPPORTED_POSITRON_LINE = "2026.03.x";

function detectGlobalAcquirePositronApi() {
  return typeof globalThis !== "undefined" && typeof globalThis.acquirePositronApi === "function";
}

function collectPositronApiDiagnostics(positronApi, tryAcquireWorked) {
  return {
    hasAcquirePositronApiGlobal: detectGlobalAcquirePositronApi(),
    hasContext: Boolean(positronApi && positronApi.context),
    hasEphemeralState: Boolean(positronApi && positronApi.context && positronApi.context.ephemeralState),
    hasRuntime: Boolean(positronApi && positronApi.runtime),
    packageVersion: positronPackage.version,
    tryAcquireWorked: Boolean(tryAcquireWorked)
  };
}

function makeUnavailableError(diagnostics = collectPositronApiDiagnostics(null, false)) {
  const missing = [];
  if (!diagnostics.hasRuntime) {
    missing.push("runtime");
  }

  const error = new Error(
    "tarborist could not access the Positron runtime API. " +
    `This build targets Positron ${SUPPORTED_POSITRON_LINE} or newer with the runtime API available. ` +
    `Positron API package=${diagnostics.packageVersion}; ` +
    `acquirePositronApi global=${diagnostics.hasAcquirePositronApiGlobal}; ` +
    `tryAcquirePositronApi result=${diagnostics.tryAcquireWorked}; ` +
    `missing=${missing.length ? missing.join(", ") : "none"}. ` +
    "The tarborist_make() helper commands only work in Positron with an available R console session."
  );
  error.code = "POSITRON_API_UNAVAILABLE";
  error.diagnostics = diagnostics;
  return error;
}

function isRConsoleSession(session) {
  return Boolean(
    session &&
    session.runtimeMetadata &&
    session.runtimeMetadata.languageId === "r" &&
    session.metadata &&
    session.metadata.sessionMode === "console"
  );
}

function makeSessionError(message) {
  const error = new Error(message);
  error.code = "POSITRON_R_SESSION_UNAVAILABLE";
  return error;
}

function createPositronSessionAdapter(positronApi = undefined) {
  const resolvedApi = positronApi === undefined ? tryAcquirePositronApi() : positronApi;
  const diagnostics = collectPositronApiDiagnostics(resolvedApi, Boolean(resolvedApi));

  if (!resolvedApi || !resolvedApi.runtime) {
    throw makeUnavailableError(diagnostics);
  }

  async function resolvePreferredRuntime() {
    const runtime = await resolvedApi.runtime.getPreferredRuntime("r");
    if (!runtime) {
      throw makeSessionError("tarborist could not find a preferred Positron R runtime to start.");
    }

    return runtime;
  }

  return {
    getEphemeralState() {
      return resolvedApi.context && resolvedApi.context.ephemeralState
        ? resolvedApi.context.ephemeralState
        : null;
    },

    async ensureRConsoleSession(preferredSessionId) {
      if (preferredSessionId) {
        const existing = await resolvedApi.runtime.getSession(preferredSessionId);
        if (isRConsoleSession(existing)) {
          return existing;
        }
      }

      const foreground = await resolvedApi.runtime.getForegroundSession();
      if (isRConsoleSession(foreground)) {
        return foreground;
      }

      const preferredRuntime = await resolvePreferredRuntime();
      await resolvedApi.runtime.selectLanguageRuntime(preferredRuntime.runtimeId);

      const selectedForeground = await resolvedApi.runtime.getForegroundSession();
      if (isRConsoleSession(selectedForeground)) {
        return selectedForeground;
      }

      const activeSessions = await resolvedApi.runtime.getActiveSessions();
      const activeConsoleSession = activeSessions.find((session) => isRConsoleSession(session));
      if (activeConsoleSession) {
        if (typeof resolvedApi.runtime.focusSession === "function") {
          resolvedApi.runtime.focusSession(activeConsoleSession.metadata.sessionId);
        }
        return activeConsoleSession;
      }

      const startedSession = await resolvedApi.runtime.startLanguageRuntime(preferredRuntime.runtimeId, "R");
      if (isRConsoleSession(startedSession)) {
        return startedSession;
      }

      throw makeSessionError("tarborist could not acquire a foreground Positron R console session.");
    },

    async executeInSession(code, options = {}) {
      const session = await this.ensureRConsoleSession(options.sessionId);
      const sessionId = session.metadata.sessionId;

      await resolvedApi.runtime.executeCode(
        "r",
        code,
        options.focus !== false,
        true,
        undefined,
        undefined,
        undefined,
        sessionId,
        options.documentUri,
        {
          source: "extension",
          sourceId: "tarborist"
        }
      );

      return session;
    }
  };
}

module.exports = {
  collectPositronApiDiagnostics,
  createPositronSessionAdapter,
  isRConsoleSession,
  makeUnavailableError
};
