"use strict";

// Resolve target references to their defining tar_target() or tar_map() origin.
const { normalizeFile } = require("../util/paths");
const { toVsCodeLocation } = require("../util/vscode");
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

    // Generated targets navigate back to the tar_map() call that created them.
    if (target.generated && target.generator) {
      return toVsCodeLocation(target.generator.file, target.generator.range);
    }

    return toVsCodeLocation(target.file, target.nameRange);
  }
}

module.exports = {
  TargetDefinitionProvider
};
