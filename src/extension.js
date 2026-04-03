"use strict";

// Extension entrypoint: wire the static pipeline index to VS Code/Positron commands
// and language feature providers.
const vscode = require("vscode");

const { WorkspaceIndexManager } = require("./index/workspaceIndex");
const { TargetCompletionProvider } = require("./providers/completionProvider");
const { TargetDefinitionProvider } = require("./providers/definitionProvider");
const { TargetDocumentLinkProvider } = require("./providers/documentLinkProvider");
const { TargetHoverProvider } = require("./providers/hoverProvider");
const { toVsCodeRange } = require("./util/vscode");

const DOCUMENT_SELECTORS = [
  { pattern: "**/*.R", scheme: "file" },
  { pattern: "**/*.r", scheme: "file" }
];

async function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("tarborist");
  const indexManager = new WorkspaceIndexManager(outputChannel);
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
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
