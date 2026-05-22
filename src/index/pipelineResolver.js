"use strict";

// Main static evaluator: walk _targets.R and imported files, resolve pipeline
// objects, extract target refs, and assemble the final workspace index.
const path = require("path");

const { createDiagnostic } = require("../diagnostics/unresolvedDiagnostics");
const { buildCycleDiagnostics } = require("../diagnostics/cycleDiagnostics");
const {
  getArgumentValue,
  getNamedArgument,
  getPositionalArgument,
  getShortCallName,
  getStringValue,
  isStringNode,
  matchesCall,
  unpackArguments,
  unwrapNode
} = require("../parser/ast");
const {
  ASSIGN_CALLS,
  COMBINE_CALLS,
  createDirectTargetCalls,
  MAP_CALLS,
  PLAN_CALLS,
  QUARTO_CALLS,
  SELECT_TARGETS_CALLS,
  TARGET_LOAD_CALLS,
  TARGET_LOAD_RAW_CALLS,
  TARGET_READ_CALLS,
  TARGET_READ_RAW_CALLS
} = require("../parser/queries");
const { parseText } = require("../parser/treeSitter");
const { compareRanges, rangeFromNode, zeroRange } = require("../util/ranges");
const { normalizeFile, pathExists, relativeFile } = require("../util/paths");
const { analyzeFile } = require("./fileRecord");
const { buildPipelineGraph } = require("./graph");
const { resolveFilePathExpression, resolveImportCall } = require("./importResolver");
const { scanQuartoDependencyRefs } = require("./quartoScanner");
const { assignStaticTableColumn, resolveStaticTableExpression } = require("./staticTable");
const { expandTarMap } = require("./tarMapExpander");
const { readTargetsMeta, readTargetsProgress } = require("./targetsMeta");
const { evaluateTidyselectNode } = require("./tidyselect");
const { createTargetDefinition, extractTargetName, extractTargetOptions, parseTarTargetCall } = require("./targetFactories");

function makeUnknown(file, range, message, alreadyDiagnosed = false) {
  return {
    kind: "Unknown",
    file,
    range,
    message,
    alreadyDiagnosed
  };
}

function makeTargetList(items) {
  return {
    kind: "TargetList",
    items
  };
}

function makeTargetObject(target) {
  return {
    kind: "TargetObject",
    target
  };
}

function makeStaticTable(rows) {
  return {
    kind: "StaticTable",
    rows
  };
}

function collectConcreteTargets(value) {
  if (!value) {
    return [];
  }

  if (value.kind === "TargetObject") {
    return [value.target];
  }

  if (value.kind === "StaticMap") {
    return value.targets.slice();
  }

  if (value.kind === "TargetList") {
    return value.items.flatMap((item) => collectConcreteTargets(item));
  }

  return [];
}

function buildTargetMap(targets) {
  const map = new Map();
  for (const target of targets) {
    if (!target || map.has(target.name)) {
      continue;
    }

    map.set(target.name, target);
  }

  return map;
}

function collectAvailableTargets(rootRecord) {
  const targets = [];

  if (rootRecord && rootRecord.lastValue) {
    targets.push(...collectConcreteTargets(rootRecord.lastValue));
  }

  if (rootRecord && rootRecord.exportedSymbols) {
    for (const value of rootRecord.exportedSymbols.values()) {
      targets.push(...collectConcreteTargets(value));
    }
  }

  return buildTargetMap(targets);
}

function addDiagnostic(state, file, range, severity, message) {
  state.partial = true;
  const fileRecord = state.files.get(file);
  if (fileRecord) {
    fileRecord.diagnostics.push(createDiagnostic(file, range, severity, message));
  }
}

function withSubpipelineContext(context, subpipeline) {
  if (!subpipeline) {
    return context || {};
  }

  return {
    ...(context || {}),
    subpipeline
  };
}

function withTargetContext(context, targetName) {
  if (!targetName) {
    return context || {};
  }

  return {
    ...(context || {}),
    targetName
  };
}

function addPipelineContext(message, context) {
  const details = [];
  if (context && context.subpipeline) {
    details.push(`sub-pipeline '${context.subpipeline}'`);
  }

  if (context && context.targetName && !message.includes(`target '${context.targetName}'`)) {
    details.push(`target '${context.targetName}'`);
  }

  return details.length ? `${message} (${details.join(", ")})` : message;
}

function makeContextualUnknown(file, range, message, context, alreadyDiagnosed = false) {
  return makeUnknown(file, range, addPipelineContext(message, context), alreadyDiagnosed);
}

function pipelineParseContext(file, phase, range, context, extra = {}) {
  const result = {
    file,
    phase,
    ...extra
  };

  if (range && range.start) {
    result.character = range.start.character;
    result.line = range.start.line + 1;
  }

  if (context && context.subpipeline) {
    result.subpipeline = context.subpipeline;
  }

  if (context && context.targetName) {
    result.target = context.targetName;
  }

  return result;
}

function compareDiagnosticLocations(left, right) {
  if (left.file !== right.file) {
    return left.file.localeCompare(right.file);
  }

  const leftLine = left.range && left.range.start ? left.range.start.line : 0;
  const rightLine = right.range && right.range.start ? right.range.start.line : 0;
  if (leftLine !== rightLine) {
    return leftLine - rightLine;
  }

  const leftCharacter = left.range && left.range.start ? left.range.start.character : 0;
  const rightCharacter = right.range && right.range.start ? right.range.start.character : 0;
  return leftCharacter - rightCharacter;
}

function summarizeDiagnosticMessage(message) {
  if (!message) {
    return "";
  }

  return message.replace(/^Static pipeline analysis is partial:\s*/, "");
}

function buildPartialSummaryDiagnostic(workspaceRoot, rootFile, files) {
  const partialDiagnostics = [];
  for (const record of files.values()) {
    for (const diagnostic of record.diagnostics || []) {
      if (diagnostic.severity !== "warning" && diagnostic.severity !== "information") {
        continue;
      }

      if (diagnostic.file === rootFile && diagnostic.range && diagnostic.range.start && diagnostic.range.start.line === 0 && diagnostic.range.start.character === 0 && diagnostic.message === "Static pipeline analysis is partial.") {
        continue;
      }

      partialDiagnostics.push(diagnostic);
    }
  }

  if (!partialDiagnostics.length) {
    return createDiagnostic(rootFile, zeroRange(), "information", "Static pipeline analysis is partial.");
  }

  partialDiagnostics.sort(compareDiagnosticLocations);
  const preview = partialDiagnostics.slice(0, 6).map((diagnostic) => {
    const line = diagnostic.range && diagnostic.range.start ? diagnostic.range.start.line + 1 : 1;
    return `${relativeFile(workspaceRoot, diagnostic.file)}:${line} ${summarizeDiagnosticMessage(diagnostic.message)}`;
  });
  const remaining = partialDiagnostics.length - preview.length;
  const suffix = remaining > 0 ? `; and ${remaining} more issue${remaining === 1 ? "" : "s"}` : "";
  return createDiagnostic(
    rootFile,
    zeroRange(),
    "information",
    `Static pipeline analysis is partial. Issues: ${preview.join("; ")}${suffix}`
  );
}

function unwrapExpressionNode(node) {
  if (!node) {
    return null;
  }

  return node.type === "braced_expression" ? node : unwrapNode(node);
}

function getListLintRepresentative(node) {
  if (!node) {
    return null;
  }

  if (node.type === "ERROR") {
    return node.namedChildren && node.namedChildren.length
      ? unwrapExpressionNode(node.namedChildren[0])
      : null;
  }

  return unwrapExpressionNode(node);
}

