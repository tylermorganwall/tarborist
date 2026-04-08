"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  collectPositronApiDiagnostics,
  createPositronSessionAdapter,
  isRConsoleSession,
  makeUnavailableError
} = require("../../src/runtime/positronSession");

function createSession(sessionId) {
  return {
    metadata: {
      sessionId,
      sessionMode: "console"
    },
    runtimeMetadata: {
      languageId: "r"
    }
  };
}

test("isRConsoleSession recognizes R console sessions", () => {
  assert.equal(isRConsoleSession(createSession("r-1")), true);
  assert.equal(isRConsoleSession({
    metadata: {
      sessionId: "python-1",
      sessionMode: "console"
    },
    runtimeMetadata: {
      languageId: "python"
    }
  }), false);
});

test("createPositronSessionAdapter fails clearly when the Positron API is unavailable", () => {
  assert.throws(
    () => createPositronSessionAdapter(null),
    (error) => (
      error.code === "POSITRON_API_UNAVAILABLE" &&
      /Positron runtime API/.test(error.message) &&
      /targets Positron 2026\.03\.x/.test(error.message) &&
      error.diagnostics &&
      typeof error.diagnostics.packageVersion === "string"
    )
  );
  assert.equal(makeUnavailableError().code, "POSITRON_API_UNAVAILABLE");
});

test("collectPositronApiDiagnostics reports missing runtime bridge details", () => {
  const diagnostics = collectPositronApiDiagnostics({
    context: {}
  }, false);

  assert.equal(typeof diagnostics.packageVersion, "string");
  assert.equal(diagnostics.tryAcquireWorked, false);
  assert.equal(diagnostics.hasRuntime, false);
  assert.equal(diagnostics.hasContext, true);
  assert.equal(diagnostics.hasEphemeralState, false);
  assert.equal(typeof diagnostics.hasAcquirePositronApiGlobal, "boolean");
});

test("adapter allows Positron runtime APIs without extension context state", () => {
  const adapter = createPositronSessionAdapter({
    runtime: {
      async executeCode() {
        return {};
      },
      async getActiveSessions() {
        return [];
      },
      async getForegroundSession() {
        return undefined;
      },
      async getPreferredRuntime() {
        return {
          runtimeId: "preferred-r"
        };
      },
      async getSession() {
        return undefined;
      },
      async selectLanguageRuntime() {},
      async startLanguageRuntime() {
        return createSession("r-2");
      }
    }
  });

  assert.equal(adapter.getEphemeralState(), null);
});

test("adapter reuses an existing R console session and executes code in it", async () => {
  const session = createSession("r-1");
  const executeCalls = [];
  const positronApi = {
    context: {
      ephemeralState: {
        get() {
          return undefined;
        },
        async update() {}
      }
    },
    runtime: {
      async executeCode(...args) {
        executeCalls.push(args);
        return {};
      },
      async getForegroundSession() {
        return undefined;
      },
      async getPreferredRuntime() {
        return {
          runtimeId: "preferred-r"
        };
      },
      async getSession(sessionId) {
        return sessionId === "r-1" ? session : undefined;
      },
      async selectLanguageRuntime() {
        throw new Error("should not reselect runtime when the preferred session exists");
      }
    }
  };
  const adapter = createPositronSessionAdapter(positronApi);
  const documentUri = {
    fsPath: "/project/_targets.R"
  };

  const resolved = await adapter.executeInSession("tarborist_make()", {
    documentUri,
    focus: false,
    sessionId: "r-1"
  });

  assert.equal(resolved, session);
  assert.deepEqual(adapter.getEphemeralState(), positronApi.context.ephemeralState);
  assert.equal(executeCalls.length, 1);
  assert.deepEqual(executeCalls[0], [
    "r",
    "tarborist_make()",
    false,
    true,
    undefined,
    undefined,
    undefined,
    "r-1",
    documentUri,
    {
      source: "extension",
      sourceId: "tarborist"
    }
  ]);
});

test("adapter starts or selects an R runtime when no console session exists", async () => {
  const startedSession = createSession("r-2");
  const events = [];
  const positronApi = {
    context: {
      ephemeralState: {
        get() {
          return undefined;
        },
        async update() {}
      }
    },
    runtime: {
      async executeCode() {
        return {};
      },
      async getActiveSessions() {
        events.push("getActiveSessions");
        return [];
      },
      async getForegroundSession() {
        events.push("getForegroundSession");
        return undefined;
      },
      async getPreferredRuntime(languageId) {
        events.push(`getPreferredRuntime:${languageId}`);
        return {
          runtimeId: "preferred-r"
        };
      },
      async getSession() {
        return undefined;
      },
      async selectLanguageRuntime(runtimeId) {
        events.push(`selectLanguageRuntime:${runtimeId}`);
      },
      async startLanguageRuntime(runtimeId, sessionName) {
        events.push(`startLanguageRuntime:${runtimeId}:${sessionName}`);
        return startedSession;
      }
    }
  };
  const adapter = createPositronSessionAdapter(positronApi);

  const session = await adapter.ensureRConsoleSession();

  assert.equal(session, startedSession);
  assert.deepEqual(events, [
    "getForegroundSession",
    "getPreferredRuntime:r",
    "selectLanguageRuntime:preferred-r",
    "getForegroundSession",
    "getActiveSessions",
    "startLanguageRuntime:preferred-r:R"
  ]);
});
