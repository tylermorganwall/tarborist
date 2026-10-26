"use strict";

const path = require("node:path");
const vscode = require("vscode");
const { getTargetLocation } = require("../targetLocation");

const EXTENSION_ID = "tylermorganwall.tarborist";

function comparablePath(file) {
  const normalized = path.posix.normalize(file.replace(/\\/g, "/"));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validText(value) {
  return typeof value === "string" && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

// A root supplied by the native graph is trusted and strict. A URI's pipeline
// value is only a hint for choosing among already indexed, open pipelines.
async function openTargetDefinition(indexManager, name, { pipelineRoot, pipelineHint } = {}) {
  if (!validText(name)) {
    await vscode.window.showInformationMessage("The target link has a missing or invalid target name.");
    return false;
  }

  let root = pipelineRoot;
  if (root !== undefined) {
    if (!validText(root) || !path.isAbsolute(root)) {
      return false;
    }
    root = path.normalize(root);
  } else {
    await indexManager.refreshAll();
    const indices = [...indexManager.indices.values()].filter((index) => typeof index.rootFile === "string");
    const hint = validText(pipelineHint) ? comparablePath(pipelineHint) : null;
    const absoluteHint = hint && (path.posix.isAbsolute(hint) || path.win32.isAbsolute(hint));
    const matching = !hint ? indices : indices.filter((index) => {
      const file = comparablePath(index.rootFile);
      return absoluteHint ? file === hint : file === hint || file.endsWith(`/${hint}`);
    });

    // An exact pipeline wins even when its target disappeared or its index is
    // stale. Never silently substitute another project's identically named target.
    if (matching.length === 1) {
      root = path.dirname(matching[0].rootFile);
    } else {
      const movedPipeline = absoluteHint && matching.length === 0;
      const candidates = (movedPipeline ? indices : matching)
        .filter((index) => !index.stale && index.targets?.has(name));
      if (candidates.length === 0) {
        const message = matching.length > 0
          ? `Target "${name}" was not found in the current open pipelines. It may have been renamed or removed.`
          : "No open targets pipeline matches this link. Open its folder in Positron and try again.";
        await vscode.window.showInformationMessage(message);
        return false;
      }
      if (candidates.length === 1 && !movedPipeline) {
        root = path.dirname(candidates[0].rootFile);
      } else {
        const picked = await vscode.window.showQuickPick(candidates.map((index) => {
          const location = getTargetLocation(index.targets.get(name));
          return {
            label: path.basename(path.dirname(index.rootFile)),
            description: index.rootFile,
            detail: `${name}: ${location.file}:${(location.range?.start.line ?? 0) + 1}`,
            index
          };
        }), {
          placeHolder: movedPipeline
            ? "The original pipeline is not open. Choose its current pipeline, or cancel."
            : `Choose the pipeline defining "${name}"`,
          matchOnDescription: true,
          matchOnDetail: true
        });
        if (!picked || !candidates.includes(picked.index)) {
          return false;
        }
        root = path.dirname(picked.index.rootFile);
      }
    }
  }

  // Look up the root file from our index, never from the external URI. The
  // manager waits for dirty/pending work and reads unsaved editor buffers.
  const knownIndex = indexManager.indices.get(root);
  const rootFile = knownIndex?.rootFile || path.join(root, "_targets.R");
  if (comparablePath(path.dirname(rootFile)) !== comparablePath(root)) {
    return false;
  }
  const rootUri = vscode.Uri.file(rootFile);
  let index = await indexManager.getIndexForUri(rootUri);
  const isCurrent = (candidate) => candidate && !candidate.stale
    && (!indexManager.isIndexCurrent || indexManager.isIndexCurrent(candidate));
  if (!isCurrent(index)) {
    await indexManager.refreshWorkspace(root);
    index = await indexManager.getIndexForUri(rootUri);
  }
  if (!isCurrent(index) || comparablePath(path.dirname(index.rootFile)) !== comparablePath(root)) {
    await vscode.window.showInformationMessage("The pipeline could not be indexed from its current source. Open its folder in Positron, resolve any indexing errors, and try again.");
    return false;
  }

  const target = index.targets.get(name);
  if (!target) {
    await vscode.window.showInformationMessage(`Target "${name}" is no longer in this pipeline. Refresh the graph to update its target list.`);
    return false;
  }
  const location = getTargetLocation(target);
  const start = location.range?.start;
  if (typeof location.file !== "string" || !path.isAbsolute(location.file)
    || !Number.isSafeInteger(start?.line) || start.line < 0
    || !Number.isSafeInteger(start?.character) || start.character < 0) {
    await vscode.window.showInformationMessage(`Target "${name}" has no indexed source location to open.`);
    return false;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(location.file));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const position = new vscode.Position(start.line, start.character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  return true;
}

function registerTargetNavigation(context, indexManager, outputChannel) {
  const registration = vscode.window.registerUriHandler({
    async handleUri(uri) {
      try {
        // VS Code decodes the complete URI query once before delivering it.
        // Links encode URLSearchParams.toString() as a whole URI component so
        // reserved characters within names and paths survive this boundary.
        const params = new URLSearchParams(uri.query);
        const name = params.get("target");
        const pipelineHint = params.get("pipeline");
        if (uri.scheme !== vscode.env.uriScheme || uri.authority.toLowerCase() !== EXTENSION_ID
          || uri.path !== "/open-target" || uri.fragment
          || params.getAll("target").length !== 1 || !validText(name)
          || params.getAll("pipeline").length > 1
          || (pipelineHint !== null && !validText(pipelineHint))
          || [...params.keys()].some((key) => key !== "target" && key !== "pipeline")) {
          await vscode.window.showInformationMessage("This target link is invalid. Open a target from the pipeline graph again.");
          return;
        }
        await openTargetDefinition(indexManager, name, { pipelineHint });
      } catch (error) {
        const message = `Unable to open the target definition: ${error.message || String(error)}`;
        outputChannel?.appendLine(message);
        await vscode.window.showErrorMessage(message);
      }
    }
  });
  context.subscriptions.push(registration);
  return registration;
}

module.exports = { openTargetDefinition, registerTargetNavigation };
