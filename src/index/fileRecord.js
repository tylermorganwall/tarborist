"use strict";

// Parse one file into a simple stream of top-level statements the resolver can
// execute statically in source order.
const { parseText } = require("../parser/treeSitter");
const { getAssignmentParts, getCalleeName, getTableColumnAssignmentParts, isCommentNode, isImportCall } = require("../parser/ast");

const MALFORMED_PIPELINE_CALLS = new Set([
  "list",
  "tar_plan",
  "tarchetypes::tar_plan"
]);

function analyzeFile(file, text) {
  const tree = parseText(text, {
    file,
    phase: "analyzeFile"
  });
  const statements = [];
  const topLevelNodes = tree.rootNode.namedChildren || [];

  // The resolver only needs a coarse top-level classification here: assignments,
  // imports, and everything else as expressions.
  for (let index = 0; index < topLevelNodes.length; index += 1) {
    const node = topLevelNodes[index];
    if (isCommentNode(node)) {
      continue;
    }

    const nextNode = topLevelNodes[index + 1];
    const malformedCallName = getCalleeName(node);
    if (malformedCallName && nextNode && nextNode.type === "ERROR" && MALFORMED_PIPELINE_CALLS.has(malformedCallName)) {
      statements.push({
        calleeNode: node,
        callName: malformedCallName,
        kind: "malformedPipelineCall",
        node: nextNode
      });
      index += 1;
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
