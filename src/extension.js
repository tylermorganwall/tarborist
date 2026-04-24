"use strict";

// Extension entrypoint: wire the static pipeline index to VS Code/Positron commands
// and language feature providers.
const { tryAcquirePositronApi } = require("@posit-dev/positron");
const vscode = require("vscode");

const { TargetHeatmapController } = require("./decorations/targetHeatmap");
const { WorkspaceIndexManager } = require("./index/workspaceIndex");
const { organizePipelineText } = require("./organizePipeline");
const { TargetCompletionProvider } = require("./providers/completionProvider");
const { TargetDefinitionProvider } = require("./providers/definitionProvider");
const { TargetDocumentSymbolProvider } = require("./providers/documentSymbolProvider");
const { TargetDocumentLinkProvider } = require("./providers/documentLinkProvider");
const { TargetHoverProvider } = require("./providers/hoverProvider");
const { TargetWorkspaceSymbolProvider } = require("./providers/workspaceSymbolProvider");
const { isCommentNode } = require("./parser/ast");
const { ensureParserReady, parseText } = require("./parser/treeSitter");
const { findCompletionRegion, findTargetAtPosition } = require("./providers/shared");
const { normalizeFile } = require("./util/paths");
const { containsPosition, rangeFromNode, rangeLength } = require("./util/ranges");
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
const EXECUTE_IN_PLACE_CONTEXT_KEY = "tarborist.canExecuteInPlace";
const POSITRON_CONSOLE_EXECUTE_COMMAND = "workbench.action.executeCode.console";
const POSITRON_EDITOR_EXECUTE_COMMAND = "workbench.action.positronConsole.executeCodeWithoutAdvancing";
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

function selectionIsNonEmpty(selection) {
  if (!selection) {
    return false;
  }

  return selection.start.line !== selection.end.line || selection.start.character !== selection.end.character;
}

function isExecuteInPlaceEnabled() {
  if (!vscode.workspace || typeof vscode.workspace.getConfiguration !== "function") {
    return true;
  }

  return vscode.workspace.getConfiguration("tarborist").get("executeInPlace.enabled", true);
}

async function refreshIndexForEditor(editor, indexManager) {
  if (
    !editor ||
    !editor.document ||
    !editor.document.isDirty ||
    !indexManager ||
    typeof indexManager.getPipelineRootForUri !== "function" ||
    typeof indexManager.refreshWorkspace !== "function"
  ) {
    return null;
  }

  const root = indexManager.getPipelineRootForUri(editor.document.uri);
  if (!root) {
    return null;
  }

  return indexManager.refreshWorkspace(root);
}

