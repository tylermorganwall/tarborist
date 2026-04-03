"use strict";

// Shared range/position helpers used by both Tree-sitter analysis and editor providers.
function position(line, character) {
  return { line, character };
}

function range(startLine, startCharacter, endLine, endCharacter) {
  return {
    start: position(startLine, startCharacter),
    end: position(endLine, endCharacter)
  };
}

function zeroRange() {
  return range(0, 0, 0, 0);
}

function rangeFromNode(node) {
  if (!node) {
    return zeroRange();
  }

  return {
    start: position(node.startPosition.row, node.startPosition.column),
    end: position(node.endPosition.row, node.endPosition.column)
  };
}

function comparePositions(left, right) {
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.character - right.character;
}

function containsPosition(targetRange, point) {
  if (!targetRange || !point) {
    return false;
  }

  return comparePositions(targetRange.start, point) <= 0 && comparePositions(point, targetRange.end) <= 0;
}

function rangeLength(targetRange) {
  if (!targetRange) {
    return Number.POSITIVE_INFINITY;
  }

  return ((targetRange.end.line - targetRange.start.line) * 100000) + (targetRange.end.character - targetRange.start.character);
}

function compareRanges(left, right) {
  return rangeLength(left) - rangeLength(right);
}

module.exports = {
  comparePositions,
  compareRanges,
  containsPosition,
  position,
  range,
  rangeFromNode,
  rangeLength,
  zeroRange
};
