"use strict";

// Own per-workspace pipeline indexes, file watching, refresh scheduling, and
// diagnostic publication.
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const { buildStaticWorkspaceIndex } = require("./pipelineResolver");
const { getParserStatistics, runParserOperation } = require("../parser/treeSitter");
const { findNearestTargetsRoot, isPathInside, normalizeFile, relativeFile } = require("../util/paths");
const { readTargetsMeta, readTargetsProgress } = require("./targetsMeta");
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
    this.refreshAgain = new Map();
    this.pendingModes = new Map();
    this.dependenciesByRoot = new Map();
    this.dependencyWatchers = new Map();
    this.diagnosticsByWorkspace = new Map();
    this.dirtyRoots = new Set();
    this.failures = new Map();
    this.retryTimers = new Map();
    this.rootGenerations = new Map();
    this.disposed = false;
    this.indexRemovalEmitter = new vscode.EventEmitter();
    this.onDidRemove = this.indexRemovalEmitter.event;
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
    context.subscriptions.push(this.indexRemovalEmitter);
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
    const watcherQuarto = vscode.workspace.createFileSystemWatcher("**/*.{qmd,QMD,Rmd,rmd}");

    for (const watcher of [watcherUpper, watcherLower, watcherMeta, watcherQuarto]) {
      watcher.onDidChange(onFileEvent, null, context.subscriptions);
      watcher.onDidCreate(onFileEvent, null, context.subscriptions);
      watcher.onDidDelete(onFileEvent, null, context.subscriptions);
      context.subscriptions.push(watcher);
    }

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(onDocumentLifecycle));
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
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const handle of [...this.pendingRefreshes.values(), ...this.retryTimers.values()]) {
      clearTimeout(handle);
    }
    for (const watcher of this.dependencyWatchers.values()) {
      watcher.dispose();
    }
    for (const map of [this.pendingRefreshes, this.pendingModes, this.retryTimers,
      this.dependenciesByRoot, this.dependencyWatchers, this.indices, this.failures,
      this.refreshPromises, this.refreshAgain, this.rootGenerations,
      this.diagnosticsByWorkspace, this.diagnosticFilesByWorkspace]) {
      map.clear();
    }
    this.dirtyRoots.clear();
    this.diagnosticCollection.dispose();
    this.indexRefreshEmitter.dispose();
    this.indexRemovalEmitter.dispose();
  }

  getWorkspaceRoot(uri) {
    if (!uri || uri.scheme !== "file") {
      return null;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? normalizeFile(folder.uri.fsPath) : null;
  }

  getPipelineRootForUri(uri) {
    if (this.disposed || !uri || uri.scheme !== "file") {
      return null;
    }
    const workspaceRoot = this.getWorkspaceRoot(uri);
    const nearest = workspaceRoot && findNearestTargetsRoot(uri.fsPath, workspaceRoot);
    if (nearest) {
      return nearest;
    }
    // Shared sources may live outside the directory containing _targets.R.
    return [...this.getDependentRoots(uri.fsPath)].filter((root) => this.isActiveRoot(root)).sort()[0] || null;
  }

  async getIndexForUri(uri) {
    const pipelineRoot = this.getPipelineRootForUri(uri);
    if (!pipelineRoot) {
      return null;
    }
    if (!this.isActiveRoot(pipelineRoot)) {
      this.removeRoot(pipelineRoot);
      return null;
    }
    if (this.refreshPromises.has(pipelineRoot)) {
      await this.refreshPromises.get(pipelineRoot);
    } else if (this.dirtyRoots.has(pipelineRoot)
      || ((!this.indices.has(pipelineRoot) || this.failures.has(pipelineRoot))
        && Date.now() >= (this.failures.get(pipelineRoot)?.retryAt || 0))) {
      await this.refreshWorkspace(pipelineRoot);
    }
    const index = this.indices.get(pipelineRoot);
    return index && !index.stale ? index : null;
  }

  isIndexCurrent(index) {
    if (!index || index.stale) {
      return false;
    }
    for (const document of vscode.workspace.textDocuments || []) {
      if (document.uri.scheme === "file") {
        const text = index.sourceTexts?.get(normalizeFile(document.uri.fsPath));
        if (text !== undefined && text !== document.getText()) {
          return false;
        }
      }
    }
    return true;
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
    if (this.disposed) {
      return;
    }
    const roots = new Set([...this.indices.keys(), ...this.dependenciesByRoot.keys(), ...this.refreshPromises.keys(), ...this.pendingRefreshes.keys()]);
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const root = normalizeFile(folder.uri.fsPath);
      if (fs.existsSync(path.join(root, "_targets.R"))) {
        roots.add(root);
      }
    }
    // Include known/open nested roots even in hosts without findFiles().
    for (const document of vscode.workspace.textDocuments || []) {
      const root = this.getPipelineRootForUri(document.uri);
      if (root) {
        roots.add(root);
      }
    }
    if (vscode.workspace.findFiles) {
      try {
        const files = await vscode.workspace.findFiles("**/_targets.R", "**/{.git,node_modules,renv,.venv,_targets}/**");
        for (const uri of files) {
          roots.add(normalizeFile(path.dirname(uri.fsPath)));
        }
      } catch (error) {
        this.logFailure("Could not discover additional pipelines", error);
      }
    }
    if (this.disposed) {
      return;
    }
    const refreshes = [];
    for (const root of roots) {
      if (!this.isActiveRoot(root)) {
        this.removeRoot(root);
      } else {
        refreshes.push(this.refreshWorkspace(root));
      }
    }
    await Promise.all(refreshes);
  }

  isActiveRoot(root) {
    const file = path.join(root, "_targets.R");
    return !this.disposed && Boolean(this.getWorkspaceRoot(vscode.Uri.file(file))) && fs.existsSync(file);
  }

  getDependentRoots(file) {
    const normalized = normalizeFile(file);
    const roots = new Set();
    for (const [root, dependencies] of this.dependenciesByRoot) {
      for (const dependency of dependencies) {
        if (isPathInside(normalized, dependency) || isPathInside(dependency, normalized)) {
          roots.add(root);
          break;
        }
      }
    }
    return roots;
  }

  updateDependencies(root, dependencies) {
    this.dependenciesByRoot.set(root, new Set(dependencies));
    this.updateDependencyWatchers();
  }

  updateDependencyWatchers() {
    if (!vscode.RelativePattern || this.disposed) {
      return;
    }
    const directories = new Set();
    for (const dependencies of this.dependenciesByRoot.values()) {
      for (const file of dependencies) {
        if (this.getWorkspaceRoot(vscode.Uri.file(file))) {
          continue;
        }
        // Watch the nearest existing parent so missing imports can appear later.
        let directory = path.dirname(file);
        while (!fs.existsSync(directory) && path.dirname(directory) !== directory) {
          directory = path.dirname(directory);
        }
        directories.add(directory);
      }
    }
    for (const [directory, watcher] of this.dependencyWatchers) {
      if (!directories.has(directory)) {
        watcher.dispose();
        this.dependencyWatchers.delete(directory);
      }
    }
    for (const directory of directories) {
      if (this.dependencyWatchers.has(directory)) {
        continue;
      }
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, "**/*"));
      const onEvent = (uri) => this.scheduleRefreshForUri(uri);
      watcher.onDidChange(onEvent);
      watcher.onDidCreate(onEvent);
      watcher.onDidDelete(onEvent);
      this.dependencyWatchers.set(directory, watcher);
    }
  }

  removeRoot(rootPath) {
    const root = normalizeFile(rootPath);
    this.rootGenerations.delete(root);
    for (const timers of [this.pendingRefreshes, this.retryTimers]) {
      clearTimeout(timers.get(root));
      timers.delete(root);
    }
    this.pendingModes.delete(root);
    this.refreshAgain.delete(root);
    this.refreshPromises.delete(root);
    this.dirtyRoots.delete(root);
    this.failures.delete(root);
    this.indices.delete(root);
    this.dependenciesByRoot.delete(root);
    this.applyDiagnostics(root, { files: new Map() });
    this.diagnosticsByWorkspace.delete(root);
    this.diagnosticFilesByWorkspace.delete(root);
    this.updateDependencyWatchers();
    if (!this.disposed) {
      this.indexRemovalEmitter.fire({ root });
    }
  }

  scheduleRefreshForUri(uri) {
    if (this.disposed || !uri || uri.scheme !== "file") {
      return;
    }
    const file = normalizeFile(uri.fsPath);
    const roots = this.getDependentRoots(file);
    const nearest = this.getPipelineRootForUri(uri);
    if (nearest) {
      roots.add(nearest);
    }
    // Root deletion cannot be discovered by walking the filesystem afterward.
    const deletedRoot = normalizeFile(path.dirname(file));
    if (path.basename(file) === "_targets.R" && !fs.existsSync(file)) {
      roots.add(deletedRoot);
    }
    for (const root of roots) {
      if (!this.isActiveRoot(root)) {
        this.removeRoot(root);
        continue;
      }
      this.scheduleRefresh(root, { metadataOnly: isPathInside(file, path.join(root, "_targets", "meta")) });
    }
  }

  scheduleRefresh(rootPath, options = {}) {
    if (this.disposed) {
      return;
    }
    const root = normalizeFile(rootPath);
    const pending = this.pendingModes.get(root);
    const metadataOnly = Boolean(options.metadataOnly && (!pending || pending.metadataOnly));
    if (!metadataOnly) {
      this.dirtyRoots.add(root);
    }
    clearTimeout(this.pendingRefreshes.get(root));
    const since = pending?.since || Date.now();
    this.pendingModes.set(root, { metadataOnly, since });
    const handle = setTimeout(() => {
      const mode = this.pendingModes.get(root);
      this.pendingModes.delete(root);
      this.pendingRefreshes.delete(root);
      void this.refreshWorkspace(root, mode);
    }, Math.min(150, Math.max(0, 1000 - (Date.now() - since))));
    this.pendingRefreshes.set(root, handle);
  }

  async refreshWorkspace(rootPath, options = {}) {
    const root = normalizeFile(rootPath);
    if (this.disposed) {
      return null;
    }
    const existing = this.refreshPromises.get(root);
    if (existing) {
      const queued = this.refreshAgain.get(root);
      this.refreshAgain.set(root, { metadataOnly: Boolean(options.metadataOnly && (!queued || queued.metadataOnly)) });
      return existing;
    }
    clearTimeout(this.pendingRefreshes.get(root));
    clearTimeout(this.retryTimers.get(root));
    this.pendingRefreshes.delete(root);
    this.pendingModes.delete(root);
    this.retryTimers.delete(root);
    const generation = this.rootGenerations.get(root) || Symbol(root);
    this.rootGenerations.set(root, generation);
    const isCurrent = () => !this.disposed && this.rootGenerations.get(root) === generation;
    const promise = Promise.resolve().then(async () => {
      let mode = options;
      let result = null;
      do {
        if (!isCurrent()) {
          return null;
        }
        const queued = this.refreshAgain.get(root);
        if (queued) {
          mode = { metadataOnly: Boolean(mode.metadataOnly && queued.metadataOnly) };
        }
        this.refreshAgain.delete(root);
        const dependencies = new Set([path.join(root, "_targets.R")]);
        const started = Date.now();
        const before = getParserStatistics();
        try {
          if (!this.isActiveRoot(root)) {
            this.removeRoot(root);
            return null;
          }
          const previous = this.indices.get(root);
          const metadataOnly = Boolean(mode.metadataOnly && previous && !previous.stale && !this.dirtyRoots.has(root));
          if (metadataOnly) {
            const targets = previous.completionTargets || previous.targets;
            result = {
              ...previous,
              targetsMeta: readTargetsMeta(root, (file) => this.readFile(file), targets),
              targetsProgress: readTargetsProgress(root, (file) => this.readFile(file), targets)
            };
          } else {
            result = await runParserOperation(() => {
              if (!isCurrent()) {
                return null;
              }
              return buildStaticWorkspaceIndex({
                ...this.getResolverOptions(),
                onDependency: (file) => dependencies.add(file),
                readFile: (file) => this.readFile(file),
                workspaceRoot: root
              });
            }, {
              retryAll: true,
              onRetry: (error) => this.logFailure(`Retrying index for ${root}`, error)
            });
          }
          if (!isCurrent()) {
            return null;
          }
          if (!this.isActiveRoot(root)) {
            this.removeRoot(root);
            return null;
          }
          this.dirtyRoots.delete(root);
          this.failures.delete(root);
          this.updateDependencies(root, result.dependencyPaths || dependencies);
          this.indices.set(root, result);
          this.applyDiagnostics(root, result);
          this.indexRefreshEmitter.fire({ index: result, root });
          this.logIndexSummary(root, result);
          if (this.outputChannel) {
            const after = getParserStatistics();
            this.outputChannel.appendLine(`  refresh=${metadataOnly ? "metadata" : "source"} durationMs=${Date.now() - started} parses=${after.parses - before.parses} liveTrees=${after.liveTrees} runtimeGeneration=${after.runtimeGeneration}`);
          }
        } catch (error) {
          if (!isCurrent()) {
            return null;
          }
          const previousFailure = this.failures.get(root);
          this.failures.set(root, { retryAt: Date.now() + 1000 });
          this.dirtyRoots.delete(root);
          const previous = this.indices.get(root);
          if (previous) {
            this.indices.set(root, { ...previous, stale: true });
          }
          this.updateDependencies(root, new Set([...(this.dependenciesByRoot.get(root) || []), ...dependencies]));
          this.applyDiagnostics(root, { files: new Map() });
          this.indexRefreshEmitter.fire({ index: null, root });
          this.logFailure(`Failed to index ${root}`, error, {
            node: process.version,
            platform: `${process.platform} ${process.arch}`,
            rootFile: path.join(root, "_targets.R"),
            vscode: vscode.version,
            ...this.getOpenDocumentDebugDetails(root)
          });
          if (!previousFailure) {
            vscode.window.showErrorMessage("tarborist failed to index the pipeline. See the tarborist output channel for details.");
            this.retryTimers.set(root, setTimeout(() => {
              this.retryTimers.delete(root);
              if (this.isActiveRoot(root)) {
                void this.refreshWorkspace(root);
              } else {
                this.removeRoot(root);
              }
            }, 1000));
          }
          result = null;
        }
        mode = this.refreshAgain.get(root);
      } while (mode && isCurrent());
      return result;
    }).finally(() => {
      if (this.refreshPromises.get(root) === promise) {
        this.refreshPromises.delete(root);
      }
    });
    this.refreshPromises.set(root, promise);
    return promise;
  }

  applyDiagnostics(root, index) {
    const previousFiles = this.diagnosticFilesByWorkspace.get(root) || new Set();
    const nextFiles = new Set(index.files.keys());
    this.diagnosticsByWorkspace.set(root, new Map(
      [...index.files].map(([file, record]) => [file, record.diagnostics || []])
    ));
    for (const file of new Set([...previousFiles, ...nextFiles])) {
      const combined = new Map();
      for (const records of this.diagnosticsByWorkspace.values()) {
        for (const diagnostic of records.get(file) || []) {
          const key = JSON.stringify([diagnostic.range, diagnostic.severity, diagnostic.message]);
          combined.set(key, diagnostic);
        }
      }
      if (!combined.size) {
        this.diagnosticCollection.delete(vscode.Uri.file(file));
      } else {
        this.diagnosticCollection.set(vscode.Uri.file(file), [...combined.values()].map(toVsCodeDiagnostic));
      }
    }
    this.diagnosticFilesByWorkspace.set(root, nextFiles);
  }

}

module.exports = {
  WorkspaceIndexManager
};