function looksLikePipelineListItem(node) {
  const current = getListLintRepresentative(node);
  if (!current) {
    return false;
  }

  return current.type === "call"
    || current.type === "identifier"
    || current.type === "subset"
    || current.type === "subset2"
    || current.type === "namespace_operator";
}

function addListSyntaxDiagnostics(callNode, state, file, containerLabel = "list()", context = {}) {
  const argumentsNode = callNode && callNode.childForFieldName
    ? callNode.childForFieldName("arguments")
    : null;
  if (!argumentsNode || !argumentsNode.children) {
    return;
  }

  const children = argumentsNode.children.filter((child) => child.type !== "comment");
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type !== "ERROR" || !looksLikePipelineListItem(child)) {
      continue;
    }

    const nextSibling = children.slice(index + 1).find((candidate) => (
      candidate.type !== "," && candidate.type !== "comma" && candidate.type !== "(" && candidate.type !== ")"
    ));
    if (!nextSibling || (nextSibling.type !== "argument" && nextSibling.type !== "ERROR")) {
      continue;
    }

    addDiagnostic(
      state,
      file,
      rangeFromNode(getListLintRepresentative(child) || child),
      "warning",
      addPipelineContext(`Static pipeline analysis is partial: possible missing comma after pipeline item in ${containerLabel}`, context)
    );
  }
}

function isValidPipelineListValue(value) {
  return Boolean(
    value && (
      value.kind === "TargetList"
      || value.kind === "TargetObject"
      || value.kind === "StaticMap"
    )
  );
}

function getPipelineContainerInfoFromNode(node) {
  const current = unwrapNode(node);
  if (!current || current.type !== "call") {
    return null;
  }

  const callName = getShortCallName(current);
  if (callName !== "list" && !PLAN_CALLS.has(callName)) {
    return null;
  }

  return {
    callName
  };
}

function getPipelineArgumentContext(argument, containerLabel, context) {
  const containerInfo = getPipelineContainerInfoFromNode(argument.value);
  if (!containerInfo) {
    return context || {};
  }

  return withSubpipelineContext(
    context,
    argument.name || `${containerLabel} item ${argument.index + 1}`
  );
}

function getAssignmentPipelineContext(valueNode, symbol) {
  return getPipelineContainerInfoFromNode(valueNode)
    ? withSubpipelineContext({}, symbol)
    : {};
}

function resolveListItemValue(argument, env, state, file, containerLabel = "list()", context = {}) {
  const resolved = resolveTopLevelValue(argument.value, env, state, file, context);
  if (isValidPipelineListValue(resolved)) {
    return resolved;
  }

  if (resolved && resolved.kind === "Unknown") {
    const genericUnsupported = resolved.message === "Static pipeline analysis is partial: unsupported expression in pipeline"
      || resolved.message === "Static pipeline analysis is partial: unsupported empty expression";
    if (!genericUnsupported) {
      return resolved;
    }
  }

  const current = unwrapNode(argument.value);
  if (current && current.type === "call") {
    const callName = getShortCallName(current);
    if (callName) {
      return makeContextualUnknown(
        file,
        rangeFromNode(argument.value),
        `Static pipeline analysis is partial: unsupported target factory '${callName}()' in ${containerLabel}; add it to tarborist.additionalSingleTargetFactories if it is single-target and tar_target()-like`,
        context
      );
    }
  }

  return makeContextualUnknown(
    file,
    rangeFromNode(argument.value),
    `Static pipeline analysis is partial: ${containerLabel} pipeline items must be target factories, target objects, or pipeline lists`,
    context
  );
}

function getBinaryOperatorText(node) {
  if (!node || node.type !== "binary_operator") {
    return null;
  }

  const operator = node.childForFieldName ? node.childForFieldName("operator") : null;
  return operator ? operator.text : (node.children || []).find((child) => child.type === "|>" || child.text === "|>")?.text || null;
}

function getLocalAssignmentParts(node) {
  if (!node || node.type !== "binary_operator") {
    return null;
  }

  const lhs = node.childForFieldName ? node.childForFieldName("lhs") : null;
  const rhs = node.childForFieldName ? node.childForFieldName("rhs") : null;
  const operator = node.childForFieldName ? node.childForFieldName("operator") : null;
  const operatorText = operator ? operator.text : (node.children || []).find((child) => (
    child.text === "<-" || child.text === "=" || child.text === "->" || child.text === "->>"
  ))?.text;

  if (!lhs || !rhs || !operatorText) {
    return null;
  }

  if ((operatorText === "<-" || operatorText === "=") && lhs.type === "identifier") {
    return {
      operator: operatorText,
      symbol: lhs.text,
      symbolNode: lhs,
      valueNode: rhs
    };
  }

  if ((operatorText === "->" || operatorText === "->>") && rhs.type === "identifier") {
    return {
      operator: operatorText,
      symbol: rhs.text,
      symbolNode: rhs,
      valueNode: lhs
    };
  }

  return null;
}

function getNativePipeParts(node) {
  if (!node || node.type !== "binary_operator" || getBinaryOperatorText(node) !== "|>") {
    return null;
  }

  const lhs = node.childForFieldName ? node.childForFieldName("lhs") : null;
  const rhs = node.childForFieldName ? node.childForFieldName("rhs") : null;
  if (!lhs || !rhs) {
    return null;
  }

  return {
    lhs: unwrapExpressionNode(lhs),
    rhs: unwrapNode(rhs)
  };
}

function getSubsetParts(node) {
  if (!node || (node.type !== "subset2" && node.type !== "subset")) {
    return null;
  }

  const targetNode = node.namedChildren && node.namedChildren.length ? node.namedChildren[0] : null;
  const argumentsNode = (node.namedChildren || []).find((child) => child.type === "arguments");
  const argumentNode = argumentsNode && argumentsNode.namedChildren
    ? argumentsNode.namedChildren.find((child) => child.type === "argument")
    : null;
  const indexNode = argumentNode ? unwrapNode(getArgumentValue(argumentNode)) : null;

  if (!targetNode || !indexNode) {
    return null;
  }

  return {
    indexNode,
    targetNode: unwrapExpressionNode(targetNode)
  };
}

function readSubsetIndex(node) {
  const current = unwrapNode(node);
  if (!current) {
    return null;
  }

  if (isStringNode(current)) {
    return {
      type: "string",
      value: getStringValue(current)
    };
  }

  if (current.type === "float" && /^\d+$/.test(current.text)) {
    return {
      type: "index",
      value: Number(current.text)
    };
  }

  return null;
}

function resolveSubsetValue(node, env, state, file, context = {}) {
  const parts = getSubsetParts(node);
  if (!parts) {
    return makeContextualUnknown(file, rangeFromNode(node), "Static pipeline analysis is partial: unsupported expression in pipeline", context);
  }

  const containerValue = resolveTopLevelValue(parts.targetNode, env, state, file, context);
  const concreteTargets = collectConcreteTargets(containerValue);
  const indexValue = readSubsetIndex(parts.indexNode);

  if (!indexValue) {
    return makeContextualUnknown(
      file,
      rangeFromNode(parts.indexNode),
      "Static pipeline analysis is partial: could not statically resolve list subset expression",
      context
    );
  }

  if (indexValue.type === "string") {
    const matchedTarget = concreteTargets.find((target) => target.name === indexValue.value);
    return matchedTarget
      ? makeTargetObject(matchedTarget)
      : makeContextualUnknown(
        file,
        rangeFromNode(parts.indexNode),
        `Static pipeline analysis is partial: could not resolve pipeline target '${indexValue.value}' in list subset`,
        context
      );
  }

  const offset = indexValue.value - 1;
  if (offset >= 0 && offset < concreteTargets.length) {
    return makeTargetObject(concreteTargets[offset]);
  }

  return makeContextualUnknown(
    file,
    rangeFromNode(parts.indexNode),
    `Static pipeline analysis is partial: list subset index ${indexValue.value} is out of bounds`,
    context
  );
}

