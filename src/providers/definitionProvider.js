"use strict";

// Resolve target references to their defining tar_target()/target-like factory
// or tar_map() origin.
const { normalizeFile } = require("../util/paths");
const { toVsCodeLocation } = require("../util/vscode");
const { getTargetLocation } = require("../targetLocation");
const { findTargetAtPosition } = require("./shared");

class TargetDefinitionProvider {
  constructor(indexManager) {
    this.indexManager = indexManager;
  }

  async provideDefinition(document, position) {
    const index = await this.indexManager.getIndexForUri(document.uri);
    if (!index) {
      return null;
    }

    const file = normalizeFile(document.uri.fsPath);
    const target = findTargetAtPosition(index, file, {
      character: position.character,
      line: position.line
    });

    if (!target) {
      return null;
    }

    const location = getTargetLocation(target);
    return toVsCodeLocation(location.file, location.range);
  }
}

module.exports = {
  TargetDefinitionProvider
};
