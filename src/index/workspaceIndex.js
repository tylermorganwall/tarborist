"use strict";

// Own per-workspace pipeline indexes, file watching, refresh scheduling, and
// diagnostic publication.
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const { buildStaticWorkspaceIndex } = require("./pipelineResolver");
const { ensureParserReady } = require("../parser/treeSitter");
const { findNearestTargetsRoot, normalizeFile, relativeFile } = require("../util/paths");
const { toVsCodeDiagnostic } = require("../util/vscode");

function diagnosticOutputLine(root, diagnostic) {
  const line = diagnostic.range && diagnostic.range.start
    ? diagnostic.range.start.line + 1
    : 1;

  return `${relativeFile(root, diagnostic.file)}:${line} [${diagnostic.severity}] ${diagnostic.message}`;
}

function collectDiagnosticOutputLines(root, index, limit = 10) {
  const diagnostics = [];
  for (const record of index.files.values()) {
    for (const diagnostic of record.diagnostics || []) {
      if (diagnostic.severity !== "warning" && diagnostic.severity !== "information" && diagnostic.severity !== "error") {
        continue;
      }

      if (
        diagnostic.file === index.rootFile
        && diagnostic.range
        && diagnostic.range.start
        && diagnostic.range.start.line === 0
        && diagnostic.range.start.character === 0
        && diagnostic.message.startsWith("Static pipeline analysis is partial")
      ) {
        continue;
      }

      diagnostics.push(diagnostic);
    }
  }

  diagnostics.sort((left, right) => {
    if (left.file !== right.file) {
      return left.file.localeCompare(right.file);
    }

    const leftLine = left.range && left.range.start ? left.range.start.line : 0;
    const rightLine = right.range && right.range.start ? right.range.start.line : 0;
    if (leftLine !== rightLine) {
      return leftLine - rightLine;
    }

    const leftCharacter = left.range && left.range.start ? left.range.start.character : 0;
    const rightCharacter = right.range && right.range.start ? right.range.start.character : 0;
    return leftCharacter - rightCharacter;
  });

  return {
    lines: diagnostics.slice(0, limit).map((diagnostic) => diagnosticOutputLine(root, diagnostic)),
    remaining: Math.max(0, diagnostics.length - limit)
  };
}