function positionToOffset(text, position) {
  let offset = 0;
  let line = 0;

  while (line < position.line) {
    const nextBreak = text.indexOf("\n", offset);
    if (nextBreak === -1) {
      return text.length;
    }

    offset = nextBreak + 1;
    line += 1;
  }

  return Math.min(text.length, offset + position.character);
}

function offsetToPosition(text, offset) {
  const bounded = Math.max(0, Math.min(text.length, offset));
  let line = 0;
  let lineStart = 0;

  for (let index = 0; index < bounded; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }

  return {
    character: bounded - lineStart,
    line
  };
}

function shiftPosition(basePosition, relativePosition) {
  if (!basePosition || !relativePosition) {
    return relativePosition || zeroRange().start;
  }

  return {
    character: relativePosition.line === 0
      ? basePosition.character + relativePosition.character
      : relativePosition.character,
    line: basePosition.line + relativePosition.line
  };
}

function shiftRange(range, basePosition) {
  if (!range) {
    return null;
  }

  return {
    end: shiftPosition(basePosition, range.end),
    start: shiftPosition(basePosition, range.start)
  };
}

function shiftRecoveredTargetRanges(target, basePosition) {
  return {
    ...target,
    commandRange: shiftRange(target.commandRange, basePosition),
    fullRange: shiftRange(target.fullRange, basePosition),
    nameRange: shiftRange(target.nameRange, basePosition),
    patternRange: shiftRange(target.patternRange, basePosition)
  };
}

function splitDelimitedSegments(text, delimiter = ",") {
  const segments = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = null;
  let escaped = false;
  let inComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inComment) {
      if (character === "\n") {
        inComment = false;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "#" ) {
      inComment = true;
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    if (character === "(") {
      parenDepth += 1;
      continue;
    }

    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (character === "[") {
      bracketDepth += 1;
      continue;
    }

    if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
      continue;
    }

    if (character === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (character === delimiter && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      segments.push({
        end: index,
        start
      });
      start = index + 1;
    }
  }

  segments.push({
    end: text.length,
    start
  });
  return segments;
}

function trimSegmentBounds(text, start, end) {
  let nextStart = start;
  let nextEnd = end;

  while (nextStart < nextEnd && /\s/.test(text[nextStart])) {
    nextStart += 1;
  }

  while (nextEnd > nextStart && /\s/.test(text[nextEnd - 1])) {
    nextEnd -= 1;
  }

  return {
    end: nextEnd,
    start: nextStart
  };
}

