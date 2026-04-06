"use strict";

// Parse one file into a simple stream of top-level statements the resolver can
// execute statically in source order.
const { parseText } = require("../parser/treeSitter");
const { getAssignmentParts, getTableColumnAssignmentParts, isCommentNode, isImportCall } = require("../parser/ast");

function analyzeFile(file, text) {
  const tree = parseText(text, {
    file,
    phase: "analyzeFile"
  });
  const statements = [];
  const topLevelNodes = tree.rootNode.namedChildren || [];

  // The resolver only needs a coarse top-level classification here: assignments,
  // imports, and everything else as expressions.
  for (const node of topLevelNodes) {
    if (isCommentNode(node)) {
      continue;
    }

    const assignment = getAssignmentParts(node);
    if (assignment) {
      statements.push({
        kind: "assignment",
        node,
        symbol: assignment.symbol,
        valueNode: assignment.rhs
      });
      continue;
    }

    const columnAssignment = getTableColumnAssignmentParts(node);
    if (columnAssignment) {
      statements.push({
        kind: "columnAssignment",
        columnName: columnAssignment.columnName,
        node,
        symbol: columnAssignment.symbol,
        valueNode: columnAssignment.rhs
      });
      continue;
    }

    if (isImportCall(node)) {
      statements.push({
        kind: "import",
        node
      });
      continue;
    }

    statements.push({
      kind: "expression",
      node
    });
  }

  return {
    file,
    statements,
    text,
    tree
  };
}

module.exports = {
  analyzeFile
};
