"use strict";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTargetBoundary(character) {
  return !character || !/[A-Za-z0-9._]/.test(character);
}

function findTargetMatches(line, index) {
  const targetsMap = index && (index.completionTargets || index.targets);
  if (!line || !targetsMap) {
    return [];
  }

  const matches = [];
  const occupied = [];
  const targets = [...targetsMap.values()].sort((left, right) => right.name.length - left.name.length);

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

module.exports = {
  findTargetMatches
};