async function canExecuteInPlace(editor, indexManager) {
  if (!isExecuteInPlaceEnabled() || !editor || !editor.document || editor.document.languageId !== "r" || !editor.selection || !indexManager) {
    return false;
  }

  const index = await indexManager.getIndexForUri(editor.document.uri);
  if (!index) {
    return false;
  }

  const file = normalizeFile(editor.document.uri.fsPath);
  const position = selectionIsNonEmpty(editor.selection)
    ? {
      character: editor.selection.start.character,
      line: editor.selection.start.line
    }
    : {
      character: editor.selection.active.character,
      line: editor.selection.active.line
    };

  return Boolean(findCompletionRegion(index, file, position));
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

async function updateExecuteInPlaceContext(indexManager, editor = vscode.window.activeTextEditor) {
  const enabled = Boolean(await canExecuteInPlace(editor, indexManager));
  await vscode.commands.executeCommand("setContext", EXECUTE_IN_PLACE_CONTEXT_KEY, enabled);
  return enabled;
}

function cloneSelection(selection) {
  if (!selection) {
    return null;
  }

  const anchor = selection.anchor || selection.start;
  const active = selection.active || selection.end;
  return new vscode.Selection(anchor.line, anchor.character, active.line, active.character);
}

function cloneRange(range) {
  if (!range) {
    return null;
  }

  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function snapshotEditorState(editor) {
  return {
    selections: (editor.selections && editor.selections.length ? editor.selections : [editor.selection])
      .map((selection) => cloneSelection(selection))
      .filter(Boolean),
    visibleRange: editor.visibleRanges && editor.visibleRanges.length
      ? cloneRange(editor.visibleRanges[0])
      : null
  };
}

function restoreEditorState(editor, snapshot) {
  if (!editor || !snapshot) {
    return;
  }

  if (snapshot.selections && snapshot.selections.length) {
    editor.selections = snapshot.selections.map((selection) => cloneSelection(selection));
    editor.selection = editor.selections[0];
  }

  if (snapshot.visibleRange) {
    editor.revealRange(snapshot.visibleRange, vscode.TextEditorRevealType.AtTop);
    return;
  }

  const selection = editor.selection || (editor.selections && editor.selections[0]);
  if (!selection) {
    return;
  }

  const active = selection.active || selection.end;
  editor.revealRange(
    new vscode.Range(active.line, active.character, active.line, active.character),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

function getFullDocumentRange(document) {
  const lastLine = Math.max(0, document.lineCount - 1);
  const lastCharacter = document.lineAt(lastLine).text.length;
  return new vscode.Range(0, 0, lastLine, lastCharacter);
}

function rangesEqual(left, right) {
  return Boolean(
    left &&
    right &&
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function rangeContainsRange(outer, inner) {
  return Boolean(
    outer &&
    inner &&
    containsPosition(outer, inner.start) &&
    containsPosition(outer, inner.end)
  );
}

function getSemanticBracedChildren(bracedNode) {
  return (bracedNode && bracedNode.namedChildren ? bracedNode.namedChildren : [])
    .filter((child) => !isCommentNode(child));
}

function isBlankDocumentLine(document, line) {
  if (!document || !Number.isInteger(line) || line < 0 || typeof document.lineAt !== "function") {
    return false;
  }

  try {
    return document.lineAt(line).text.trim().length === 0;
  } catch (_error) {
    return false;
  }
}

function getDocumentLineText(document, line) {
  if (!document || !Number.isInteger(line) || line < 0 || typeof document.lineAt !== "function") {
    return "";
  }

  try {
    return document.lineAt(line).text;
  } catch (_error) {
    return "";
  }
}

function getLineIndentCharacter(document, line) {
  const text = getDocumentLineText(document, line);
  const match = text.match(/\S/);
  return match ? match.index : 0;
}

function findNextNonBlankLineIndent(document, startLine, endLine) {
  for (let line = startLine; line <= endLine; line += 1) {
    if (!isBlankDocumentLine(document, line)) {
      return getLineIndentCharacter(document, line);
    }
  }

  return 0;
}

function findNextNonBlankLinePosition(document, startLine, endLine) {
  for (let line = startLine; line <= endLine; line += 1) {
    if (!isBlankDocumentLine(document, line)) {
      return {
        character: getLineIndentCharacter(document, line),
        line
      };
    }
  }

  return null;
}

function makeCollapsedRangeAt(position) {
  return {
    end: {
      character: position.character,
      line: position.line
    },
    start: {
      character: position.character,
      line: position.line
    }
  };
}

function findPostExpressionPosition(document, currentRange, nextRange, regionRange) {
  if (!currentRange) {
    return regionRange ? regionRange.end : null;
  }

  const searchEndLine = nextRange ? nextRange.start.line : (regionRange ? regionRange.end.line : currentRange.end.line);
  for (let line = currentRange.end.line + 1; line < searchEndLine; line += 1) {
    if (isBlankDocumentLine(document, line)) {
      const targetIndent = findNextNonBlankLineIndent(document, line + 1, searchEndLine);
      if (getDocumentLineText(document, line).length >= targetIndent) {
        return {
          character: targetIndent,
          line
        };
      }

      const nextNonBlank = findNextNonBlankLinePosition(document, line + 1, searchEndLine);
      if (nextNonBlank) {
        return nextNonBlank;
      }

      return {
        character: 0,
        line
      };
    }
  }

  if (nextRange && nextRange.start.line > currentRange.end.line) {
    return nextRange.start;
  }

  if (regionRange && regionRange.end.line > currentRange.end.line) {
    return regionRange.end;
  }

  return currentRange.end;
}

function findBracedNodeForRegion(rootNode, region, position) {
  const candidates = [];
  let exact = null;

  const visit = (node) => {
    if (!node || exact) {
      return;
    }

    if (node.type === "braced_expression") {
      const currentRange = rangeFromNode(node);
      if (rangesEqual(currentRange, region.range)) {
        exact = node;
        return;
      }

      if (rangeContainsRange(region.range, currentRange) && containsPosition(currentRange, position)) {
        candidates.push(node);
      }
    }

    for (const child of node.namedChildren || []) {
      visit(child);
    }
  };

  visit(rootNode);
  if (exact) {
    return exact;
  }

  // If an exact match is unavailable, prefer the outermost braced ancestor
  // inside the completion region. Inner braces would jump too narrowly.
  return candidates.sort((left, right) => rangeLength(rangeFromNode(right)) - rangeLength(rangeFromNode(left)))[0] || null;
}

async function findBracedRegionPostExecutionRange(document, region, position) {
  if (!document || !region || !region.range || !position) {
    return null;
  }

  await ensureParserReady();
  const tree = parseText(document.getText(), {
    character: position.character,
    file: document.uri && document.uri.fsPath,
    line: position.line,
    phase: "executeInPlace"
  });
  const bracedNode = findBracedNodeForRegion(tree.rootNode, region, position);
  if (!bracedNode) {
    return null;
  }

  const semanticChildren = getSemanticBracedChildren(bracedNode);
  if (semanticChildren.length <= 1) {
    return region.range;
  }

  const currentIndex = semanticChildren.findIndex((child) => containsPosition(rangeFromNode(child), position));
  if (currentIndex < 0) {
    return region.range;
  }

  const currentRange = rangeFromNode(semanticChildren[currentIndex]);
  const nextChild = semanticChildren[currentIndex + 1] || null;
  const nextRange = nextChild ? rangeFromNode(nextChild) : null;
  return makeCollapsedRangeAt(findPostExpressionPosition(document, currentRange, nextRange, region.range));
}

async function getPostExecutionSelection(document, region, selection, regionText) {
  if (!region || !selection || selectionIsNonEmpty(selection)) {
    return null;
  }

  const point = {
    character: selection.active.character,
    line: selection.active.line
  };
  const targetRange = regionText.trim().startsWith("{")
    ? await findBracedRegionPostExecutionRange(document, region, point)
    : region.range;
  if (!targetRange) {
    return null;
  }

  return new vscode.Selection(
    targetRange.end.line,
    targetRange.end.character,
    targetRange.end.line,
    targetRange.end.character
  );
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

async function executeInPlace(editor, indexManager, positronApi = typeof tryAcquirePositronApi === "function" ? tryAcquirePositronApi() : null) {
  if (!positronApi) {
    await vscode.window.showErrorMessage("This command requires Positron.");
    return false;
  }

  if (!editor || !editor.document || editor.document.languageId !== "r") {
    await vscode.window.showErrorMessage("This command only works in R files.");
    return false;
  }

  await refreshIndexForEditor(editor, indexManager);

  if (!await canExecuteInPlace(editor, indexManager)) {
    await vscode.commands.executeCommand("workbench.action.positronConsole.executeCode");
    return true;
  }

  const snapshot = snapshotEditorState(editor);
  let postExecutionSelection = null;
  let succeeded = false;
  try {
    if (selectionIsNonEmpty(editor.selection)) {
      await vscode.commands.executeCommand(POSITRON_CONSOLE_EXECUTE_COMMAND, {
        code: editor.document.getText(editor.selection),
        focus: false,
        langId: "r"
      });
    } else {
      const index = await indexManager.getIndexForUri(editor.document.uri);
      const file = normalizeFile(editor.document.uri.fsPath);
      const point = {
        character: editor.selection.active.character,
        line: editor.selection.active.line
      };
      const region = index ? findCompletionRegion(index, file, point) : null;
      const regionText = region ? editor.document.getText(toVsCodeRange(region.range)) : "";
      postExecutionSelection = await getPostExecutionSelection(editor.document, region, editor.selection, regionText);

      if (regionText.trim().startsWith("{")) {
        await vscode.commands.executeCommand(POSITRON_EDITOR_EXECUTE_COMMAND);
      } else {
        await vscode.commands.executeCommand(POSITRON_CONSOLE_EXECUTE_COMMAND, {
          code: regionText,
          focus: false,
          langId: "r"
        });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    succeeded = true;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`Run in place failed: ${message}`);
    return false;
  } finally {
    if (succeeded && postExecutionSelection) {
      editor.selections = [cloneSelection(postExecutionSelection)];
      editor.selection = editor.selections[0];
      const active = editor.selection.active;
      editor.revealRange(
        new vscode.Range(active.line, active.character, active.line, active.character),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
    } else {
      restoreEditorState(editor, snapshot);
    }
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

function registerExecuteInPlaceCommand(context, indexManager) {
  const disposable = vscode.commands.registerTextEditorCommand(
    "targetsTools.executeInPlace",
    async (editor) => executeInPlace(editor, indexManager)
  );
  context.subscriptions.push(disposable);
  return disposable;
}

function registerOrganizePipelineCommand(context, indexManager, targetHeatmapController) {
  const disposable = vscode.commands.registerTextEditorCommand(
    "tarborist.organizePipeline",
    async (editor) => {
      if (!editor || !editor.document || editor.document.languageId !== "r") {
        await vscode.window.showErrorMessage("This command only works in R files.");
        return;
      }

      await refreshIndexForEditor(editor, indexManager);
      const root = indexManager.getPipelineRootForUri(editor.document.uri);
      if (root) {
        await indexManager.refreshWorkspace(root);
      }

      const index = await indexManager.getIndexForUri(editor.document.uri);
      if (!index) {
        await vscode.window.showErrorMessage("No targets pipeline was found for the active document.");
        return;
      }

      const result = await organizePipelineText({
        file: normalizeFile(editor.document.uri.fsPath),
        index,
        text: editor.document.getText()
      });

      if (!result.changed) {
        return;
      }

      await editor.edit((editBuilder) => {
        editBuilder.replace(getFullDocumentRange(editor.document), result.text);
      });

      if (root) {
        await indexManager.refreshWorkspace(root);
      }
      await updateTarLoadHereContext(indexManager, editor);
      await updateExecuteInPlaceContext(indexManager, editor);
      await targetHeatmapController.refreshVisibleEditors();
    }
  );
  context.subscriptions.push(disposable);
  return disposable;
}

async function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("tarborist");
  const indexManager = new WorkspaceIndexManager(outputChannel);
  const targetHeatmapController = new TargetHeatmapController(indexManager);
  context.subscriptions.push(targetHeatmapController);
  context.subscriptions.push(indexManager.onDidRefresh(({ index, root }) => {
    void targetHeatmapController.refreshEditorsForRoot(root, index);
  }));

  await indexManager.activate(context);
  registerTarLoadHereCommand(context, indexManager);
  registerExecuteInPlaceCommand(context, indexManager);
  registerOrganizePipelineCommand(context, indexManager, targetHeatmapController);

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
        label: target.label || target.name,
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
    await updateExecuteInPlaceContext(indexManager);
    await targetHeatmapController.refreshVisibleEditors();
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
  const refreshExecuteInPlaceContext = () => {
    void updateExecuteInPlaceContext(indexManager);
  };

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    void updateTarLoadHereContext(indexManager, editor);
    void updateExecuteInPlaceContext(indexManager, editor);
  }));
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    void targetHeatmapController.refreshVisibleEditors();
  }));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    if (event.textEditor === vscode.window.activeTextEditor) {
      refreshTarLoadHereContext();
      refreshExecuteInPlaceContext();
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
      refreshTarLoadHereContext();
      refreshExecuteInPlaceContext();
    }

    void targetHeatmapController.refreshVisibleEditors();
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    if (vscode.window.activeTextEditor && document === vscode.window.activeTextEditor.document) {
      refreshTarLoadHereContext();
      refreshExecuteInPlaceContext();
      setTimeout(refreshTarLoadHereContext, 250);
      setTimeout(refreshExecuteInPlaceContext, 250);
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration("tarborist.targetHeatmap")
      || event.affectsConfiguration("tarborist.targetStatusDecorations")
      || event.affectsConfiguration("tarborist.targetInvalidationDecorations")
    ) {
      void targetHeatmapController.refreshVisibleEditors();
    }

    if (event.affectsConfiguration("tarborist.executeInPlace.enabled")) {
      void updateExecuteInPlaceContext(indexManager);
    }
  }));
  await updateTarLoadHereContext(indexManager);
  await updateExecuteInPlaceContext(indexManager);
  await targetHeatmapController.refreshVisibleEditors();
}

function deactivate() {}

module.exports = {
  activate,
  buildTarLoadCode,
  deactivate,
  EXECUTE_IN_PLACE_CONTEXT_KEY,
  executeInPlace,
  executeTarLoadHere,
  findBracedRegionPostExecutionRange,
  getSelectedOrCurrentTarget,
  getFullDocumentRange,
  getPostExecutionSelection,
  registerExecuteInPlaceCommand,
  registerOrganizePipelineCommand,
  registerTarLoadHereCommand,
  rString,
  TAR_LOAD_HERE_CONTEXT_KEY,
  refreshIndexForEditor,
  updateExecuteInPlaceContext,
  updateTarLoadHereContext
};
