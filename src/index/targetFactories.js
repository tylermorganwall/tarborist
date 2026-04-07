"use strict";

// Parse direct tar_target()/target-like factory calls into the normalized
// target shape used throughout the workspace index.
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

function createTargetDefinition(file, callNode, options) {
  const targetOptions = options.targetOptions || extractTargetOptions(callNode);

  return {
    name: options.name,
    file,
    nameRange: rangeFromNode(options.nameNode || callNode),
    fullRange: rangeFromNode(options.fullNode || callNode),
    commandRange: options.commandNode ? rangeFromNode(options.commandNode) : null,
    patternRange: options.patternNode ? rangeFromNode(options.patternNode) : null,
    origin: options.origin || "tar_target",
    generated: Boolean(options.generated),
    generator: options.generator || undefined,
    options: targetOptions,
    _analysis: {
      bindings: options.bindings || null,
      commandNode: options.commandNode || null,
      externalRefs: options.externalRefs || [],
      patternNode: options.patternNode || null,
      templateName: options.templateName || options.name,
      templateNameMap: options.templateNameMap || null
    }
  };
}

function parseTarTargetCall(callNode, file, options = {}) {
  const explicitNameArgument = getNamedArgument(callNode, "name");
  const implicitNameArgument = explicitNameArgument ? null : getPositionalArgument(callNode, 0);
  const nameArgument = explicitNameArgument || implicitNameArgument;
  const hasAssignedName = Boolean(options.nameOverride && !explicitNameArgument);
  const commandArgument = getNamedArgument(callNode, "command") || getPositionalArgument(callNode, hasAssignedName ? 0 : 1);
  const patternArgument = getNamedArgument(callNode, "pattern");
  const rawCommandNode = options.commandNodeOverride || (commandArgument ? getArgumentValue(commandArgument.node) : null);
  const rawPatternNode = patternArgument ? getArgumentValue(patternArgument.node) : null;

  if ((!nameArgument || !nameArgument.value) && !options.nameOverride) {
    return {
      ok: false,
      reason: "Could not statically resolve tar_target()/target-like factory name"
    };
  }

  if (!rawCommandNode) {
    return {
      ok: false,
      reason: "Could not statically resolve tar_target()/target-like factory arguments"
    };
  }

  const name = options.nameOverride || extractTargetName(nameArgument.value);
  if (!name) {
    return {
      ok: false,
      reason: "Could not statically resolve tar_target()/target-like factory name"
    };
  }

  // Keep the raw command/pattern nodes around so later passes can extract refs
  // and completion regions without reparsing strings.
  const target = createTargetDefinition(file, callNode, {
    bindings: options.bindings,
    commandNode: rawCommandNode || null,
    externalRefs: options.externalRefs,
    fullNode: callNode,
    generated: options.generated,
    generator: options.generator,
    name,
    nameNode: options.nameNodeOverride || nameArgument.value,
    origin: options.origin,
    patternNode: rawPatternNode || null,
    targetOptions: options.targetOptions,
    templateName: options.templateName || name,
    templateNameMap: options.templateNameMap || null
  });

  return {
    ok: true,
    target
  };
}

module.exports = {
  createTargetDefinition,
  extractTargetName,
  extractTargetOptions,
  parseTarTargetCall
};
