"use strict";

// Extension entrypoint: wire the static pipeline index to VS Code/Positron commands
// and language feature providers.
const { tryAcquirePositronApi } = require("@posit-dev/positron");
const vscode = require("vscode");

const { WorkspaceIndexManager } = require("./index/workspaceIndex");
const { TargetCompletionProvider } = require("./providers/completionProvider");
const { TargetDefinitionProvider } = require("./providers/definitionProvider");
const { TargetDocumentSymbolProvider } = require("./providers/documentSymbolProvider");
const { TargetDocumentLinkProvider } = require("./providers/documentLinkProvider");
const { TargetHoverProvider } = require("./providers/hoverProvider");
const { TargetWorkspaceSymbolProvider } = require("./providers/workspaceSymbolProvider");
const { findTargetAtPosition } = require("./providers/shared");
const { normalizeFile } = require("./util/paths");
const { toVsCodeRange } = require("./util/vscode");

const R_DOCUMENT_SELECTORS = [
  { pattern: "**/*.R", scheme: "file" },
  { pattern: "**/*.r", scheme: "file" }
];

const NAVIGATION_DOCUMENT_SELECTORS = [
  ...R_DOCUMENT_SELECTORS,
  { pattern: "**/*.qmd", scheme: "file" },
  { pattern: "**/*.QMD", scheme: "file" },
  { pattern: "**/*.Rmd", scheme: "file" },
  { pattern: "**/*.rmd", scheme: "file" }
];
const TAR_LOAD_HERE_CONTEXT_KEY = "tarborist.canTarLoadHere";
const POSITRON_SILENT_EXECUTION_MODE = "silent";

function rString(value) {
  return JSON.stringify(String(value));
}

async function getSelectedOrCurrentTarget(editor, indexManager) {
  if (!editor || !editor.document || !editor.selection || !indexManager) {
    return undefined;
  }

  const index = await indexManager.getIndexForUri(editor.document.uri);
  if (!index) {
    return undefined;
  }

  const file = normalizeFile(editor.document.uri.fsPath);
  const selectedText = editor.document.getText(editor.selection).trim();
  if (selectedText.length > 0) {
    const target = findTargetAtPosition(index, file, {
      character: editor.selection.start.character,
      line: editor.selection.start.line
    });
    return target && target.name === selectedText ? target.name : undefined;
  }

  const target = findTargetAtPosition(index, file, {
    character: editor.selection.active.character,
    line: editor.selection.active.line
  });
  return target ? target.name : undefined;
}

function buildTarLoadCode(targetName) {
  return [
    "local({",
    "  if (!requireNamespace(\"targets\", quietly = TRUE)) {",
    "    stop(\"Package 'targets' is not installed.\")",
    "  }",
    `  targets::tar_load_raw(${rString(targetName)}, envir = .GlobalEnv)`,
    "})"
  ].join("\n");
}

async function updateTarLoadHereContext(indexManager, editor = vscode.window.activeTextEditor) {
  const enabled = Boolean(
    editor &&
    editor.document &&
    editor.document.languageId === "r" &&
    await getSelectedOrCurrentTarget(editor, indexManager)
  );
  await vscode.commands.executeCommand("setContext", TAR_LOAD_HERE_CONTEXT_KEY, enabled);
  return enabled;
}

async function executeTarLoadHere(editor, indexManager, positronApi = typeof tryAcquirePositronApi === "function" ? tryAcquirePositronApi() : null) {
  if (!positronApi || !positronApi.runtime || typeof positronApi.runtime.executeCode !== "function") {
    await vscode.window.showErrorMessage("This command requires Positron.");
    return false;
  }

  if (!editor || !editor.document || editor.document.languageId !== "r") {
    await vscode.window.showErrorMessage("This command only works in R files.");
    return false;
  }

  const targetName = await getSelectedOrCurrentTarget(editor, indexManager);
  if (!targetName) {
    await vscode.window.showErrorMessage("No valid target under the cursor or selection.");
    return false;
  }

  try {
    await positronApi.runtime.executeCode(
      "r",
      buildTarLoadCode(targetName),
      true,
      false,
      POSITRON_SILENT_EXECUTION_MODE
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`tar_load failed: ${message}`);
    return false;
  }
}

function registerTarLoadHereCommand(context, indexManager) {
  const disposable = vscode.commands.registerTextEditorCommand(
    "targetsTools.tarLoadHere",
    async (editor) => executeTarLoadHere(editor, indexManager)
  );
  context.subscriptions.push(disposable);
  return disposable;
}

async function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("tarborist");
  const indexManager = new WorkspaceIndexManager(outputChannel);
  await indexManager.activate(context);
  registerTarLoadHereCommand(context, indexManager);

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
    await updateTarLoadHereContext(indexManager);
  }));

  // All providers share the same workspace index manager so they operate on one
  // consistent static snapshot of the pipeline.
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    NAVIGATION_DOCUMENT_SELECTORS,
    new TargetDefinitionProvider(indexManager)
  ));

  context.subscriptions.push(vscode.languages.registerHoverProvider(
    NAVIGATION_DOCUMENT_SELECTORS,
    new TargetHoverProvider(indexManager)
  ));

  context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(
    R_DOCUMENT_SELECTORS,
    new TargetDocumentLinkProvider(indexManager)
  ));

  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(
    R_DOCUMENT_SELECTORS,
    new TargetDocumentSymbolProvider(indexManager)
  ));

  context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(
    new TargetWorkspaceSymbolProvider(indexManager)
  ));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    R_DOCUMENT_SELECTORS,
    new TargetCompletionProvider(indexManager),
    "\"",
    "'",
    "(",
    ",",
    "+",
    "-",
    "*",
    "/",
    "^",
    "&",
    "|",
    "=",
    "%"
  ));

  const refreshTarLoadHereContext = () => {
    void updateTarLoadHereContext(indexManager);
  };

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    void updateTarLoadHereContext(indexManager, editor);
  }));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    if (event.textEditor === vscode.window.activeTextEditor) {
      refreshTarLoadHereContext();
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
      refreshTarLoadHereContext();
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    if (vscode.window.activeTextEditor && document === vscode.window.activeTextEditor.document) {
      refreshTarLoadHereContext();
      setTimeout(refreshTarLoadHereContext, 250);
    }
  }));

  await updateTarLoadHereContext(indexManager);
}

function deactivate() {}

module.exports = {
  activate,
  buildTarLoadCode,
  deactivate,
  executeTarLoadHere,
  getSelectedOrCurrentTarget,
  registerTarLoadHereCommand,
  rString,
  TAR_LOAD_HERE_CONTEXT_KEY,
  updateTarLoadHereContext
};
