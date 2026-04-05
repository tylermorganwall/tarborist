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
  DIRECT_TARGET_CALLS,
  MAP_CALLS,
  QUARTO_CALLS,
  SELECT_TARGETS_CALLS,
  TARGET_LOAD_CALLS,
  TARGET_LOAD_RAW_CALLS,
  TARGET_READ_CALLS,
  TARGET_READ_RAW_CALLS
} = require("../parser/queries");
const { compareRanges, rangeFromNode, zeroRange } = require("../util/ranges");
const { normalizeFile, pathExists } = require("../util/paths");
const { analyzeFile } = require("./fileRecord");
const { buildPipelineGraph } = require("./graph");
const { resolveFilePathExpression, resolveImportCall } = require("./importResolver");
const { scanQuartoDependencyRefs } = require("./quartoScanner");
const { expandTarMap } = require("./tarMapExpander");
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

function addDiagnostic(state, file, range, severity, message) {
  state.partial = true;
  const fileRecord = state.files.get(file);
  if (fileRecord) {
    fileRecord.diagnostics.push(createDiagnostic(file, range, severity, message));
  }
}

function unwrapExpressionNode(node) {
  if (!node) {
    return null;
  }

  return node.type === "braced_expression" ? node : unwrapNode(node);
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

function resolveTarAssignCall(callNode, env, state, file) {
  const bodyArgument = getNamedArgument(callNode, "targets") || getPositionalArgument(callNode, 0);
  const rawBodyNode = bodyArgument ? getArgumentValue(bodyArgument.node) : null;
  if (!bodyArgument || !rawBodyNode) {
    return makeUnknown(file, rangeFromNode(callNode), "Static pipeline analysis is partial: tar_assign() requires assignment expressions");
  }

  const body = unwrapExpressionNode(rawBodyNode);
  const statements = body && body.type === "braced_expression" ? body.namedChildren || [] : [body];
  const localEnv = new Map(env);
  const items = [];

  for (const statement of statements) {
    const assignment = getLocalAssignmentParts(statement);
    if (!assignment || !assignment.symbolNode) {
      items.push(makeUnknown(file, rangeFromNode(statement || bodyArgument.value), "Static pipeline analysis is partial: tar_assign() requires target factory assignments"));
      continue;
    }

    const resolved = resolveTargetFactoryCall(
      assignment.valueNode,
      localEnv,
      state,
      file,
      assignment.symbol,
      assignment.symbolNode
    );

    localEnv.set(assignment.symbol, resolved);
    items.push(resolved);
  }

  return makeTargetList(items);
}

function resolveTarSelectTargetsCall(callNode, env, state, file) {
  const targetsArgument = getNamedArgument(callNode, "targets") || getPositionalArgument(callNode, 0);
  if (!targetsArgument || !targetsArgument.value) {
    return makeUnknown(file, rangeFromNode(callNode), "Static pipeline analysis is partial: tar_select_targets() requires a target list");
  }

  const resolvedTargets = resolveTopLevelValue(targetsArgument.value, env, state, file);
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
      return makeUnknown(
        file,
        rangeFromNode(argument.value),
        `Static pipeline analysis is partial: could not statically resolve tar_select_targets(): ${selected.reason}`
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

function resolveTarQuartoCall(callNode, env, state, file, forcedName = null, forcedNameNode = null) {
  const { name, nameNode } = resolveFactoryName(callNode, forcedName, forcedNameNode);
  if (!name) {
    return makeUnknown(file, rangeFromNode(callNode), "Static pipeline analysis is partial: could not statically resolve tar_quarto() name");
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

function resolveTarCombineCall(callNode, env, state, file, forcedName = null, forcedNameNode = null) {
  const { name, nameArgument, nameNode } = resolveFactoryName(callNode, forcedName, forcedNameNode);
  if (!name) {
    return makeUnknown(file, rangeFromNode(callNode), "Static pipeline analysis is partial: could not statically resolve tar_combine() name");
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

    const resolved = resolveTopLevelValue(argument.value, env, state, file);
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

function resolvePipedTargetFactoryCall(node, env, state, file, forcedName = null, forcedNameNode = null) {
  if (!forcedName) {
    return null;
  }

  const pipe = getNativePipeParts(node);
  if (!pipe || !pipe.rhs || pipe.rhs.type !== "call") {
    return null;
  }

  if (!matchesCall(pipe.rhs, DIRECT_TARGET_CALLS)) {
    return makeUnknown(
      file,
      rangeFromNode(node),
      "Static pipeline analysis is partial: tar_assign() piped expressions must end in tar_target()"
    );
  }

  const commandArgument = getNamedArgument(pipe.rhs, "command") || getPositionalArgument(pipe.rhs, 0);
  if (commandArgument && !isPlaceholderIdentifier(getArgumentValue(commandArgument.node))) {
    return makeUnknown(
      file,
      rangeFromNode(commandArgument.value || pipe.rhs),
      "Static pipeline analysis is partial: tar_assign() piped tar_target() must use an empty command or command = _"
    );
  }

  const parsed = parseTarTargetCall(pipe.rhs, file, {
    commandNodeOverride: pipe.lhs,
    nameNodeOverride: forcedNameNode,
    nameOverride: forcedName,
    origin: "tar_target"
  });

  if (!parsed.ok) {
    return makeUnknown(file, rangeFromNode(node), `Static pipeline analysis is partial: ${parsed.reason}`);
  }

  return makeTargetObject(parsed.target);
}

function resolveTargetFactoryCall(node, env, state, file, forcedName = null, forcedNameNode = null) {
  const current = unwrapNode(node);
  if (!current || current.type !== "call") {
    const piped = resolvePipedTargetFactoryCall(current, env, state, file, forcedName, forcedNameNode);
    if (piped) {
      return piped;
    }

    return makeUnknown(file, rangeFromNode(current || node), "Static pipeline analysis is partial: unsupported expression in pipeline");
  }

  if (matchesCall(current, DIRECT_TARGET_CALLS)) {
    const parsed = parseTarTargetCall(current, file, {
      nameNodeOverride: forcedNameNode,
      nameOverride: forcedName,
      origin: "tar_target"
    });

    if (!parsed.ok) {
      return makeUnknown(file, rangeFromNode(current), `Static pipeline analysis is partial: ${parsed.reason}`);
    }

    return makeTargetObject(parsed.target);
  }

  if (matchesCall(current, QUARTO_CALLS)) {
    return resolveTarQuartoCall(current, env, state, file, forcedName, forcedNameNode);
  }

  if (matchesCall(current, COMBINE_CALLS)) {
    return resolveTarCombineCall(current, env, state, file, forcedName, forcedNameNode);
  }

  if (matchesCall(current, MAP_CALLS)) {
    const expanded = expandTarMap(current, file);
    for (const diagnostic of expanded.diagnostics || []) {
      addDiagnostic(state, file, diagnostic.range, diagnostic.severity, diagnostic.message);
    }

    if (expanded.kind === "Unknown") {
      return expanded;
    }

    return expanded;
  }

  if (matchesCall(current, ASSIGN_CALLS)) {
    return resolveTarAssignCall(current, env, state, file);
  }

  if (matchesCall(current, SELECT_TARGETS_CALLS)) {
    return resolveTarSelectTargetsCall(current, env, state, file);
  }

  if (matchesCall(current, new Set(["list"]))) {
    return makeTargetList(unpackArguments(current).map((argument) => resolveTopLevelValue(argument.value, env, state, file)));
  }

  return makeUnknown(file, rangeFromNode(current), "Static pipeline analysis is partial: unsupported expression in pipeline");
}

function resolveTopLevelValue(node, env, state, file) {
  // Interpret only the small subset of R constructs that can safely build the
  // pipeline shape without evaluating user code.
  const current = unwrapNode(node);
  if (!current) {
    return makeUnknown(file, zeroRange(), "Static pipeline analysis is partial: unsupported empty expression");
  }

  if (current.type === "identifier") {
    if (current.text === "NULL") {
      return makeTargetList([]);
    }

    return env.get(current.text) || makeUnknown(file, rangeFromNode(current), `Static pipeline analysis is partial: unresolved symbol '${current.text}'`);
  }

  if (current.type === "null") {
    return makeTargetList([]);
  }

  if (current.type !== "call") {
    return makeUnknown(file, rangeFromNode(current), "Static pipeline analysis is partial: unsupported expression in pipeline");
  }

  return resolveTargetFactoryCall(current, env, state, file);
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
    tree: analysis.tree
  };

  record.tree = analysis.tree;
  state.files.set(normalizedFile, record);
  state.inProgress.add(normalizedFile);

  const env = new Map();
  let lastValue = makeUnknown(normalizedFile, zeroRange(), "Static pipeline analysis is partial: file did not evaluate to a pipeline object");

  for (const statement of analysis.statements) {
    if (statement.kind === "assignment") {
      env.set(statement.symbol, resolveTopLevelValue(statement.valueNode, env, state, normalizedFile));
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
    targets: new Map()
  };

  if (!pathExists(rootFile)) {
    return emptyIndex;
  }

  const state = {
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
  for (const diagnostic of buildCycleDiagnostics(targets, graph, state.partial)) {
    const fileRecord = state.files.get(diagnostic.file);
    if (fileRecord) {
      fileRecord.diagnostics.push(diagnostic);
    }
  }

  if (state.partial) {
    const rootDiagnostics = state.files.get(rootFile);
    if (rootDiagnostics) {
      rootDiagnostics.diagnostics.push(createDiagnostic(rootFile, zeroRange(), "information", "Static pipeline analysis is partial."));
    }
  }

  const imports = [];
  for (const fileRecord of state.files.values()) {
    imports.push(...fileRecord.imports);
  }

  return {
    completionRegions: buildCompletionRegions(targets, state.generators),
    files: state.files,
    generators: state.generators,
    graph,
    imports,
    partial: state.partial,
    refs,
    rootFile,
    targets
  };
}

module.exports = {
  buildStaticWorkspaceIndex
};