class WorkspaceIndexManager {
  constructor(outputChannel) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection("tarborist");
    this.diagnosticFilesByWorkspace = new Map();
    this.indices = new Map();
    this.indexRefreshEmitter = new vscode.EventEmitter();
    this.onDidRefresh = this.indexRefreshEmitter.event;
    this.outputChannel = outputChannel;
    this.pendingRefreshes = new Map();
    this.refreshPromises = new Map();
  }

  logFailure(label, error, details = {}) {
    if (!this.outputChannel) {
      return;
    }

    this.outputChannel.appendLine(label);
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }

      this.outputChannel.appendLine(`  ${key}: ${value}`);
    }

    if (error && error.parseContext) {
      for (const [key, value] of Object.entries(error.parseContext)) {
        if (value === undefined || value === null || value === "") {
          continue;
        }

        this.outputChannel.appendLine(`  ${key}: ${value}`);
      }
    }

    this.outputChannel.appendLine(String(error && error.stack ? error.stack : error));
  }

  async activate(context) {
    context.subscriptions.push(this.diagnosticCollection);
    context.subscriptions.push(this.indexRefreshEmitter);
    if (this.outputChannel) {
      context.subscriptions.push(this.outputChannel);
      this.outputChannel.appendLine("tarborist activating.");
    }
    context.subscriptions.push(this);

    // Re-index on filesystem/save events and editor lifecycle changes. Avoid
    // rebuilding on every keystroke so transient parse states do not wipe out
    // completion regions or flood diagnostics while the user is typing.
    const onFileEvent = (uri) => this.scheduleRefreshForUri(uri);
    const onDocumentLifecycle = (document) => {
      if (document.uri.scheme !== "file") {
        return;
      }

      this.scheduleRefreshForUri(document.uri);
    };

    const watcherUpper = vscode.workspace.createFileSystemWatcher("**/*.R");
    const watcherLower = vscode.workspace.createFileSystemWatcher("**/*.r");
    const watcherMeta = vscode.workspace.createFileSystemWatcher("**/_targets/meta/**");

    for (const watcher of [watcherUpper, watcherLower, watcherMeta]) {
      watcher.onDidChange(onFileEvent, null, context.subscriptions);
      watcher.onDidCreate(onFileEvent, null, context.subscriptions);
      watcher.onDidDelete(onFileEvent, null, context.subscriptions);
      context.subscriptions.push(watcher);
    }

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(onFileEvent));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => onDocumentLifecycle(document)));
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(onDocumentLifecycle));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void this.refreshAll();
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      const affectsTargetFactories = event.affectsConfiguration("tarborist.additionalSingleTargetFactories");
      const affectsTimeZone = event.affectsConfiguration("tarborist.timeZone");
      if (!affectsTargetFactories && !affectsTimeZone) {
        return;
      }

      if (this.outputChannel) {
        this.outputChannel.appendLine("Updated tarborist configuration; refreshing pipeline indexes.");
      }

      void this.refreshAll();
    }));

    await this.refreshAll();
  }

  dispose() {
    for (const handle of this.pendingRefreshes.values()) {
      clearTimeout(handle);
    }

    this.pendingRefreshes.clear();
    this.diagnosticCollection.dispose();
    this.indexRefreshEmitter.dispose();
  }

  getWorkspaceRoot(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? normalizeFile(folder.uri.fsPath) : null;
  }

  getPipelineRootForUri(uri) {
    const workspaceRoot = this.getWorkspaceRoot(uri);
    if (!workspaceRoot || uri.scheme !== "file") {
      return null;
    }

    return findNearestTargetsRoot(uri.fsPath, workspaceRoot) || null;
  }

  async getIndexForUri(uri) {
    const pipelineRoot = this.getPipelineRootForUri(uri);
    if (!pipelineRoot) {
      return null;
    }

    if (!this.indices.has(pipelineRoot)) {
      await this.refreshWorkspace(pipelineRoot);
    }

    return this.indices.get(pipelineRoot) || null;
  }

  readFile(file) {
    const normalized = normalizeFile(file);
    const openDocument = vscode.workspace.textDocuments.find((document) => (
      document.uri.scheme === "file" && normalizeFile(document.uri.fsPath) === normalized
    ));

    if (openDocument) {
      return openDocument.getText();
    }

    return fs.readFileSync(normalized, "utf8");
  }

  getResolverOptions() {
    const config = vscode.workspace.getConfiguration("tarborist");
    const configuredFactories = config.get("additionalSingleTargetFactories", []);

    return {
      additionalSingleTargetFactories: Array.isArray(configuredFactories) ? configuredFactories : []
    };
  }

  getOpenDocumentDebugDetails(root) {
    const openRDocuments = [];
    const dirtyRDocuments = [];

    for (const document of vscode.workspace.textDocuments || []) {
      if (!document || !document.uri || document.uri.scheme !== "file") {
        continue;
      }

      const file = normalizeFile(document.uri.fsPath);
      const relativePath = path.relative(root, file);
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        continue;
      }

      const lower = file.toLowerCase();
      if (!lower.endsWith(".r")) {
        continue;
      }

      const label = relativeFile(root, file);
      openRDocuments.push(label);
      if (document.isDirty) {
        dirtyRDocuments.push(label);
      }
    }

    return {
      dirtyRDocuments: dirtyRDocuments.join(", "),
      openRDocuments: openRDocuments.join(", ")
    };
  }

  logIndexSummary(root, index) {
    if (!this.outputChannel) {
      return;
    }

    this.outputChannel.appendLine(`Indexed ${index.targets.size} targets from ${root}${index.partial ? " (partial)" : ""}.`);
    if (!index.partial) {
      return;
    }

    const { lines, remaining } = collectDiagnosticOutputLines(root, index);
    if (!lines.length) {
      return;
    }

    this.outputChannel.appendLine("Partial analysis diagnostics:");
    for (const line of lines) {
      this.outputChannel.appendLine(`  ${line}`);
    }

    if (remaining > 0) {
      this.outputChannel.appendLine(`  ... and ${remaining} more diagnostic${remaining === 1 ? "" : "s"}.`);
    }
  }

  async refreshAll() {
    const refreshes = [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const root = normalizeFile(folder.uri.fsPath);
      const topLevelTargets = normalizeFile(`${root}/_targets.R`);
      if (fs.existsSync(topLevelTargets)) {
        refreshes.push(this.refreshWorkspace(root));
      }
    }

    await Promise.all(refreshes);
  }

  scheduleRefreshForUri(uri) {
    const pipelineRoot = this.getPipelineRootForUri(uri);
    if (!pipelineRoot) {
      return;
    }

    this.scheduleRefresh(pipelineRoot);
  }

  scheduleRefresh(rootPath) {
    const root = normalizeFile(rootPath);
    const existing = this.pendingRefreshes.get(root);
    if (existing) {
      clearTimeout(existing);
    }

    // Debounce rebuilds so typing or file watcher bursts do not thrash the parser.
    const handle = setTimeout(() => {
      this.pendingRefreshes.delete(root);
      void this.refreshWorkspace(root);
    }, 150);

    this.pendingRefreshes.set(root, handle);
  }

  async refreshWorkspace(rootPath) {
    const root = normalizeFile(rootPath);
    const existingRefresh = this.refreshPromises.get(root);
    if (existingRefresh) {
      return existingRefresh;
    }

    const refreshPromise = (async () => {
      try {
        await ensureParserReady();

        // Every refresh rebuilds a single pipeline rooted at the nearest _targets.R.
        const index = buildStaticWorkspaceIndex({
          ...this.getResolverOptions(),
          readFile: (file) => this.readFile(file),
          workspaceRoot: root
        });

        this.indices.set(root, index);
        this.applyDiagnostics(root, index);
        this.indexRefreshEmitter.fire({
          index,
          root
        });

        this.logIndexSummary(root, index);

        return index;
      } catch (error) {
        this.logFailure(`Failed to index ${root}`, error, {
          additionalSingleTargetFactories: this.getResolverOptions().additionalSingleTargetFactories.join(", "),
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          rootFile: normalizeFile(`${root}/_targets.R`),
          vscode: vscode.version,
          ...this.getOpenDocumentDebugDetails(root),
          workspaceRoot: root
        });

        vscode.window.showErrorMessage("tarborist failed to index the pipeline. See the tarborist output channel for details.");
        return null;
      } finally {
        this.refreshPromises.delete(root);
      }
    })();

    this.refreshPromises.set(root, refreshPromise);
    return refreshPromise;
  }

  applyDiagnostics(root, index) {
    // Replace diagnostics for every file that was previously or is currently part
    // of this pipeline so stale warnings disappear when the graph changes.
    const previousFiles = this.diagnosticFilesByWorkspace.get(root) || new Set();
    const nextFiles = new Set(index.files.keys());
    const allFiles = new Set([...previousFiles, ...nextFiles]);

    for (const file of allFiles) {
      const diagnostics = index.files.get(file)?.diagnostics || [];
      if (!diagnostics.length) {
        this.diagnosticCollection.delete(vscode.Uri.file(file));
        continue;
      }

      this.diagnosticCollection.set(
        vscode.Uri.file(file),
        diagnostics.map((diagnostic) => toVsCodeDiagnostic(diagnostic))
      );
    }

    this.diagnosticFilesByWorkspace.set(root, nextFiles);
  }
}

module.exports = {
  WorkspaceIndexManager
};
