"use strict";

const vscode = require("vscode");

const { getTargetDestination } = require("../targetDestination");
const { findTargetMatches } = require("./targetMatcher");

class TarboristConsoleLinkProvider {
  constructor(indexManager, sessionWorkspaceRegistry) {
    this.indexManager = indexManager;
    this.sessionWorkspaceRegistry = sessionWorkspaceRegistry;
  }

  resolveRootForContext(context) {
    const mappedRoot = this.sessionWorkspaceRegistry.get(context.sessionId);
    if (mappedRoot && this.indexManager.indices.has(mappedRoot)) {
      return mappedRoot;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document && activeEditor.document.uri) {
      const activeRoot = this.indexManager.getPipelineRootForUri(activeEditor.document.uri);
      if (activeRoot && this.indexManager.indices.has(activeRoot)) {
        this.sessionWorkspaceRegistry.set(context.sessionId, activeRoot);
        return activeRoot;
      }
    }

    if (this.indexManager.indices.size === 1) {
      return this.indexManager.indices.keys().next().value || null;
    }

    return null;
  }

  provideConsoleLinks(context) {
    if (!context || context.languageId !== "r" || !context.line) {
      return [];
    }

    const root = this.resolveRootForContext(context);
    if (!root) {
      return [];
    }

    const index = this.indexManager.indices.get(root);
    if (!index) {
      return [];
    }

    return findTargetMatches(context.line, index).map((match) => {
      const destination = getTargetDestination(match.target);

      return {
        startIndex: match.startIndex,
        length: match.target.name.length,
        target: vscode.Uri.file(destination.file),
        line: destination.range.start.line + 1,
        column: destination.range.start.character + 1,
        tooltip: `Open target ${match.target.name}`
      };
    });
  }
}

module.exports = {
  TarboristConsoleLinkProvider
};
