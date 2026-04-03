"use strict";

// Small AST helpers that hide Tree-sitter R quirks from the rest of the indexer.
const { IMPORT_CALLS } = require("./queries");

const STRING_NODE_TYPES = new Set(["string", "string_literal"]);
const COMMENT_NODE_TYPES = new Set(["comment"]);

function unwrapNode(node) {
  let current = node;

  // Many R expressions are wrapped in expression/parenthesis nodes that are not
  // meaningful for static analysis, so normalize them away up front.
  while (current && (current.type === "parenthesized_expression" || current.type === "expression")) {
    current = current.namedChildren && current.namedChildren.length ? current.namedChildren[current.namedChildren.length - 1] : current;
  }

  if (current && current.type === "braced_expression" && current.namedChildren && current.namedChildren.length) {
    return current.namedChildren[current.namedChildren.length - 1];
  }

  return current;
}

function getCalleeName(node) {
  const current = unwrapNode(node);
  if (!current) {
    return null;
  }

  if (current.type === "identifier") {
    return current.text;
  }

  if (current.type === "namespace_operator") {
    const lhs = current.childForFieldName ? current.childForFieldName("lhs") : null;
    const rhs = current.childForFieldName ? current.childForFieldName("rhs") : null;
    if (lhs && rhs) {
      return `${lhs.text}::${rhs.text}`;
    }
  }

  return null;
}

function getCallName(node) {
  if (!node || node.type !== "call") {
    return null;
  }

  const functionNode = node.childForFieldName ? node.childForFieldName("function") : null;
  return getCalleeName(functionNode || node.namedChildren[0]);
}

function getShortCallName(node) {
  const callName = typeof node === "string" ? node : getCallName(node);
  if (!callName) {
    return null;
  }

  const parts = callName.split("::");
  return parts[parts.length - 1];
}

function matchesCall(node, names) {
  const callName = getCallName(node);
  if (!callName) {
    return false;
  }

  if (names.has(callName)) {
    return true;
  }

  const shortName = getShortCallName(callName);
  return shortName ? names.has(shortName) : false;
}

function getArgumentsNode(callNode) {
  if (!callNode || callNode.type !== "call") {
    return null;
  }

  return callNode.childForFieldName ? callNode.childForFieldName("arguments") : null;
}

function getArgumentNodes(callNode) {
  const argumentsNode = getArgumentsNode(callNode);
  if (!argumentsNode) {
    return [];
  }

  return (argumentsNode.namedChildren || []).filter((child) => child.type === "argument");
}

function getArgumentName(argumentNode) {
  if (!argumentNode) {
    return null;
  }

  const nameNode = argumentNode.childForFieldName ? argumentNode.childForFieldName("name") : null;
  return nameNode ? nameNode.text : null;
}

function getArgumentValue(argumentNode) {
  if (!argumentNode) {
    return null;
  }

  const valueNode = argumentNode.childForFieldName ? argumentNode.childForFieldName("value") : null;
  if (valueNode) {
    return valueNode;
  }

  const nameNode = argumentNode.childForFieldName ? argumentNode.childForFieldName("name") : null;
  return (argumentNode.namedChildren || []).find((child) => child !== nameNode) || null;
}

function unpackArguments(callNode) {
  // Normalize positional and named arguments into one uniform representation.
  return getArgumentNodes(callNode).map((argumentNode, index) => ({
    index,
    node: argumentNode,
    name: getArgumentName(argumentNode),
    value: unwrapNode(getArgumentValue(argumentNode))
  }));
}

function getNamedArgument(callNode, name) {
  return unpackArguments(callNode).find((argument) => argument.name === name) || null;
}

function getPositionalArgument(callNode, position) {
  let positionalIndex = 0;
  for (const argument of unpackArguments(callNode)) {
    if (argument.name) {
      continue;
    }

    if (positionalIndex === position) {
      return argument;
    }

    positionalIndex += 1;
  }

  return null;
}

function isStringNode(node) {
  const current = unwrapNode(node);
  return Boolean(current && STRING_NODE_TYPES.has(current.type));
}

function isCommentNode(node) {
  return Boolean(node && COMMENT_NODE_TYPES.has(node.type));
}

function getStringValue(node) {
  const current = unwrapNode(node);
  if (!current || !isStringNode(current)) {
    return null;
  }

  const text = current.text;
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }

  return text;
}

function isIdentifier(node, expected) {
  const current = unwrapNode(node);
  if (!current || current.type !== "identifier") {
    return false;
  }

  return expected ? current.text === expected : true;
}

function getAssignmentParts(node) {
  if (!node || node.type !== "binary_operator") {
    return null;
  }

  const lhs = node.childForFieldName ? node.childForFieldName("lhs") : null;
  const rhs = node.childForFieldName ? node.childForFieldName("rhs") : null;
  const operator = node.childForFieldName ? node.childForFieldName("operator") : null;
  const operatorText = operator ? operator.text : (node.children || []).find((child) => child.text === "<-" || child.text === "=")?.text;

  if (!lhs || !rhs || !operatorText || (operatorText !== "<-" && operatorText !== "=")) {
    return null;
  }

  if (lhs.type !== "identifier") {
    return null;
  }

  return {
    lhs,
    operator: operatorText,
    rhs: unwrapNode(rhs),
    symbol: lhs.text
  };
}

function walkNamed(node, visitor) {
  if (!node) {
    return;
  }

  visitor(node);
  for (const child of node.namedChildren || []) {
    walkNamed(child, visitor);
  }
}

function findAncestor(node, predicate) {
  let current = node;
  while (current) {
    if (predicate(current)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

function findNodeAt(rootNode, position) {
  // Providers work from editor positions, so use Tree-sitter's smallest named
  // descendant lookup to find the semantic node under the cursor.
  if (!rootNode) {
    return null;
  }

  const point = {
    row: position.line,
    column: position.character
  };

  if (typeof rootNode.namedDescendantForPosition === "function") {
    return rootNode.namedDescendantForPosition(point, point);
  }

  return rootNode.descendantForPosition(point, point);
}

function isImportCall(node) {
  return matchesCall(node, IMPORT_CALLS);
}

module.exports = {
  findAncestor,
  findNodeAt,
  getArgumentName,
  getArgumentNodes,
  getArgumentValue,
  getAssignmentParts,
  getCallName,
  getCalleeName,
  getNamedArgument,
  getPositionalArgument,
  getShortCallName,
  getStringValue,
  isCommentNode,
  isIdentifier,
  isImportCall,
  isStringNode,
  matchesCall,
  unpackArguments,
  unwrapNode,
  walkNamed
};
