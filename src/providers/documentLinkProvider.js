"use strict";

// Turn statically resolved source()/tar_source() paths into clickable links.
const vscode = require("vscode");

const { normalizeFile } = require("../util/paths");
const { toVsCodeRange } = require("../util/vscode");

class TargetDocumentLinkProvider {
  constructor(indexManager) {
    this.indexManager = indexManager;
  }

  async provideDocumentLinks(document) {
    const index = await this.indexManager.getIndexForUri(document.uri);
    if (!index) {
      return [];
    }

    const file = normalizeFile(document.uri.fsPath);
    const record = index.files.get(file);
    if (!record) {
      return [];
    }

    return (record.importLinks || []).map((link) => {
      const documentLink = new vscode.DocumentLink(
        toVsCodeRange(link.range),
        vscode.Uri.file(link.target)
      );
      documentLink.tooltip = link.target;
      return documentLink;
    });
  }
}

module.exports = {
  TargetDocumentLinkProvider
};
