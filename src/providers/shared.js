"use strict";

// Shared cursor-to-index lookup helpers used by multiple editor providers.
const { containsPosition, rangeLength } = require("../util/ranges");

function pickSmallest(matches) {
  // When several ranges overlap, prefer the smallest semantic region under the cursor.
  if (!matches.length) {
    return null;
  }

  return matches.sort((left, right) => rangeLength(left.range) - rangeLength(right.range))[0];
}

function findRefAtPosition(index, file, position) {
  const refs = index.completionRefs || index.refs || [];
  const matches = refs.filter((ref) => !ref.synthetic && ref.file === file && containsPosition(ref.range, position));
  return pickSmallest(matches);
}

function findTargetAtPosition(index, file, position) {
  const targets = index.completionTargets || index.targets || new Map();
  for (const target of targets.values()) {
    if (target.file === file && containsPosition(target.nameRange, position)) {
      return target;
    }
  }

  const ref = findRefAtPosition(index, file, position);
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

module.exports = {
  findCompletionRegion,
  findGeneratorAtPosition,
  findRefAtPosition,
  findTargetAtPosition
};
