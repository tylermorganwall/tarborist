"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const parser = require("../../src/parser/treeSitter");
const { isPathInside } = require("../../src/util/paths");

const uri = (file) => ({ scheme: "file", fsPath: file });

function workspace(t, parserOverride = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarborist-lifecycle-"));
  const events = {};
  const diagnostics = new Map();
  const watchers = [];
  const messages = [];
  const logs = [];
  const subscriptions = [];
  const mock = {
    EventEmitter: class {
      constructor() {
        this.listeners = new Set();
        this.event = (callback) => {
          this.listeners.add(callback);
          return { dispose: () => this.listeners.delete(callback) };
        };
      }
      fire(value) { for (const callback of this.listeners) { callback(value); } }
      dispose() { this.listeners.clear(); }
    },
    Uri: { file: uri },
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    languages: {
      createDiagnosticCollection: () => ({
        delete: (file) => diagnostics.delete(file.fsPath),
        set: (file, values) => diagnostics.set(file.fsPath, values),
        dispose: () => diagnostics.clear()
      })
    },
    window: { showErrorMessage: (message) => messages.push(message) },
    workspace: {
      textDocuments: [],
      workspaceFolders: [{ uri: uri(root) }],
      getWorkspaceFolder(file) {
        assert.equal(file.scheme, "file", "VS Code receives a URI, not a document");
        return this.workspaceFolders.find((folder) => isPathInside(file.fsPath, folder.uri.fsPath));
      },
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      createFileSystemWatcher(pattern) {
        const watcher = {
          pattern,
          disposed: false,
          onDidChange(callback) { this.change = callback; },
          onDidCreate(callback) { this.create = callback; },
          onDidDelete(callback) { this.remove = callback; },
          dispose() { this.disposed = true; }
        };
        watchers.push(watcher);
        return watcher;
      }
    }
  };
  for (const name of ["onDidSaveTextDocument", "onDidOpenTextDocument", "onDidCloseTextDocument", "onDidChangeWorkspaceFolders", "onDidChangeConfiguration"]) {
    mock.workspace[name] = (callback) => {
      events[name] = callback;
      return { dispose() {} };
    };
  }
  const filename = require.resolve("../../src/index/workspaceIndex");
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  const localRequire = Module.createRequire(filename);
  instance.require = (name) => {
    if (name === "vscode") { return mock; }
    if (name === "../parser/treeSitter") { return { ...parser, ...parserOverride }; }
    if (name === "../util/vscode") { return { toVsCodeDiagnostic: (value) => value }; }
    return localRequire(name);
  };
  instance._compile(fs.readFileSync(filename, "utf8"), filename);
  const manager = new instance.exports.WorkspaceIndexManager({ appendLine: (line) => logs.push(line), dispose() {} });
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  t.after(() => {
    manager.dispose();
    for (const item of subscriptions) { item.dispose?.(); }
    fs.rmSync(root, { force: true, recursive: true });
  });
  return { root, manager, mock, events, diagnostics, watchers, logs, messages, write, context: { subscriptions } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test.before(() => parser.ensureParserReady());

test("document saves schedule a refresh using the document URI", async (t) => {
  const w = workspace(t);
  const file = w.write("_targets.R", "list(tar_target(alpha, 1))");
  await w.manager.activate(w.context);
  w.events.onDidSaveTextDocument({ uri: uri(file), getText: () => "list(tar_target(beta, 2))" });
  assert.ok(w.manager.pendingRefreshes.has(w.root));
  assert.ok(w.manager.dirtyRoots.has(w.root));
});

test("manual refresh includes cached and newly discovered nested roots", async (t) => {
  const w = workspace(t);
  const file = w.write("nested/_targets.R", "list(tar_target(alpha, 1))");
  const nested = path.dirname(file);
  await w.manager.getIndexForUri(uri(file));
  w.write("nested/_targets.R", "list(tar_target(beta, 2))");
  await w.manager.refreshAll();
  assert.deepEqual([...w.manager.indices.get(nested).targets.keys()], ["beta"]);
  const other = w.write("other/_targets.R", "list(tar_target(other, 3))");
  w.mock.workspace.findFiles = async () => [uri(file), uri(other)];
  await w.manager.refreshAll();
  assert.ok(w.manager.indices.has(path.dirname(other)));
});

test("root deletion and workspace removal clear indexes, diagnostics, and ownership", async (t) => {
  const w = workspace(t);
  const file = w.write("nested/_targets.R", "list(tar_target(alpha, 1), unsupported_factory(x))");
  const nested = path.dirname(file);
  const removed = [];
  w.manager.onDidRemove((event) => removed.push(event.root));
  await w.manager.refreshWorkspace(nested);
  assert.ok(w.diagnostics.size);
  fs.rmSync(file);
  w.manager.scheduleRefreshForUri(uri(file));
  assert.equal(w.manager.indices.size, 0);
  assert.equal(w.manager.dependenciesByRoot.size, 0);
  assert.equal(w.manager.diagnosticFilesByWorkspace.size, 0);
  assert.equal(w.diagnostics.size, 0);
  assert.deepEqual(removed, [nested]);
  w.write("nested/_targets.R", "list(tar_target(beta, 2))");
  await w.manager.refreshWorkspace(nested);
  w.mock.workspace.workspaceFolders = [];
  await w.manager.refreshAll();
  assert.equal(w.manager.indices.size, 0);
  assert.equal(w.manager.rootGenerations.size, 0);
});

test("a transient build error is retried without publishing an old snapshot", async (t) => {
  const w = workspace(t);
  w.write("_targets.R", "list(tar_target(alpha, 1))");
  await w.manager.refreshWorkspace(w.root);
  w.write("_targets.R", "list(tar_target(beta, 2))");
  const readFile = w.manager.readFile.bind(w.manager);
  let failures = 1;
  w.manager.readFile = (file) => {
    if (failures-- > 0) { throw new Error("temporarily unreadable"); }
    return readFile(file);
  };
  const index = await w.manager.refreshWorkspace(w.root);
  assert.deepEqual([...index.targets.keys()], ["beta"]);
  assert.equal(w.manager.failures.size, 0);
  assert.equal(w.manager.retryTimers.size, 0);
  assert.equal(parser.getParserStatistics().liveTrees, 0);
  assert.ok(w.logs.some((line) => line.includes("Retrying index")));
});

test("failed snapshots are withheld and recover automatically after a read failure clears", async (t) => {
  const w = workspace(t);
  const file = w.write("_targets.R", "list(tar_target(alpha, 1))");
  await w.manager.refreshWorkspace(w.root);
  const readFile = w.manager.readFile.bind(w.manager);
  w.manager.readFile = () => { throw new Error("temporarily unreadable"); };
  assert.equal(await w.manager.refreshWorkspace(w.root), null);
  assert.equal(w.manager.indices.get(w.root).stale, true);
  assert.equal(await w.manager.getIndexForUri(uri(file)), null);
  assert.equal(w.manager.retryTimers.size, 1);
  w.write("_targets.R", "list(tar_target(beta, 2))");
  w.manager.readFile = readFile;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual([...w.manager.indices.get(w.root).targets.keys()], ["beta"]);
  assert.equal(w.manager.failures.size, 0);
  assert.equal(w.manager.retryTimers.size, 0);
  assert.equal(w.messages.length, 1);
});

test("disposal during parser readiness prevents late publication", async (t) => {
  const gate = deferred();
  const entered = deferred();
  const w = workspace(t, { runParserOperation: async (operation, options) => {
    entered.resolve();
    await gate.promise;
    return parser.runParserOperation(operation, options);
  } });
  w.write("_targets.R", "list(tar_target(alpha, 1))");
  let publications = 0;
  w.manager.onDidRefresh(() => { publications += 1; });
  const pending = w.manager.refreshWorkspace(w.root);
  await entered.promise;
  w.manager.dispose();
  gate.resolve();
  assert.equal(await pending, null);
  assert.equal(publications, 0);
  assert.equal(w.manager.indices.size, 0);
  assert.equal(w.manager.refreshPromises.size, 0);
  assert.equal(w.manager.dependenciesByRoot.size, 0);
});

test("an obsolete refresh cannot overwrite a deleted and recreated root", async (t) => {
  const gate = deferred();
  const entered = deferred();
  let first = true;
  const w = workspace(t, { runParserOperation: async (operation, options) => {
    if (first) { first = false; entered.resolve(); await gate.promise; }
    return parser.runParserOperation(operation, options);
  } });
  const file = w.write("_targets.R", "list(tar_target(alpha, 1))");
  const obsolete = w.manager.refreshWorkspace(w.root);
  await entered.promise;
  fs.rmSync(file);
  w.manager.scheduleRefreshForUri(uri(file));
  w.write("_targets.R", "list(tar_target(beta, 2))");
  const current = await w.manager.refreshWorkspace(w.root);
  gate.resolve();
  assert.equal(await obsolete, null);
  assert.equal(w.manager.indices.get(w.root), current);
  assert.deepEqual([...current.targets.keys()], ["beta"]);
});

test("shared and initially missing imports refresh all owning roots", async (t) => {
  const w = workspace(t);
  w.write("a/_targets.R", 'source("../shared.R")\nlist(part)');
  w.write("b/_targets.R", 'source("../shared.R")\nlist(part)');
  const a = path.join(w.root, "a");
  const b = path.join(w.root, "b");
  await w.manager.refreshWorkspace(a);
  await w.manager.refreshWorkspace(b);
  const shared = w.write("shared.R", "part <- list(tar_target(alpha, 1))");
  w.manager.scheduleRefreshForUri(uri(shared));
  assert.deepEqual(new Set(w.manager.pendingRefreshes.keys()), new Set([a, b]));
  await w.manager.refreshAll();
  assert.ok(w.manager.indices.get(a).targets.has("alpha"));
  assert.ok(w.manager.indices.get(b).targets.has("alpha"));
  assert.equal(w.manager.getPipelineRootForUri(uri(shared)), a);
});

test("Quarto file and directory dependencies are tracked, including new documents", async (t) => {
  const w = workspace(t);
  w.write("_targets.R", 'list(tar_target(alpha, 1), tar_quarto(report, "reports"))');
  const report = w.write("reports/report.qmd", "```{r}\ntar_read(alpha)\n```\n");
  await w.manager.activate(w.context);
  const index = w.manager.indices.get(w.root);
  assert.ok(index.sourceTexts.has(report));
  assert.ok(index.refs.some((ref) => ref.file === report && ref.targetName === "alpha"));
  assert.ok(w.watchers.some((watcher) => String(watcher.pattern).includes("qmd")));
  const newReport = w.write("reports/new.qmd", "```{r}\ntar_read(alpha)\n```\n");
  w.manager.scheduleRefreshForUri(uri(newReport));
  assert.ok(w.manager.pendingRefreshes.has(w.root));
});

test("imports outside workspace folders have disposable filesystem watchers", async (t) => {
  const w = workspace(t);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "tarborist-external-"));
  t.after(() => fs.rmSync(external, { force: true, recursive: true }));
  const shared = path.join(external, "shared.R");
  fs.writeFileSync(shared, "part <- list(tar_target(alpha, 1))");
  w.write("_targets.R", `source(${JSON.stringify(shared)})\nlist(part)`);
  await w.manager.refreshWorkspace(w.root);
  const watcher = w.watchers.find((item) => item.pattern.base === external);
  assert.ok(watcher);
  watcher.change(uri(shared));
  assert.ok(w.manager.pendingRefreshes.has(w.root));
  w.write("_targets.R", "list(tar_target(beta, 2))");
  await w.manager.refreshWorkspace(w.root);
  assert.equal(watcher.disposed, true);
  assert.equal(w.manager.dependencyWatchers.size, 0);
});

