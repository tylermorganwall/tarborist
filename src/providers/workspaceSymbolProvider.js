"use strict";

const vscode = require("vscode");

const { getTargetLocation } = require("../targetLocation");
const { toVsCodeLocation } = require("../util/vscode");

function getWorkspaceSymbolTargets(index) {
  return index.completionTargets || index.targets || new Map();
}

function matchesWorkspaceQuery(targetName, query) {
  if (!query) {
    return true;
  }

  return targetName.toLowerCase().includes(query);
}

function compareSymbolTargets(left, right, query) {
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  const leftStartsWith = query ? leftName.startsWith(query) : false;
  const rightStartsWith = query ? rightName.startsWith(query) : false;

  if (leftStartsWith !== rightStartsWith) {
    return leftStartsWith ? -1 : 1;
  }

  return leftName.localeCompare(rightName);
}

class TargetWorkspaceSymbolProvider {
  constructor(indexManager) {
    this.indexManager = indexManager;
  }

  provideWorkspaceSymbols(query) {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const results = [];

    for (const index of this.indexManager.indices.values()) {
      const targets = [...getWorkspaceSymbolTargets(index).values()]
        .filter((target) => matchesWorkspaceQuery(target.name, normalizedQuery))
        .sort((left, right) => compareSymbolTargets(left, right, normalizedQuery));

      for (const target of targets) {
        const location = getTargetLocation(target);
        const containerName = index.targets.has(target.name)
          ? (target.generated ? "generated target" : "target")
          : (target.generated ? "generated target (disabled in final pipeline)" : "target (disabled in final pipeline)");

        results.push(new vscode.SymbolInformation(
          target.name,
          vscode.SymbolKind.Variable,
          containerName,
          toVsCodeLocation(location.file, location.range)
        ));
      }
    }

    return results;
  }
}

module.exports = {
  TargetWorkspaceSymbolProvider
};
