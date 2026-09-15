"use strict";

// Turn statically resolved source()/tar_source() paths into clickable links.
const vscode = require("vscode");
const { getCurrentIndexForDocument, isRequestCurrent } = require("./shared");

const { normalizeFile } = require("../util/paths");
const { toVsCodeRange } = require("../util/vscode");

class TargetDocumentLinkProvider {
  constructor(indexManager) {
    this.indexManager = indexManager;
  }

  async provideDocumentLinks(document) {
    const text = document.getText();
    const index = await getCurrentIndexForDocument(this.indexManager, document);
    if (!index || !isRequestCurrent(document, text)) {
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