function findCallCloseParenIndex(text, openParen) {
  let parenDepth = 0;
  let quote = null;
  let escaped = false;
  let inComment = false;

  for (let index = openParen; index < text.length; index += 1) {
    const character = text[index];

    if (inComment) {
      if (character === "\n") {
        inComment = false;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "#") {
      inComment = true;
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    if (character === "(") {
      parenDepth += 1;
      continue;
    }

    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      if (parenDepth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function splitCallBodySegments(callText, absoluteStartOffset) {
  const openParen = callText.indexOf("(");
  if (openParen === -1) {
    return [];
  }

  const closeParen = findCallCloseParenIndex(callText, openParen);
  const bodyStart = openParen + 1;
  const bodyEnd = closeParen > openParen ? closeParen : callText.length;
  const bodyText = callText.slice(bodyStart, bodyEnd);

  return splitDelimitedSegments(bodyText).map((segment) => {
    const start = bodyStart + segment.start;
    const end = bodyStart + segment.end;
    const trimmed = trimSegmentBounds(callText, start, end);

    return {
      endOffset: absoluteStartOffset + trimmed.end,
      startOffset: absoluteStartOffset + trimmed.start,
      text: callText.slice(trimmed.start, trimmed.end)
    };
  }).filter((segment) => segment.text);
}

function getLeadingCallName(text) {
  const match = text.match(/^\s*([A-Za-z.][A-Za-z0-9._]*(?:::[A-Za-z.][A-Za-z0-9._]*)?)/);
  return match ? match[1] : null;
}

function splitNamedArgumentText(text) {
  const segments = splitDelimitedSegments(text, "=");
  if (segments.length < 2) {
    return null;
  }

  const left = text.slice(segments[0].start, segments[0].end).trim();
  const right = text.slice(segments[1].start, text.length).trim();
  if (!left || !right) {
    return null;
  }

  return {
    name: left,
    value: right
  };
}

function readRecoveredName(text) {
  const trimmed = text.trim();
  if (/^[.A-Za-z][.A-Za-z0-9_]*$/.test(trimmed)) {
    return trimmed;
  }

  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return null;
}

function getSegmentRange(state, file, segment) {
  const fileText = state.readFile(file);
  return {
    end: offsetToPosition(fileText, segment.endOffset),
    start: offsetToPosition(fileText, segment.startOffset)
  };
}

function readRecoveredFactoryTargetName(text) {
  const argumentSegments = splitCallBodySegments(text, 0);
  let nameSegment = null;
  let positionalIndex = 0;

  for (const argumentSegment of argumentSegments) {
    const named = splitNamedArgumentText(argumentSegment.text);
    if (named && named.name === "name") {
      nameSegment = {
        ...argumentSegment,
        text: named.value
      };
      break;
    }

    if (!nameSegment && positionalIndex === 0) {
      nameSegment = argumentSegment;
    }

    if (!named) {
      positionalIndex += 1;
    }
  }

  return nameSegment ? readRecoveredName(nameSegment.text) : null;
}

function isRecoveredPipelineContainerCallName(callName) {
  const shortCallName = getShortCallName(callName);
  return shortCallName === "list"
    || PLAN_CALLS.has(callName)
    || (shortCallName && PLAN_CALLS.has(shortCallName));
}

function getRecoveredPipelineContainerInfo(text) {
  const named = splitNamedArgumentText(text);
  const valueText = named ? named.value : text;
  const callName = getLeadingCallName(valueText);
  if (!callName || !isRecoveredPipelineContainerCallName(callName)) {
    return null;
  }

  return {
    callName: getShortCallName(callName) || callName,
    name: named ? readRecoveredName(named.name) : null,
    valueText
  };
}

function getRecoveredPipelineItemContext(segment, containerCallName, itemIndex, context) {
  const containerInfo = getRecoveredPipelineContainerInfo(segment.text);
  if (!containerInfo) {
    return context || {};
  }

  const displayCallName = containerCallName.endsWith("()") ? containerCallName : `${containerCallName}()`;
  return withSubpipelineContext(
    context,
    containerInfo.name || `${displayCallName} item ${itemIndex + 1}`
  );
}

function recoverMalformedTargetFactoryItem(segment, env, state, file, callName, origin = "tar_target", context = {}) {
  const argumentSegments = splitCallBodySegments(segment.text, segment.startOffset);
  if (!argumentSegments.length) {
    return makeContextualUnknown(
      file,
      getSegmentRange(state, file, segment),
      "Static pipeline analysis is partial: unsupported expression in pipeline",
      context
    );
  }

  let nameSegment = null;
  let commandSegment = null;
  let positionalIndex = 0;
  for (const argumentSegment of argumentSegments) {
    const named = splitNamedArgumentText(argumentSegment.text);
    if (named && named.name === "name") {
      nameSegment = {
        ...argumentSegment,
        text: named.value
      };
      continue;
    }

    if (named && named.name === "command") {
      commandSegment = {
        ...argumentSegment,
        text: named.value
      };
      continue;
    }

    if (!nameSegment && positionalIndex === 0) {
      nameSegment = argumentSegment;
      positionalIndex += 1;
      continue;
    }

    if (!commandSegment && positionalIndex <= 1) {
      commandSegment = argumentSegment;
      positionalIndex += 1;
    }
  }

  const name = nameSegment ? readRecoveredName(nameSegment.text) : null;
  const targetContext = withTargetContext(context, name);
  if (!name || !commandSegment) {
    return makeContextualUnknown(
      file,
      getSegmentRange(state, file, segment),
      `Static pipeline analysis is partial: could not recover malformed ${callName}() target`,
      targetContext
    );
  }

  const target = {
    _analysis: {
      bindings: null,
      commandNode: null,
      externalRefs: [],
      patternNode: null,
      templateName: name,
      templateNameMap: null
    },
    commandRange: {
      end: offsetToPosition(state.readFile(file), commandSegment.endOffset),
      start: offsetToPosition(state.readFile(file), commandSegment.startOffset)
    },
    file,
    fullRange: {
      end: offsetToPosition(state.readFile(file), segment.endOffset),
      start: offsetToPosition(state.readFile(file), segment.startOffset)
    },
    generated: false,
    name,
    nameRange: {
      end: offsetToPosition(state.readFile(file), nameSegment.endOffset),
      start: offsetToPosition(state.readFile(file), nameSegment.startOffset)
    },
    options: {
      cue: null,
      parallel: []
    },
    origin,
    patternRange: null
  };

  addDiagnostic(
    state,
    file,
    target.fullRange,
    "warning",
    addPipelineContext(`Static pipeline analysis is partial: unsupported or incomplete command expression in target '${name}'`, targetContext)
  );
  return makeTargetObject(target);
}

function recoverMalformedPipelineSegment(segment, containerCallName, env, state, file, context = {}) {
  const items = splitCallBodySegments(segment.text, segment.startOffset).map((childSegment, index) => (
    resolveRecoveredPipelineItem(
      childSegment,
      containerCallName,
      env,
      state,
      file,
      getRecoveredPipelineItemContext(childSegment, containerCallName, index, context)
    )
  ));

  return makeTargetList(items);
}

function resolveRecoveredPipelineItem(segment, containerCallName, env, state, file, context = {}) {
  const text = segment.text;
  if (!text) {
    return makeTargetList([]);
  }

  const containerInfo = getRecoveredPipelineContainerInfo(text);
  if (containerInfo) {
    const valueStart = segment.startOffset + text.indexOf(containerInfo.valueText);
    return recoverMalformedPipelineSegment(
      {
        ...segment,
        endOffset: valueStart + containerInfo.valueText.length,
        startOffset: valueStart,
        text: containerInfo.valueText
      },
      containerInfo.callName,
      env,
      state,
      file,
      containerInfo.name ? withSubpipelineContext(context, containerInfo.name) : context
    );
  }

  if (containerCallName !== "list") {
    const named = splitNamedArgumentText(text);
    if (named) {
      const name = readRecoveredName(named.name);
      if (name) {
        const targetContext = withTargetContext(context, name);
        const valueStart = segment.startOffset + text.indexOf(named.value);
        const target = {
          _analysis: {
            bindings: null,
            commandNode: null,
            externalRefs: [],
            patternNode: null,
            templateName: name,
            templateNameMap: null
          },
          commandRange: {
            end: offsetToPosition(state.readFile(file), valueStart + named.value.length),
            start: offsetToPosition(state.readFile(file), valueStart)
          },
          file,
          fullRange: {
            end: offsetToPosition(state.readFile(file), segment.endOffset),
            start: offsetToPosition(state.readFile(file), segment.startOffset)
          },
          generated: false,
          name,
          nameRange: {
            end: offsetToPosition(state.readFile(file), segment.startOffset + text.indexOf(named.name) + named.name.length),
            start: offsetToPosition(state.readFile(file), segment.startOffset + text.indexOf(named.name))
          },
          options: {
            cue: null,
            parallel: []
          },
          origin: "tar_plan",
          patternRange: null
        };

        addDiagnostic(
          state,
          file,
          target.fullRange,
          "warning",
          addPipelineContext(`Static pipeline analysis is partial: unsupported or incomplete command expression in target '${name}'`, targetContext)
        );
        return makeTargetObject(target);
      }
    }
  }

  if (/^[.A-Za-z][.A-Za-z0-9_]*$/.test(text.trim())) {
    return env.get(text.trim()) || makeContextualUnknown(
      file,
      getSegmentRange(state, file, segment),
      `Static pipeline analysis is partial: unresolved symbol '${text.trim()}'`,
      context
    );
  }

  const callName = getLeadingCallName(text);
  const targetName = callName && state.callSets.directTargetCalls.has(getShortCallName(callName))
    ? readRecoveredFactoryTargetName(text)
    : null;
  const itemContext = withTargetContext(context, targetName);
  const segmentRange = getSegmentRange(state, file, segment);
  const parsed = parseText(`${text}\n`, {
    ...pipelineParseContext(file, "recoverPipelineItem", segmentRange, itemContext, {
      pipelineItem: containerCallName
    })
  });
  const rootExpression = (parsed.rootNode.namedChildren || []).find((child) => child.type !== "comment") || null;
  if (rootExpression && rootExpression.type === "call" && matchesCall(rootExpression, state.callSets.directTargetCalls)) {
    const parsedTarget = parseTarTargetCall(rootExpression, file, {
      origin: "tar_target"
    });
    if (parsedTarget.ok) {
      return makeTargetObject(shiftRecoveredTargetRanges(
        parsedTarget.target,
        offsetToPosition(state.readFile(file), segment.startOffset)
      ));
    }
  }

  if (callName && state.callSets.directTargetCalls.has(getShortCallName(callName))) {
    return recoverMalformedTargetFactoryItem(segment, env, state, file, getShortCallName(callName), containerCallName === "list" ? "tar_target" : "tar_plan", itemContext);
  }

  return makeContextualUnknown(
    file,
    segmentRange,
    "Static pipeline analysis is partial: unsupported expression in pipeline",
    context
  );
}

function resolveMalformedPipelineCall(statement, env, state, file, context = {}) {
  const fileText = state.readFile(file);
  const callStart = positionToOffset(fileText, {
    character: statement.calleeNode.startPosition.column,
    line: statement.calleeNode.startPosition.row
  });
  const callEnd = positionToOffset(fileText, {
    character: statement.node.endPosition.column,
    line: statement.node.endPosition.row
  });
  const callText = fileText.slice(callStart, callEnd);
  return recoverMalformedPipelineSegment(
    {
      endOffset: callEnd,
      startOffset: callStart,
      text: callText
    },
    getShortCallName(statement.callName) || statement.callName,
    env,
    state,
    file,
    context
  );
}

function isPlaceholderIdentifier(node) {
  return Boolean(node && unwrapNode(node) && unwrapNode(node).type === "identifier" && unwrapNode(node).text === "_");
}

function resolveFactoryName(callNode, forcedName, forcedNameNode) {
  const nameArgument = getNamedArgument(callNode, "name") || getPositionalArgument(callNode, 0);
  const name = forcedName || extractTargetName(nameArgument && nameArgument.value);
  return {
    name,
    nameArgument,
    nameNode: forcedNameNode || (nameArgument && nameArgument.value) || callNode
  };
}

function resolveTarAssignCall(callNode, env, state, file, context = {}) {
  const bodyArgument = getNamedArgument(callNode, "targets") || getPositionalArgument(callNode, 0);
  const rawBodyNode = bodyArgument ? getArgumentValue(bodyArgument.node) : null;
  if (!bodyArgument || !rawBodyNode) {
    return makeContextualUnknown(file, rangeFromNode(callNode), "Static pipeline analysis is partial: tar_assign() requires assignment expressions", context);
  }

  const body = unwrapExpressionNode(rawBodyNode);
  const statements = body && body.type === "braced_expression"
    ? (body.namedChildren || []).filter((child) => child.type !== "comment")
    : [body];
  const localEnv = new Map(env);
  const items = [];

  for (const statement of statements) {
    const assignment = getLocalAssignmentParts(statement);
    if (!assignment || !assignment.symbolNode) {
      items.push(makeContextualUnknown(file, rangeFromNode(statement || bodyArgument.value), "Static pipeline analysis is partial: tar_assign() requires target factory assignments", context));
      continue;
    }

    const targetContext = withTargetContext(context, assignment.symbol);
    const resolved = resolveTargetFactoryCall(
      assignment.valueNode,
      localEnv,
      state,
      file,
      assignment.symbol,
      assignment.symbolNode,
      targetContext
    );

    localEnv.set(assignment.symbol, resolved);
    items.push(resolved);
  }

  return makeTargetList(items);
}

function resolveTarSelectTargetsCall(callNode, env, state, file, context = {}) {
  const targetsArgument = getNamedArgument(callNode, "targets") || getPositionalArgument(callNode, 0);
  if (!targetsArgument || !targetsArgument.value) {
    return makeContextualUnknown(file, rangeFromNode(callNode), "Static pipeline analysis is partial: tar_select_targets() requires a target list", context);
  }

  const resolvedTargets = resolveTopLevelValue(targetsArgument.value, env, state, file, context);
  const availableTargets = flattenResolvedTargets(resolvedTargets, state);
  const availableNames = availableTargets.map((target) => target.name);
  const availableByName = new Map(availableTargets.map((target) => [target.name, target]));
  const selectorArguments = unpackArguments(callNode).filter((argument) => argument.node !== targetsArgument.node && !argument.name);

  if (!selectorArguments.length) {
    return makeTargetList(availableTargets.map((target) => makeTargetObject(target)));
  }

  const selectedNames = [];
  const seen = new Set();
  for (const argument of selectorArguments) {
    const selected = evaluateTidyselectNode(argument.value, availableNames);
    if (!selected.ok) {
      return makeContextualUnknown(
        file,
        rangeFromNode(argument.value),
        `Static pipeline analysis is partial: could not statically resolve tar_select_targets(): ${selected.reason}`,
        context
      );
    }

    for (const name of selected.names) {
      if (seen.has(name)) {
        continue;
      }

      seen.add(name);
      selectedNames.push(name);
    }
  }

  return makeTargetList(
    selectedNames
      .map((name) => availableByName.get(name))
      .filter(Boolean)
      .map((target) => makeTargetObject(target))
  );
}

function resolveTarPlanNamedTarget(callNode, argument, file, context = {}) {
  const nameNode = argument.node && argument.node.childForFieldName
    ? argument.node.childForFieldName("name")
    : null;
  const rawCommandNode = argument.node ? getArgumentValue(argument.node) : null;
  const name = (nameNode && extractTargetName(nameNode)) || argument.name || null;

  if (!name || !rawCommandNode) {
    return makeContextualUnknown(
      file,
      rangeFromNode(argument.node || callNode),
      "Static pipeline analysis is partial: tar_plan() named entries must use target = command syntax",
      withTargetContext(context, name)
    );
  }

  return makeTargetObject(createTargetDefinition(file, callNode, {
    commandNode: rawCommandNode,
    fullNode: argument.node,
    name,
    nameNode,
    origin: "tar_plan"
  }));
}

function resolveTarPlanCall(callNode, env, state, file, context = {}) {
  addListSyntaxDiagnostics(callNode, state, file, "tar_plan()", context);

  return makeTargetList(
    unpackArguments(callNode).map((argument) => {
      if (argument.name) {
        return resolveTarPlanNamedTarget(callNode, argument, file, withTargetContext(context, argument.name));
      }

      return resolveListItemValue(
        argument,
        env,
        state,
        file,
        "tar_plan()",
        getPipelineArgumentContext(argument, "tar_plan()", context)
      );
    })
  );
}

function resolveTarQuartoCall(callNode, env, state, file, forcedName = null, forcedNameNode = null, context = {}) {
  const { name, nameNode } = resolveFactoryName(callNode, forcedName, forcedNameNode);
  if (!name) {
    return makeContextualUnknown(file, rangeFromNode(callNode), "Static pipeline analysis is partial: could not statically resolve tar_quarto() name", context);
  }

  const pathArgument = getNamedArgument(callNode, "path") || getPositionalArgument(callNode, 1);
  const target = createTargetDefinition(file, callNode, {
    fullNode: callNode,
    name,
    nameNode,
    origin: "tar_quarto",
    targetOptions: extractTargetOptions(callNode)
  });

  if (!pathArgument || !pathArgument.value) {
    addDiagnostic(state, file, rangeFromNode(callNode), "warning", "Could not statically resolve tar_quarto() path expression");
    return makeTargetObject(target);
  }

  const resolved = resolveFilePathExpression(pathArgument.value, file);
  if (!resolved.ok) {
    addDiagnostic(state, file, rangeFromNode(pathArgument.value), "warning", "Could not statically resolve tar_quarto() path expression");
    return makeTargetObject(target);
  }

  const refs = [];
  for (const item of resolved.items) {
    if (!pathExists(item.resolvedPath)) {
      addDiagnostic(state, file, item.range || rangeFromNode(pathArgument.value), "warning", `Could not resolve tar_quarto() path '${item.value}'`);
      continue;
    }

    const scanned = scanQuartoDependencyRefs(item.resolvedPath, state.readFile);
    if (!scanned.files.length) {
      addDiagnostic(state, file, item.range || rangeFromNode(pathArgument.value), "information", `tar_quarto() path '${item.value}' did not resolve to any .qmd or .Rmd files`);
      continue;
    }

    refs.push(...scanned.refs);
  }

  target._analysis.externalRefs = refs;
  return makeTargetObject(target);
}

function resolveTarCombineCall(callNode, env, state, file, forcedName = null, forcedNameNode = null, context = {}) {
  const { name, nameArgument, nameNode } = resolveFactoryName(callNode, forcedName, forcedNameNode);
  if (!name) {
    return makeContextualUnknown(file, rangeFromNode(callNode), "Static pipeline analysis is partial: could not statically resolve tar_combine() name", context);
  }

  const commandArgument = getNamedArgument(callNode, "command");
  const patternArgument = getNamedArgument(callNode, "pattern");
  const rawCommandNode = commandArgument ? getArgumentValue(commandArgument.node) : null;
  const rawPatternNode = patternArgument ? getArgumentValue(patternArgument.node) : null;
  const externalRefs = [];

  for (const argument of unpackArguments(callNode)) {
    if (nameArgument && argument.node === nameArgument.node) {
      continue;
    }

    if (argument.name) {
      continue;
    }

    const resolved = resolveTopLevelValue(argument.value, env, state, file, withTargetContext(context, name));
    for (const upstreamTarget of flattenResolvedTargets(resolved, state)) {
      externalRefs.push({
        context: "command",
        file,
        range: rangeFromNode(argument.value),
        synthetic: true,
        targetName: upstreamTarget.name
      });
    }
  }

  const target = createTargetDefinition(file, callNode, {
    commandNode: rawCommandNode,
    externalRefs,
    fullNode: callNode,
    name,
    nameNode,
    origin: "tar_combine",
    patternNode: rawPatternNode,
    targetOptions: extractTargetOptions(callNode)
  });

  return makeTargetObject(target);
}

function resolvePipedTargetFactoryCall(node, env, state, file, forcedName = null, forcedNameNode = null, context = {}) {
  if (!forcedName) {
    return null;
  }

  const pipe = getNativePipeParts(node);
  if (!pipe || !pipe.rhs || pipe.rhs.type !== "call") {
    return null;
  }

  if (!matchesCall(pipe.rhs, state.callSets.directTargetCalls)) {
    return makeContextualUnknown(
      file,
      rangeFromNode(node),
      "Static pipeline analysis is partial: tar_assign() piped expressions must end in tar_target()/target-like factory",
      context
    );
  }

  const commandArgument = getNamedArgument(pipe.rhs, "command") || getPositionalArgument(pipe.rhs, 0);
  if (commandArgument && !isPlaceholderIdentifier(getArgumentValue(commandArgument.node))) {
    return makeContextualUnknown(
      file,
      rangeFromNode(commandArgument.value || pipe.rhs),
      "Static pipeline analysis is partial: piped tar_target()/target-like factory calls must use an empty command or command = _",
      context
    );
  }

  const parsed = parseTarTargetCall(pipe.rhs, file, {
    commandNodeOverride: pipe.lhs,
    nameNodeOverride: forcedNameNode,
    nameOverride: forcedName,
    origin: "tar_target"
  });

  if (!parsed.ok) {
    return makeContextualUnknown(file, rangeFromNode(node), `Static pipeline analysis is partial: ${parsed.reason}`, context);
  }

  return makeTargetObject(parsed.target);
}

function resolveTargetFactoryCall(node, env, state, file, forcedName = null, forcedNameNode = null, context = {}) {
  const current = unwrapNode(node);
  if (!current || current.type !== "call") {
    const piped = resolvePipedTargetFactoryCall(current, env, state, file, forcedName, forcedNameNode, context);
    if (piped) {
      return piped;
    }

    return makeContextualUnknown(file, rangeFromNode(current || node), "Static pipeline analysis is partial: unsupported expression in pipeline", context);
  }

  if (matchesCall(current, state.callSets.directTargetCalls)) {
    const targetNameContext = withTargetContext(context, resolveFactoryName(current, forcedName, forcedNameNode).name);
    const parsed = parseTarTargetCall(current, file, {
      nameNodeOverride: forcedNameNode,
      nameOverride: forcedName,
      origin: "tar_target"
    });

    if (!parsed.ok) {
      return makeContextualUnknown(file, rangeFromNode(current), `Static pipeline analysis is partial: ${parsed.reason}`, targetNameContext);
    }

    return makeTargetObject(parsed.target);
  }

  if (matchesCall(current, QUARTO_CALLS)) {
    return resolveTarQuartoCall(current, env, state, file, forcedName, forcedNameNode, context);
  }

  if (matchesCall(current, COMBINE_CALLS)) {
    return resolveTarCombineCall(current, env, state, file, forcedName, forcedNameNode, context);
  }

  if (matchesCall(current, MAP_CALLS)) {
    const expanded = expandTarMap(current, file, env, state.callSets.directTargetCalls);
    for (const diagnostic of expanded.diagnostics || []) {
      addDiagnostic(state, file, diagnostic.range, diagnostic.severity, diagnostic.message);
    }

    if (expanded.kind === "Unknown") {
      return expanded;
    }

    return expanded;
  }

  if (matchesCall(current, ASSIGN_CALLS)) {
    return resolveTarAssignCall(current, env, state, file, context);
  }

  if (matchesCall(current, SELECT_TARGETS_CALLS)) {
    return resolveTarSelectTargetsCall(current, env, state, file, context);
  }

  if (matchesCall(current, PLAN_CALLS)) {
    return resolveTarPlanCall(current, env, state, file, context);
  }

  if (matchesCall(current, new Set(["list"]))) {
    addListSyntaxDiagnostics(current, state, file, "list()", context);
    return makeTargetList(unpackArguments(current).map((argument) => (
      resolveListItemValue(
        argument,
        env,
        state,
        file,
        "list()",
        getPipelineArgumentContext(argument, "list()", context)
      )
    )));
  }

  return makeContextualUnknown(file, rangeFromNode(current), "Static pipeline analysis is partial: unsupported expression in pipeline", context);
}

function resolveTopLevelValue(node, env, state, file, context = {}) {
  // Interpret only the small subset of R constructs that can safely build the
  // pipeline shape without evaluating user code.
  const current = unwrapNode(node);
  if (!current) {
    return makeContextualUnknown(file, zeroRange(), "Static pipeline analysis is partial: unsupported empty expression", context);
  }

  if (current.type === "identifier") {
    if (current.text === "NULL") {
      return makeTargetList([]);
    }

    return env.get(current.text) || makeContextualUnknown(file, rangeFromNode(current), `Static pipeline analysis is partial: unresolved symbol '${current.text}'`, context);
  }

  if (current.type === "null") {
    return makeTargetList([]);
  }

  if (current.type === "subset2" || current.type === "subset") {
    return resolveSubsetValue(current, env, state, file, context);
  }

  if (current.type !== "call") {
    return makeContextualUnknown(file, rangeFromNode(current), "Static pipeline analysis is partial: unsupported expression in pipeline", context);
  }

  const staticTable = resolveStaticTableExpression(current, env);
  if (staticTable) {
    return makeStaticTable(staticTable.rows);
  }

  return resolveTargetFactoryCall(current, env, state, file, null, null, context);
}

function flattenResolvedTargets(value, state) {
  // Pipeline objects can nest lists, aliases, and tar_map() expansions; flatten
  // everything down to concrete target defs before building the graph.
  if (!value) {
    return [];
  }

  if (value.kind === "TargetObject") {
    return [value.target];
  }

  if (value.kind === "StaticMap") {
    if (value.preview) {
      state.generators.push(value.preview);
    }
    return value.targets.slice();
  }

  if (value.kind === "TargetList") {
    return value.items.flatMap((item) => flattenResolvedTargets(item, state));
  }

  if (value.kind === "Unknown" && !value.alreadyDiagnosed) {
    addDiagnostic(state, value.file, value.range, "warning", value.message);
  }

  return [];
}

function isPipelineLikeValue(value) {
  return Boolean(
    value &&
    (value.kind === "TargetList" || value.kind === "TargetObject" || value.kind === "StaticMap")
  );
}

function isReferenceLike(node) {
  if (!node || node.type !== "identifier") {
    return false;
  }

  const parent = node.parent;
  if (!parent) {
    return true;
  }

  if (parent.type === "argument") {
    const nameNode = parent.childForFieldName ? parent.childForFieldName("name") : null;
    if (nameNode === node) {
      return false;
    }
  }

  if (parent.type === "binary_operator") {
    const lhs = parent.childForFieldName ? parent.childForFieldName("lhs") : null;
    const operatorNode = parent.childForFieldName ? parent.childForFieldName("operator") : null;
    if (lhs === node && operatorNode && (operatorNode.text === "<-" || operatorNode.text === "=")) {
      return false;
    }
  }

  if (parent.type === "call") {
    const functionNode = parent.childForFieldName ? parent.childForFieldName("function") : null;
    if (functionNode === node) {
      return false;
    }
  }

  if (parent.type === "namespace_operator" || parent.type === "parameter" || parent.type === "parameters") {
    return false;
  }

  return true;
}

function createRef(target, file, range, targetName, context, synthetic) {
  return {
    context,
    enclosingTarget: target.name,
    file,
    range,
    synthetic: Boolean(synthetic),
    targetName
  };
}

function collectCallArgumentRef(target, argNode, context, knownTargets, refs, syntheticFromBinding = false, localBindings = new Set()) {
  const current = unwrapNode(argNode);
  if (!current) {
    return;
  }

  const templateNameMap = target._analysis.templateNameMap || {};
  // tar_read()/tar_load() and raw variants treat their first argument as an
  // explicit target reference even when it is a string literal.
  if (current.type === "identifier") {
    if (localBindings.has(current.text)) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(templateNameMap, current.text)) {
      const mappedName = templateNameMap[current.text];
      if (knownTargets.has(mappedName)) {
        refs.push(createRef(target, target.file, rangeFromNode(current), mappedName, context, true));
      }
      return;
    }

    const binding = target._analysis.bindings && target._analysis.bindings[current.text];
    if (binding) {
      if ((binding.kind === "symbol" || binding.kind === "string" || binding.kind === "literal") && knownTargets.has(binding.preview)) {
        refs.push(createRef(target, target.file, rangeFromNode(current), binding.preview, context, true));
      }
      return;
    }

    if (knownTargets.has(current.text)) {
      refs.push(createRef(target, target.file, rangeFromNode(current), current.text, context, syntheticFromBinding));
    }
    return;
  }

  if (isStringNode(current)) {
    const targetName = getStringValue(current);
    if (knownTargets.has(targetName)) {
      refs.push(createRef(target, target.file, rangeFromNode(current), targetName, context, syntheticFromBinding));
    }
  }
}

function extractRefsFromExpression(target, node, defaultContext, knownTargets, refs, bindingStack = new Set(), localBindings = new Set()) {
  // Walk target command/pattern ASTs and record only names that are known
  // pipeline targets after accounting for local shadowing and tar_map bindings.
  const current = unwrapExpressionNode(node);
  if (!current) {
    return;
  }

  if (current.type === "braced_expression") {
    // Braced commands create a local scope where earlier assignments can shadow
    // target names later in the same target body.
    const scopedBindings = new Set(localBindings);
    for (const child of current.namedChildren || []) {
      const assignment = getLocalAssignmentParts(child);
      if (assignment) {
        extractRefsFromExpression(target, assignment.valueNode, defaultContext, knownTargets, refs, bindingStack, scopedBindings);
        scopedBindings.add(assignment.symbol);
        continue;
      }

      extractRefsFromExpression(target, child, defaultContext, knownTargets, refs, bindingStack, scopedBindings);
    }
    return;
  }

  const localAssignment = getLocalAssignmentParts(current);
  if (localAssignment) {
    extractRefsFromExpression(target, localAssignment.valueNode, defaultContext, knownTargets, refs, bindingStack, localBindings);
    return;
  }

  if (current.type === "call") {
    const shortCallName = getShortCallName(current);
    const firstArgument = getPositionalArgument(current, 0);
    if (shortCallName && (TARGET_READ_CALLS.has(shortCallName) || TARGET_LOAD_CALLS.has(shortCallName) || TARGET_READ_RAW_CALLS.has(shortCallName) || TARGET_LOAD_RAW_CALLS.has(shortCallName))) {
      const context = shortCallName.endsWith("_raw")
        ? (shortCallName.startsWith("tar_read") ? "tar_read_raw" : "tar_load_raw")
        : (shortCallName.startsWith("tar_read") ? "tar_read" : "tar_load");

      if (firstArgument && firstArgument.value) {
        collectCallArgumentRef(target, firstArgument.value, context, knownTargets, refs, false, localBindings);
      }

      for (const argument of unpackArguments(current)) {
        if (firstArgument && argument.node === firstArgument.node) {
          continue;
        }

        extractRefsFromExpression(target, argument.value, defaultContext, knownTargets, refs, bindingStack, localBindings);
      }
      return;
    }
  }

  if (current.type === "identifier") {
    if (!isReferenceLike(current)) {
      return;
    }

    if (localBindings.has(current.text)) {
      return;
    }

    const templateNameMap = target._analysis.templateNameMap || {};
    if (Object.prototype.hasOwnProperty.call(templateNameMap, current.text)) {
      const mappedName = templateNameMap[current.text];
      if (knownTargets.has(mappedName)) {
        refs.push(createRef(target, target.file, rangeFromNode(current), mappedName, defaultContext, true));
      }
      return;
    }

    const binding = target._analysis.bindings && target._analysis.bindings[current.text];
    if (binding) {
      if (bindingStack.has(current.text)) {
        return;
      }

      if ((binding.kind === "symbol" || binding.kind === "string" || binding.kind === "literal") && knownTargets.has(binding.preview)) {
        refs.push(createRef(target, target.file, rangeFromNode(current), binding.preview, defaultContext, true));
        return;
      }

      if (binding.node) {
        bindingStack.add(current.text);
        extractRefsFromExpression(target, binding.node, defaultContext, knownTargets, refs, bindingStack, localBindings);
        bindingStack.delete(current.text);
        return;
      }
    }

    if (knownTargets.has(current.text)) {
      refs.push(createRef(target, target.file, rangeFromNode(current), current.text, defaultContext, false));
    }

    return;
  }

  for (const child of current.namedChildren || []) {
    extractRefsFromExpression(target, child, defaultContext, knownTargets, refs, bindingStack, localBindings);
  }
}

function dedupeRefs(refs) {
  const seen = new Set();
  const deduped = [];

  for (const ref of refs) {
    const key = [
      ref.file,
      ref.range.start.line,
      ref.range.start.character,
      ref.range.end.line,
      ref.range.end.character,
      ref.targetName,
      ref.enclosingTarget,
      ref.context,
      ref.synthetic ? "1" : "0"
    ].join(":");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(ref);
  }

  return deduped;
}

function extractTargetRefs(targets) {
  const knownTargets = new Map(targets);
  const refs = [];

  for (const target of targets.values()) {
    for (const externalRef of target._analysis.externalRefs || []) {
      if (!knownTargets.has(externalRef.targetName)) {
        continue;
      }

      refs.push({
        context: externalRef.context || "command",
        enclosingTarget: target.name,
        file: externalRef.file || target.file,
        range: externalRef.range || target.nameRange,
        synthetic: Boolean(externalRef.synthetic),
        targetName: externalRef.targetName
      });
    }

    if (target._analysis.commandNode) {
      extractRefsFromExpression(target, target._analysis.commandNode, "command", knownTargets, refs);
    }

    if (target._analysis.patternNode) {
      extractRefsFromExpression(target, target._analysis.patternNode, "pattern", knownTargets, refs);
    }
  }

  return dedupeRefs(refs);
}

function executeFile(file, state) {
  // Files are executed in a static sense: replay top-level statements, merge
  // imported symbols into the local environment, and remember the final value.
  const normalizedFile = normalizeFile(file);

  const existing = state.files.get(normalizedFile);
  if (existing && existing.executed) {
    return existing;
  }

  if (state.inProgress.has(normalizedFile)) {
    const placeholder = existing || {
      diagnostics: [],
      executed: true,
      exportedSymbols: new Map(),
      file: normalizedFile,
      imports: [],
      importLinks: [],
      lastValue: makeUnknown(normalizedFile, zeroRange(), `Static pipeline analysis is partial: recursive import involving '${path.basename(normalizedFile)}'`, true),
      text: "",
      tree: null
    };
    if (!existing) {
      state.files.set(normalizedFile, placeholder);
    }
    addDiagnostic(state, normalizedFile, zeroRange(), "warning", `Static pipeline analysis is partial: recursive import involving '${path.basename(normalizedFile)}'`);
    return placeholder;
  }

  const text = state.readFile(normalizedFile);
  const analysis = analyzeFile(normalizedFile, text);
  const record = existing || {
    diagnostics: [],
    executed: false,
    exportedSymbols: new Map(),
    file: normalizedFile,
    imports: [],
    importLinks: [],
    lastValue: makeUnknown(normalizedFile, zeroRange(), "Static pipeline analysis is partial: file did not evaluate to a pipeline object"),
    text: analysis.text,
    tree: analysis.tree
  };

  record.text = analysis.text;
  record.tree = analysis.tree;
  state.files.set(normalizedFile, record);
  state.inProgress.add(normalizedFile);

  const env = new Map();
  let lastValue = makeUnknown(normalizedFile, zeroRange(), "Static pipeline analysis is partial: file did not evaluate to a pipeline object");

  for (const statement of analysis.statements) {
    if (statement.kind === "assignment") {
      const resolved = resolveTopLevelValue(
        statement.valueNode,
        env,
        state,
        normalizedFile,
        getAssignmentPipelineContext(statement.valueNode, statement.symbol)
      );
      env.set(statement.symbol, resolved);
      if (isPipelineLikeValue(resolved)) {
        lastValue = resolved;
      }
      continue;
    }

    if (statement.kind === "malformedPipelineAssignment") {
      const resolved = resolveMalformedPipelineCall(
        statement,
        env,
        state,
        normalizedFile,
        withSubpipelineContext({}, statement.symbol)
      );
      env.set(statement.symbol, resolved);
      if (isPipelineLikeValue(resolved)) {
        lastValue = resolved;
      }
      continue;
    }

    if (statement.kind === "columnAssignment") {
      const existingValue = env.get(statement.symbol);
      const updatedValue = assignStaticTableColumn(existingValue, statement.columnName, statement.valueNode);
      if (updatedValue) {
        env.set(statement.symbol, makeStaticTable(updatedValue.rows));
      }
      continue;
    }

    if (statement.kind === "import") {
      const resolution = resolveImportCall(statement.node, normalizedFile);
      record.importLinks.push(...resolution.links);
      record.imports.push(...resolution.imports);
      for (const diagnostic of resolution.diagnostics) {
        addDiagnostic(state, normalizedFile, diagnostic.range, diagnostic.severity, diagnostic.message);
      }

      // Imported files contribute exported symbols that later expressions in the
      // current file can reference, just like source() would at runtime.
      for (const edge of resolution.imports) {
        const importedRecord = executeFile(edge.toFile, state);
        for (const [symbol, value] of importedRecord.exportedSymbols.entries()) {
          env.set(symbol, value);
        }
      }
      continue;
    }

    if (statement.kind === "malformedPipelineCall") {
      lastValue = resolveMalformedPipelineCall(statement, env, state, normalizedFile);
      continue;
    }

    lastValue = resolveTopLevelValue(statement.node, env, state, normalizedFile);
  }

  record.executed = true;
  record.exportedSymbols = new Map(env);
  record.lastValue = lastValue;
  state.inProgress.delete(normalizedFile);
  return record;
}

function buildCompletionRegions(targets, generators) {
  // Completions are only enabled inside target command/pattern expressions, plus
  // template regions originating from statically expanded tar_map() calls.
  const regions = [];

  for (const target of targets.values()) {
    if (target.generated) {
      continue;
    }

    if (target.commandRange) {
      regions.push({
        enclosingTargets: [target.name],
        file: target.file,
        generated: false,
        kind: "command",
        range: target.commandRange
      });
    }

    if (target.patternRange) {
      regions.push({
        enclosingTargets: [target.name],
        file: target.file,
        generated: false,
        kind: "pattern",
        range: target.patternRange
      });
    }
  }

  for (const generator of generators) {
    const templateGeneratedNames = Object.fromEntries(
      (generator.templates || []).map((template) => [template.templateName, template.generatedNames.slice()])
    );

    for (const template of generator.templates || []) {
      if (template.commandRange) {
        regions.push({
          enclosingTargets: template.generatedNames.slice(),
          file: generator.file,
          generated: true,
          kind: "command",
          range: template.commandRange,
          templateGeneratedNames,
          templateName: template.templateName
        });
      }

      if (template.patternRange) {
        regions.push({
          enclosingTargets: template.generatedNames.slice(),
          file: generator.file,
          generated: true,
          kind: "pattern",
          range: template.patternRange,
          templateGeneratedNames,
          templateName: template.templateName
        });
      }
    }
  }

  return regions.sort((left, right) => compareRanges(left.range, right.range));
}

function buildStaticWorkspaceIndex(options) {
  // Build one whole-pipeline snapshot rooted at workspaceRoot/_targets.R.
  const workspaceRoot = normalizeFile(options.workspaceRoot);
  const rootFile = normalizeFile(path.join(workspaceRoot, "_targets.R"));
  const emptyIndex = {
    completionRegions: [],
    files: new Map(),
    generators: [],
    graph: buildPipelineGraph(new Map(), []),
    imports: [],
    partial: false,
    refs: [],
    rootFile,
    targetsMeta: new Map(),
    targetsProgress: new Map(),
    targets: new Map()
  };

  if (!pathExists(rootFile)) {
    return emptyIndex;
  }

  const state = {
    callSets: {
      directTargetCalls: createDirectTargetCalls(options.additionalSingleTargetFactories)
    },
    files: new Map(),
    generators: [],
    inProgress: new Set(),
    partial: false,
    readFile: options.readFile
  };

  const rootRecord = executeFile(rootFile, state);
  const targetList = flattenResolvedTargets(rootRecord.lastValue, state);
  const targets = new Map();

  for (const target of targetList) {
    if (targets.has(target.name)) {
      addDiagnostic(state, target.file, target.nameRange, "warning", `Static pipeline analysis is partial: duplicate target '${target.name}'`);
      continue;
    }

    targets.set(target.name, target);
  }

  // Resolve edges only after all target names are known so refs can be filtered
  // against the actual pipeline target set.
  const refs = extractTargetRefs(targets);
  const graph = buildPipelineGraph(targets, refs);
  const completionTargets = collectAvailableTargets(rootRecord);
  const completionRefs = extractTargetRefs(completionTargets);
  const completionGraph = buildPipelineGraph(completionTargets, completionRefs);
  for (const diagnostic of buildCycleDiagnostics(targets, graph, state.partial)) {
    const fileRecord = state.files.get(diagnostic.file);
    if (fileRecord) {
      fileRecord.diagnostics.push(diagnostic);
    }
  }

  if (state.partial) {
    const rootDiagnostics = state.files.get(rootFile);
    if (rootDiagnostics) {
      rootDiagnostics.diagnostics.push(buildPartialSummaryDiagnostic(workspaceRoot, rootFile, state.files));
    }
  }

  const imports = [];
  for (const fileRecord of state.files.values()) {
    imports.push(...fileRecord.imports);
  }

  return {
    completionGraph,
    completionRefs,
    completionRegions: buildCompletionRegions(completionTargets, state.generators),
    completionTargets,
    files: state.files,
    generators: state.generators,
    graph,
    imports,
    partial: state.partial,
    refs,
    rootFile,
    targetsMeta: readTargetsMeta(workspaceRoot, options.readFile, completionTargets),
    targetsProgress: readTargetsProgress(workspaceRoot, options.readFile, completionTargets),
    targets
  };
}

module.exports = {
  buildStaticWorkspaceIndex
};
