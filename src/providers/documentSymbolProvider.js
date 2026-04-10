"use strict";

const vscode = require("vscode");

const { getTargetLocation } = require("../targetLocation");
const { normalizeFile } = require("../util/paths");
const { toVsCodeRange } = require("../util/vscode");

function getDocumentSymbolTargets(index) {
  return index.completionTargets || index.targets || new Map();
}

function buildTargetDetail(index, target) {
  const fragments = [];
  if (target.generated) {
    fragments.push("generated target");
  }
  if (!index.targets.has(target.name)) {
    fragments.push("disabled in final pipeline");
  }

  return fragments.join(" • ");
}

class TargetDocumentSymbolProvider {
  constructor(indexManager) {
    this.indexManager = indexManager;
  }

  async provideDocumentSymbols(document) {
    const index = await this.indexManager.getIndexForUri(document.uri);
    if (!index) {
      return [];
    }

    const file = normalizeFile(document.uri.fsPath);
    const symbols = [];
    for (const target of getDocumentSymbolTargets(index).values()) {
      const location = getTargetLocation(target);
      if (location.file !== file) {
        continue;
      }

      const selectionRange = toVsCodeRange(location.range);
      symbols.push(new vscode.DocumentSymbol(
        target.name,
        buildTargetDetail(index, target),
        vscode.SymbolKind.Variable,
        selectionRange,
        selectionRange
      ));
    }

    symbols.sort((left, right) => {
      if (left.range.start.line !== right.range.start.line) {
        return left.range.start.line - right.range.start.line;
      }

      return left.range.start.character - right.range.start.character;
    });
    return symbols;
  }
}

module.exports = {
  TargetDocumentSymbolProvider
};
