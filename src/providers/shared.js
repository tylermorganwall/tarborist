"use strict";

// Shared cursor-to-index lookup helpers used by multiple editor providers.
const { normalizeFile } = require("../util/paths");
const { containsPosition, rangeLength } = require("../util/ranges");

function pickSmallest(matches) {
  // When several ranges overlap, prefer the smallest semantic region under the cursor.
  if (!matches.length) {
    return null;
  }

  return matches.sort((left, right) => rangeLength(left.range) - rangeLength(right.range))[0];
}

function findRefAtPosition(index, file, position, options = {}) {
  const refs = index.completionRefs || index.refs || [];
  const includeSynthetic = Boolean(options.includeSynthetic);
  const matches = refs.filter((ref) => (
    (includeSynthetic || !ref.synthetic) &&
    ref.file === file &&
    containsPosition(ref.range, position)
  ));
  return pickSmallest(matches);
}

function findTargetAtPosition(index, file, position, options = {}) {
  const targets = index.completionTargets || index.targets || new Map();
  for (const target of targets.values()) {
    if (target.file === file && containsPosition(target.nameRange, position)) {
      return target;
    }
  }

  const ref = findRefAtPosition(index, file, position, options);
  return ref ? targets.get(ref.targetName) || null : null;
}

function findGeneratorAtPosition(index, file, position) {
  const matches = (index.generators || []).filter((generator) => generator.file === file && containsPosition(generator.range, position));
  return pickSmallest(matches);
}

function findCompletionRegion(index, file, position) {
  const matches = (index.completionRegions || []).filter((region) => region.file === file && containsPosition(region.range, position));
  return pickSmallest(matches);
}

function isDocumentCurrent(index, document, text = document.getText()) {
  if (!index || index.stale) {
    return false;
  }
  const file = normalizeFile(document.uri.fsPath);
  const indexedText = index.sourceTexts?.get(file) ?? index.files?.get(file)?.text;
  return indexedText === undefined || indexedText === text;
}

function isRequestCurrent(document, text, token) {
  return !document.isClosed && !token?.isCancellationRequested && document.getText() === text;
}

async function getCurrentIndexForDocument(manager, document) {
  let index = await manager.getIndexForUri(document.uri);
  if (index && (!isDocumentCurrent(index, document) || (manager.isIndexCurrent && !manager.isIndexCurrent(index)))) {
    const root = manager.getPipelineRootForUri?.(document.uri);
    if (!root || !manager.refreshWorkspace) {
      return null;
    }
    index = await manager.refreshWorkspace(root);
  }
  return index && isDocumentCurrent(index, document) ? index : null;
}

module.exports = {
  getCurrentIndexForDocument,
  isDocumentCurrent,
  isRequestCurrent,
  findCompletionRegion,
  findGeneratorAtPosition,
  findRefAtPosition,
  findTargetAtPosition
};
