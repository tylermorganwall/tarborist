"use strict";

// Parse direct tar_target() calls into the normalized target shape used
// throughout the workspace index.
const CUE_ARGUMENT_NAMES = new Set(["cue"]);
const PARALLEL_ARGUMENT_NAMES = new Set(["deployment", "memory", "priority", "resources", "retrieval", "storage"]);

const { getArgumentValue, getNamedArgument, getPositionalArgument, getStringValue, isStringNode, rangeFromNode, unpackArguments } = (() => {
  const ast = require("../parser/ast");
  const ranges = require("../util/ranges");
  return {
    getArgumentValue: ast.getArgumentValue,
    getNamedArgument: ast.getNamedArgument,
    getPositionalArgument: ast.getPositionalArgument,
    getStringValue: ast.getStringValue,
    isStringNode: ast.isStringNode,
    rangeFromNode: ranges.rangeFromNode,
    unpackArguments: ast.unpackArguments
  };
})();

function extractTargetName(node) {
  if (!node) {
    return null;
  }

  if (node.type === "identifier") {
    return node.text;
  }

  if (isStringNode(node)) {
    return getStringValue(node);
  }

  return null;
}

function extractTargetOptions(callNode) {
  const options = {
    cue: null,
    parallel: []
  };

  // Preserve option text verbatim so hover can show the exact user code for
  // cueing and parallel-related settings.
  for (const argument of unpackArguments(callNode)) {
    if (!argument.name) {
      continue;
    }

    if (CUE_ARGUMENT_NAMES.has(argument.name)) {
      const valueNode = getArgumentValue(argument.node);
      options.cue = valueNode ? valueNode.text : argument.node.text;
      continue;
    }

    if (PARALLEL_ARGUMENT_NAMES.has(argument.name)) {
      options.parallel.push(argument.node.text);
    }
  }

  return options;
}

function parseTarTargetCall(callNode, file, options = {}) {
  const nameArgument = getNamedArgument(callNode, "name") || getPositionalArgument(callNode, 0);
  const commandArgument = getNamedArgument(callNode, "command") || getPositionalArgument(callNode, 1);
  const patternArgument = getNamedArgument(callNode, "pattern");
  const rawCommandNode = commandArgument ? getArgumentValue(commandArgument.node) : null;
  const rawPatternNode = patternArgument ? getArgumentValue(patternArgument.node) : null;

  if (!nameArgument || !commandArgument || !nameArgument.value || !rawCommandNode) {
    return {
      ok: false,
      reason: "Could not statically resolve tar_target() arguments"
    };
  }

  const name = extractTargetName(nameArgument.value);
  if (!name) {
    return {
      ok: false,
      reason: "Could not statically resolve tar_target() name"
    };
  }

  const targetOptions = extractTargetOptions(callNode);
  // Keep the raw command/pattern nodes around so later passes can extract refs
  // and completion regions without reparsing strings.
  const target = {
    name,
    file,
    nameRange: rangeFromNode(nameArgument.value),
    fullRange: rangeFromNode(callNode),
    commandRange: rawCommandNode ? rangeFromNode(rawCommandNode) : null,
    patternRange: rawPatternNode ? rangeFromNode(rawPatternNode) : null,
    origin: options.origin || "tar_target",
    generated: Boolean(options.generated),
    generator: options.generator || undefined,
    options: targetOptions,
    _analysis: {
      bindings: options.bindings || null,
      commandNode: rawCommandNode || null,
      patternNode: rawPatternNode || null,
      templateName: options.templateName || name,
      templateNameMap: options.templateNameMap || null
    }
  };

  return {
    ok: true,
    target
  };
}

module.exports = {
  parseTarTargetCall
};
