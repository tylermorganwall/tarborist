"use strict";

// Extension entrypoint: wire the static pipeline index to VS Code/Positron commands
// and language feature providers.
const vscode = require("vscode");

const { WorkspaceIndexManager } = require("./index/workspaceIndex");
const { TargetCompletionProvider } = require("./providers/completionProvider");
const { TargetDefinitionProvider } = require("./providers/definitionProvider");
const { TargetDocumentLinkProvider } = require("./providers/documentLinkProvider");
const { TargetHoverProvider } = require("./providers/hoverProvider");
const { createTarboristMakeController } = require("./tarboristMakeCommands");
const { TarMakeTerminalLinkProvider } = require("./terminal/tarMakeTerminal");
const { toVsCodeRange } = require("./util/vscode");

const DOCUMENT_SELECTORS = [
  { pattern: "**/*.R", scheme: "file" },
  { pattern: "**/*.r", scheme: "file" }
];

function stripTerminalFormatting(text) {
  return String(text)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u009b[0-9;?]*[ -/]*[@-~]/g, "");
}

function formatUserErrorMessage(error, fallbackMessage) {
  if (!error || !error.message) {
    return fallbackMessage;
  }

  const sanitized = stripTerminalFormatting(error.message)
    .replace(/^Error:\s*/i, "")
    .replace(/^\s*!\s*/m, "")
    .replace(/\s+/g, " ")
    .trim();

  return sanitized || fallbackMessage;
}

async function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("tarborist");
  const indexManager = new WorkspaceIndexManager(outputChannel);
  const terminalRoots = new Map();
  const pendingManifestRefreshes = new Map();
  const tarboristMakeController = createTarboristMakeController({
    extensionPath: context.extensionPath,
    indexManager,
    outputChannel,
    stateStore: context.workspaceState
  });
  await indexManager.activate(context);

  // Hover links and quick-picks hand back file/range payloads to these commands.
  context.subscriptions.push(vscode.commands.registerCommand("tarborist.openLocation", async (payload) => {
    if (!payload || !payload.file || !payload.range) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(payload.file));
    const editor = await vscode.window.showTextDocument(document, {
      preview: false
    });
    const targetRange = toVsCodeRange(payload.range);
    editor.selection = new vscode.Selection(targetRange.start, targetRange.end);
    editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenter);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("tarborist.showTargetList", async (payload) => {
    if (!payload || !Array.isArray(payload.targets) || !payload.targets.length) {
      return;
    }

    const selected = await vscode.window.showQuickPick(
      payload.targets.map((target) => ({
        description: target.description,
        label: target.name,
        target
      })),
      {
        placeHolder: payload.title || "Related targets"
      }
    );

    if (!selected) {
      return;
    }

    await vscode.commands.executeCommand("tarborist.openLocation", {
      file: selected.target.file,
      range: selected.target.range
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand("tarborist.refreshIndex", async () => {
    outputChannel.appendLine("Manual refresh requested.");
    await indexManager.refreshAll();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("tarborist.installTarboristMake", async () => {
    try {
      await tarboristMakeController.installTarboristMake({
        activeDocumentUri: vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
          ? vscode.window.activeTextEditor.document.uri
          : null,
        workspaceFolders: vscode.workspace.workspaceFolders || []
      });
    } catch (error) {
      outputChannel.appendLine(String(error && error.stack ? error.stack : error));
      vscode.window.showErrorMessage(formatUserErrorMessage(error, "tarborist could not install tarborist_make()."));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("tarborist.updateTarboristManifest", async () => {
    try {
      await tarboristMakeController.updateTarboristManifest({
        activeDocumentUri: vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
          ? vscode.window.activeTextEditor.document.uri
          : null,
        workspaceFolders: vscode.workspace.workspaceFolders || []
      });
    } catch (error) {
      outputChannel.appendLine(String(error && error.stack ? error.stack : error));
      vscode.window.showErrorMessage(formatUserErrorMessage(error, "tarborist could not update the tarborist manifest."));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("tarborist.tarMake", async () => {
    try {
      await tarboristMakeController.runTarboristMake({
        activeDocumentUri: vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
          ? vscode.window.activeTextEditor.document.uri
          : null,
        workspaceFolders: vscode.workspace.workspaceFolders || []
      });
    } catch (error) {
      outputChannel.appendLine(String(error && error.stack ? error.stack : error));
      vscode.window.showErrorMessage(formatUserErrorMessage(error, "tarborist could not run tarborist_make()."));
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.uri.scheme !== "file") {
      return;
    }

    const workspaceRoot = indexManager.getPipelineRootForUri(document.uri);
    if (!workspaceRoot) {
      return;
    }

    if (!tarboristMakeController.hasTrackedManifest({
      activeDocumentUri: document.uri,
      workspaceFolders: vscode.workspace.workspaceFolders || []
    })) {
      return;
    }

    const existing = pendingManifestRefreshes.get(workspaceRoot);
    if (existing) {
      clearTimeout(existing);
    }

    const handle = setTimeout(() => {
      pendingManifestRefreshes.delete(workspaceRoot);
      void tarboristMakeController.updateTarboristManifest({
        activeDocumentUri: document.uri,
        quiet: true,
        skipIfNotInstalled: true,
        workspaceFolders: vscode.workspace.workspaceFolders || []
      }).catch((error) => {
        outputChannel.appendLine(String(error && error.stack ? error.stack : error));
      });
    }, 200);

    pendingManifestRefreshes.set(workspaceRoot, handle);
  }));

  context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
    terminalRoots.delete(terminal);
  }));

  // All providers share the same workspace index manager so they operate on one
  // consistent static snapshot of the pipeline.
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    DOCUMENT_SELECTORS,
    new TargetDefinitionProvider(indexManager)
  ));

  context.subscriptions.push(vscode.languages.registerHoverProvider(
    DOCUMENT_SELECTORS,
    new TargetHoverProvider(indexManager)
  ));

  context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(
    DOCUMENT_SELECTORS,
    new TargetDocumentLinkProvider(indexManager)
  ));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    DOCUMENT_SELECTORS,
    new TargetCompletionProvider(indexManager),
    "\"",
    "'",
    "(",
    ","
  ));

  context.subscriptions.push(vscode.window.registerTerminalLinkProvider(
    new TarMakeTerminalLinkProvider(indexManager, terminalRoots)
  ));
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  formatUserErrorMessage,
  stripTerminalFormatting
};
