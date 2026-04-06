"use strict";

// Own per-workspace pipeline indexes, file watching, refresh scheduling, and
// diagnostic publication.
const fs = require("fs");
const vscode = require("vscode");

const { buildStaticWorkspaceIndex } = require("./pipelineResolver");
const { ensureParserReady } = require("../parser/treeSitter");
const { findNearestTargetsRoot, normalizeFile } = require("../util/paths");
const { toVsCodeDiagnostic } = require("../util/vscode");

class WorkspaceIndexManager {
  constructor(outputChannel) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection("tarborist");
    this.diagnosticFilesByWorkspace = new Map();
    this.indices = new Map();
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
    this.outputChannel.show(true);
  }

  async activate(context) {
    context.subscriptions.push(this.diagnosticCollection);
    if (this.outputChannel) {
      context.subscriptions.push(this.outputChannel);
      this.outputChannel.appendLine("tarborist activating.");
    }
    context.subscriptions.push(this);

    // Re-index on both filesystem events and in-memory editor changes so open
    // unsaved files still participate in the analysis.
    const onFileEvent = (uri) => this.scheduleRefreshForUri(uri);
    const onTextDocument = (document) => {
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

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => onTextDocument(event.document)));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => onTextDocument(document)));
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(onTextDocument));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void this.refreshAll();
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("tarborist.additionalSingleTargetFactories")) {
        return;
      }

      if (this.outputChannel) {
        this.outputChannel.appendLine("Updated tarborist.additionalSingleTargetFactories; refreshing pipeline indexes.");
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

        if (this.outputChannel) {
          this.outputChannel.appendLine(`Indexed ${index.targets.size} targets from ${root}${index.partial ? " (partial)" : ""}.`);
        }

        return index;
      } catch (error) {
        this.logFailure(`Failed to index ${root}`, error, {
          additionalSingleTargetFactories: this.getResolverOptions().additionalSingleTargetFactories.join(", "),
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
