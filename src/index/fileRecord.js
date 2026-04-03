"use strict";

// Parse one file into a simple stream of top-level statements the resolver can
// execute statically in source order.
const { parseText } = require("../parser/treeSitter");
const { getAssignmentParts, isImportCall } = require("../parser/ast");

function analyzeFile(file, text) {
  const tree = parseText(text);
  const statements = [];
  const topLevelNodes = tree.rootNode.namedChildren || [];

  // The resolver only needs a coarse top-level classification here: assignments,
  // imports, and everything else as expressions.
  for (const node of topLevelNodes) {
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