test("diagnostic publication preserves other roots' contributions", (t) => {
  const w = workspace(t);
  const file = path.join(w.root, "shared.R");
  const diagnostic = { file, severity: "warning", message: "A warning", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const index = (values) => ({ files: new Map([[file, { diagnostics: values }]]) });
  w.manager.applyDiagnostics("a", index([diagnostic]));
  w.manager.applyDiagnostics("b", index([]));
  assert.deepEqual(w.diagnostics.get(file), [diagnostic]);
  w.manager.applyDiagnostics("b", index([diagnostic]));
  assert.equal(w.diagnostics.get(file).length, 1, "identical contributions are deduplicated");
  w.manager.applyDiagnostics("a", { files: new Map() });
  assert.deepEqual(w.diagnostics.get(file), [diagnostic]);
  w.manager.applyDiagnostics("b", { files: new Map() });
  assert.equal(w.diagnostics.size, 0);
});

test("metadata refresh reuses source trees' plain snapshot and graph without parsing", async (t) => {
  const w = workspace(t);
  w.write("_targets.R", "list(tar_target(alpha, 1))");
  const initial = await w.manager.refreshWorkspace(w.root);
  w.write("_targets/meta/progress", "name|progress\nalpha|canceled\n");
  const before = parser.getParserStatistics();
  const updated = await w.manager.refreshWorkspace(w.root, { metadataOnly: true });
  assert.equal(updated.targetsProgress.get("alpha"), "canceled");
  assert.equal(updated.graph, initial.graph);
  assert.equal(updated.files, initial.files);
  assert.equal(parser.getParserStatistics().parses, before.parses);
  w.write("_targets.R", "list(tar_target(beta, 2))");
  w.manager.scheduleRefreshForUri(uri(path.join(w.root, "_targets.R")));
  const rebuilt = await w.manager.refreshWorkspace(w.root, { metadataOnly: true });
  assert.ok(rebuilt.targets.has("beta"), "a pending source edit takes priority over metadata-only work");
});

test("overlapping source requests take priority over a metadata refresh", async (t) => {
  const w = workspace(t);
  w.write("_targets.R", "list(tar_target(alpha, 1))");
  await w.manager.refreshWorkspace(w.root);
  w.write("_targets.R", "list(tar_target(beta, 2))");
  const metadata = w.manager.refreshWorkspace(w.root, { metadataOnly: true });
  const source = w.manager.refreshWorkspace(w.root);
  const results = await Promise.all([metadata, source]);
  assert.equal(results[0], results[1]);
  assert.deepEqual([...results[0].targets.keys()], ["beta"]);
  assert.equal(w.manager.refreshPromises.size, 0);
  assert.equal(w.manager.refreshAgain.size, 0);
});

test("persistent failures have only one automatic retry and do not loop in the background", async (t) => {
  const w = workspace(t);
  w.write("_targets.R", "list(tar_target(alpha, 1))");
  let reads = 0;
  w.manager.readFile = () => { reads += 1; throw new Error("persistent failure"); };
  assert.equal(await w.manager.refreshWorkspace(w.root), null);
  assert.equal(reads, 2);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(reads, 4);
  assert.equal(w.manager.retryTimers.size, 0);
  assert.equal(w.manager.pendingRefreshes.size, 0);
  assert.equal(w.messages.length, 1);
  assert.equal(w.manager.refreshPromises.size, 0);
});

test("open imported buffers participate in snapshot freshness checks", async (t) => {
  const w = workspace(t);
  w.write("_targets.R", 'source("part.R")\nlist(part)');
  const file = w.write("part.R", "part <- list(tar_target(alpha, 1))");
  const initial = await w.manager.refreshWorkspace(w.root);
  w.mock.workspace.textDocuments = [{ uri: uri(file), getText: () => "part <- list(tar_target(beta, 2))" }];
  assert.equal(w.manager.isIndexCurrent(initial), false);
  const updated = await w.manager.refreshWorkspace(w.root);
  assert.equal(w.manager.isIndexCurrent(updated), true);
  assert.ok(updated.targets.has("beta"));
});
