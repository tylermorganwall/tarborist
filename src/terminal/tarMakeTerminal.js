"use strict";

const path = require("path");
const vscode = require("vscode");

const { getTargetDestination } = require("../targetDestination");
const { findNearestTargetsRoot, normalizeFile } = require("../util/paths");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTargetBoundary(character) {
  return !character || !/[A-Za-z0-9._]/.test(character);
}

function findTerminalTargetMatches(line, index) {
  if (!index || !index.targets || !line) {
    return [];
  }

  const matches = [];
  const occupied = [];
  const targets = [...index.targets.values()].sort((left, right) => right.name.length - left.name.length);

  for (const target of targets) {
    const pattern = new RegExp(escapeRegExp(target.name), "g");
    let result = pattern.exec(line);
    while (result) {
      const startIndex = result.index;
      const endIndex = startIndex + target.name.length;
      const previousCharacter = startIndex > 0 ? line[startIndex - 1] : "";
      const nextCharacter = endIndex < line.length ? line[endIndex] : "";
      const overlaps = occupied.some((range) => startIndex < range.end && endIndex > range.start);

      if (!overlaps && isTargetBoundary(previousCharacter) && isTargetBoundary(nextCharacter)) {
        matches.push({
          endIndex,
          startIndex,
          target
        });
        occupied.push({
          end: endIndex,
          start: startIndex
        });
      }

      result = pattern.exec(line);
    }
  }

  return matches.sort((left, right) => left.startIndex - right.startIndex);
}

class TargetTerminalLink extends vscode.TerminalLink {
  constructor(startIndex, length, payload) {
    super(startIndex, length, `Open target ${payload.target.name}`);
    this.payload = payload;
  }
}

class TarMakeTerminalLinkProvider {
  constructor(indexManager, terminalRoots) {
    this.indexManager = indexManager;
    this.terminalRoots = terminalRoots;
  }

  resolveRootForTerminal(terminal) {
    const mappedRoot = this.terminalRoots.get(terminal);
    if (mappedRoot) {
      return mappedRoot;
    }

    const cwd = terminal.shellIntegration && terminal.shellIntegration.cwd
      ? terminal.shellIntegration.cwd.fsPath
      : (typeof terminal.creationOptions.cwd === "string"
        ? terminal.creationOptions.cwd
        : (terminal.creationOptions.cwd && terminal.creationOptions.cwd.fsPath) || null);
    if (!cwd) {
      return null;
    }

    const cwdUri = vscode.Uri.file(cwd);
    const folder = vscode.workspace.getWorkspaceFolder(cwdUri);
    const workspaceRoot = folder ? normalizeFile(folder.uri.fsPath) : normalizeFile(cwd);
    return findNearestTargetsRoot(path.join(normalizeFile(cwd), "__tarborist_terminal__.R"), workspaceRoot) || null;
  }

  provideTerminalLinks(context) {
    const root = this.resolveRootForTerminal(context.terminal);
    if (!root) {
      return [];
    }

    const index = this.indexManager.indices.get(root);
    if (!index) {
      return [];
    }

    return findTerminalTargetMatches(context.line, index).map((match) => {
      const destination = getTargetDestination(match.target);
      return new TargetTerminalLink(match.startIndex, match.target.name.length, {
        file: destination.file,
        range: destination.range,
        target: match.target
      });
    });
  }

  async handleTerminalLink(link) {
    if (!link || !link.payload) {
      return;
    }

    await vscode.commands.executeCommand("tarborist.openLocation", {
      file: link.payload.file,
      range: link.payload.range
    });
  }
}

module.exports = {
  findTerminalTargetMatches,
  TarMakeTerminalLinkProvider
};
