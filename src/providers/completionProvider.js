"use strict";

// Pipeline-scoped completion provider with DAG-aware filtering.
const vscode = require("vscode");

const {
  findAncestor,
  findNodeAt,
  getNamedArgument,
  getPositionalArgument,
  getShortCallName,
  isCommentNode,
  isStringNode,
  matchesCall
} = require("../parser/ast");
const { parseText } = require("../parser/treeSitter");
const {
  COMBINE_CALLS,
  createDirectTargetCalls,
  MAP_CALLS,
  QUARTO_CALLS,
  TARGET_LOAD_CALLS,
  TARGET_LOAD_RAW_CALLS,
  TARGET_READ_CALLS,
  TARGET_READ_RAW_CALLS
} = require("../parser/queries");
const { extractTargetName } = require("../index/targetFactories");
const { formatLocation, normalizeFile } = require("../util/paths");
const { comparePositions, containsPosition, rangeFromNode } = require("../util/ranges");
const { toVsCodeRange } = require("../util/vscode");
const { findCompletionRegion } = require("./shared");
const TAR_MAP_TEMPLATE_COMPLETION_MIN_PREFIX = 3;
const TARGET_COMPLETION_MIN_PREFIX = 3;
const TRIGGER_KIND_INVOKE = 0;
const TRIGGER_KIND_TRIGGER_CHARACTER = 1;

function buildAncestorDistanceMap(graph, enclosingTargets) {
  // Rank nearby upstream targets ahead of distant ones.
  const distances = new Map();
  const queue = enclosingTargets.map((name) => ({ distance: 0, name }));
  const seen = new Set(enclosingTargets);

  while (queue.length) {
    const current = queue.shift();
    for (const upstream of graph.downstreamToUpstream.get(current.name) || []) {
      if (seen.has(upstream)) {
        continue;
      }

      seen.add(upstream);
      distances.set(upstream, current.distance + 1);
      queue.push({
        distance: current.distance + 1,
        name: upstream
      });
    }
  }

  return distances;
}

function getCompletionTargets(index) {
  return index.completionTargets || index.targets || new Map();
}

function getCompletionGraph(index) {
  return index.completionGraph || index.graph;
}

function extractPrefix(document, position) {
  const line = document.lineAt(position.line).text.slice(0, position.character);
  const match = line.match(/[A-Za-z0-9_.]+$/);
  return match ? match[0] : "";
}

function buildProviderParseContext(document, position, phase) {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z.][A-Za-z0-9._]*/);
  const lineText = document.lineAt(position.line).text;
  return {
    character: position.character,
    file: document.uri.fsPath,
    line: position.line + 1,
    linePreview: lineText.trim().slice(0, 200),
    phase,
    word: wordRange ? document.getText(wordRange) : ""
  };
}

function prefixScoreForName(name, prefix) {
  if (!prefix) {
    return 0;
  }

  const lowered = name.toLowerCase();
  if (lowered.startsWith(prefix)) {
    return 0;
  }

  return lowered.includes(prefix) ? 1 : 2;
}

function buildIncompleteCompletionList() {
  if (typeof vscode.CompletionList === "function") {
    return new vscode.CompletionList([], true);
  }

  return {
    isIncomplete: true,
    items: []
  };
}

function shouldDelayTargetCompletions(region, prefix) {
  if (region.generated) {
    return prefix.length < TAR_MAP_TEMPLATE_COMPLETION_MIN_PREFIX;
  }

  return prefix.length < TARGET_COMPLETION_MIN_PREFIX;
}

function findCallArgumentContext(node, position, callNames) {
  let current = node;
  while (current) {
    if (current.type === "call" && matchesCall(current, callNames)) {
      const argumentsNode = current.childForFieldName ? current.childForFieldName("arguments") : null;
      const firstArgument = getPositionalArgument(current, 0);
      const secondArgument = getPositionalArgument(current, 1);

      if (firstArgument && firstArgument.value && containsPosition(rangeFromNode(firstArgument.value), position)) {
        return {
          matched: true,
          replaceRange: isStringNode(firstArgument.value) || firstArgument.value.type === "identifier"
            ? rangeFromNode(firstArgument.value)
            : null
        };
      }

      if (argumentsNode && containsPosition(rangeFromNode(argumentsNode), position)) {
        if (secondArgument && secondArgument.value) {
          const secondStart = rangeFromNode(secondArgument.value).start;
          if (comparePositions(position, secondStart) >= 0) {
            current = current.parent;
            continue;
          }
        }

        return {
          matched: true,
          replaceRange: null
        };
      }
    }

    current = current.parent;
  }

  return {
    matched: false,
    replaceRange: null
  };
}

function determineInsertContext(document, position) {
  // Completions insert strings inside raw APIs and bare symbols everywhere else.
  const tree = parseText(document.getText(), buildProviderParseContext(document, position, "completionProvider"));
  const point = {
    character: position.character,
    line: position.line
  };
  const node = findNodeAt(tree.rootNode, point);

  if (!node || isCommentNode(node)) {
    return null;
  }

  const rawContext = findCallArgumentContext(node, point, new Set([
    ...TARGET_READ_RAW_CALLS,
    ...TARGET_LOAD_RAW_CALLS
  ]));
  if (rawContext.matched) {
    return {
      mode: "raw",
      replaceRange: rawContext.replaceRange
    };
  }

  const symbolContext = findCallArgumentContext(node, point, new Set([
    ...TARGET_READ_CALLS,
    ...TARGET_LOAD_CALLS
  ]));
  if (symbolContext.matched) {
    return {
      mode: "symbol",
      replaceRange: symbolContext.replaceRange
    };
  }

  if (isStringNode(node)) {
    return null;
  }

  return {
    mode: "symbol",
    replaceRange: null
  };
}

function getConfiguredDirectTargetCalls() {
  const config = vscode.workspace.getConfiguration("tarborist");
  const configuredFactories = config.get("additionalSingleTargetFactories", []);
  return createDirectTargetCalls(Array.isArray(configuredFactories) ? configuredFactories : []);
}

function getFactoryArguments(callNode) {
  const explicitNameArgument = getNamedArgument(callNode, "name");
  const positionalZero = getPositionalArgument(callNode, 0);
  const positionalOne = getPositionalArgument(callNode, 1);
  const hasImplicitName = !explicitNameArgument && Boolean(positionalOne);

  return {
    commandArgument: getNamedArgument(callNode, "command") || (hasImplicitName ? positionalOne : positionalZero),
    explicitNameArgument: explicitNameArgument || (hasImplicitName ? positionalZero : null),
    patternArgument: getNamedArgument(callNode, "pattern")
  };
}

function getAssignedFactoryName(callNode) {
  let current = callNode;
  while (current && current.parent) {
    const parent = current.parent;
    if (parent.type === "binary_operator") {
      const lhs = parent.childForFieldName ? parent.childForFieldName("lhs") : null;
      const rhs = parent.childForFieldName ? parent.childForFieldName("rhs") : null;
      const operator = parent.childForFieldName ? parent.childForFieldName("operator") : null;
      const operatorText = operator ? operator.text : null;

      if ((operatorText === "<-" || operatorText === "=") && rhs === current && lhs && lhs.type === "identifier") {
        return lhs.text;
      }

      if ((operatorText === "->" || operatorText === "->>") && lhs === current && rhs && rhs.type === "identifier") {
        return rhs.text;
      }
    }

    if (parent.type === "program" || parent.type === "braced_expression") {
      break;
    }

    current = parent;
  }

  return null;
}

function pickClosestRegion(matches, liveRange) {
  if (!matches.length) {
    return null;
  }

  return matches.sort((left, right) => {
    const leftDistance = Math.abs(left.range.start.line - liveRange.start.line) * 1000
      + Math.abs(left.range.start.character - liveRange.start.character);
    const rightDistance = Math.abs(right.range.start.line - liveRange.start.line) * 1000
      + Math.abs(right.range.start.character - liveRange.start.character);
    return leftDistance - rightDistance;
  })[0];
}

function buildLiveRegionFromIndexedMatch(index, file, liveRange, kind, targetName, generated) {
  const completionTargets = getCompletionTargets(index);
  if (generated) {
    const generatedMatches = (index.completionRegions || []).filter((region) => (
      region.file === file &&
      region.generated &&
      region.kind === kind &&
      region.templateName === targetName
    ));
    const matchedGeneratedRegion = pickClosestRegion(generatedMatches, liveRange);
    if (matchedGeneratedRegion) {
      return {
        ...matchedGeneratedRegion,
        range: liveRange
      };
    }
  }

  const matchedTarget = completionTargets.get(targetName);
  return {
    enclosingTargets: matchedTarget ? [matchedTarget.name] : [targetName],
    file,
    generated: false,
    kind,
    range: liveRange
  };
}

function resolveLiveCompletionRegion(index, document, position) {
  const file = normalizeFile(document.uri.fsPath);
  const point = {
    character: position.character,
    line: position.line
  };
  const indexedRegion = findCompletionRegion(index, file, point);
  if (indexedRegion) {
    return indexedRegion;
  }

  const tree = parseText(document.getText(), buildProviderParseContext(document, position, "completionProvider"));
  const node = findNodeAt(tree.rootNode, point);
  if (!node || isCommentNode(node)) {
    return null;
  }

  const directTargetCalls = getConfiguredDirectTargetCalls();
  const factoryCall = findAncestor(node, (candidate) => {
    if (!candidate || candidate.type !== "call") {
      return false;
    }

    return matchesCall(candidate, directTargetCalls) || matchesCall(candidate, QUARTO_CALLS) || matchesCall(candidate, COMBINE_CALLS);
  });

  if (!factoryCall) {
    return null;
  }

  const { commandArgument, explicitNameArgument, patternArgument } = getFactoryArguments(factoryCall);
  let kind = null;
  let liveRange = null;

  if (patternArgument && patternArgument.value && containsPosition(rangeFromNode(patternArgument.value), point)) {
    kind = "pattern";
    liveRange = rangeFromNode(patternArgument.value);
  } else if (commandArgument && commandArgument.value && containsPosition(rangeFromNode(commandArgument.value), point)) {
    kind = "command";
    liveRange = rangeFromNode(commandArgument.value);
  }

  if (!kind || !liveRange) {
    return null;
  }

  const targetName = extractTargetName(explicitNameArgument && explicitNameArgument.value) || getAssignedFactoryName(factoryCall);
  if (!targetName) {
    return null;
  }

  const generated = Boolean(findAncestor(factoryCall.parent, (candidate) => candidate.type === "call" && matchesCall(candidate, MAP_CALLS)));
  return buildLiveRegionFromIndexedMatch(index, file, liveRange, kind, targetName, generated);
}

function buildTemplateCompletionItems(index, region, options) {
  const completionTargets = getCompletionTargets(index);
  if (!region.generated || !region.templateGeneratedNames) {
    return {
      coveredGeneratedTargets: new Set(),
      items: []
    };
  }

  const items = [];
  const coveredGeneratedTargets = new Set();
  const templateEntries = Object.entries(region.templateGeneratedNames);

  for (const [, generatedNames] of templateEntries) {
    for (const generatedName of generatedNames) {
      coveredGeneratedTargets.add(generatedName);
    }
  }

  for (const [templateName, generatedNames] of templateEntries) {
    if (templateName === region.templateName) {
      continue;
    }

    if (generatedNames.some((generatedName) => options.excluded.has(generatedName))) {
      continue;
    }

    const sourceTarget = generatedNames
      .map((generatedName) => completionTargets.get(generatedName))
      .find(Boolean);
    if (!sourceTarget) {
      continue;
    }

    const prefixScore = prefixScoreForName(templateName, options.prefix);
    const distanceScore = Math.min(
      ...generatedNames.map((generatedName) => (
        options.distances.has(generatedName) ? options.distances.get(generatedName) : 9999
      ))
    );
    const sameFileScore = sourceTarget.file === options.file ? 0 : 1;
    const item = new vscode.CompletionItem(templateName, vscode.CompletionItemKind.Reference);
    item.detail = `tar_map template • expands to ${generatedNames.length} target${generatedNames.length === 1 ? "" : "s"} • ${formatLocation(options.root, sourceTarget.file, sourceTarget.nameRange)}`;
    if (options.prefix && prefixScore > 1) {
      // Keep truly non-matching targets visible after the user starts typing,
      // but let natural prefix matches like `lambda` or `beta` rank normally.
      item.filterText = `${options.prefix} ${templateName}`;
    }
    item.sortText = [
      prefixScore.toString().padStart(2, "0"),
      sameFileScore.toString().padStart(2, "0"),
      "00",
      String(distanceScore).padStart(4, "0"),
      templateName
    ].join(":");

    if (options.insertContext.mode === "raw") {
      item.insertText = `"${templateName}"`;
      if (options.insertContext.replaceRange) {
        item.range = toVsCodeRange(options.insertContext.replaceRange);
      }
    } else if (options.insertContext.replaceRange) {
      item.range = toVsCodeRange(options.insertContext.replaceRange);
    }

    items.push(item);
  }

  return {
    coveredGeneratedTargets,
    items
  };
}

class TargetCompletionProvider {
  constructor(indexManager) {
    this.indexManager = indexManager;
  }

  async provideCompletionItems(document, position, token, context = { triggerKind: TRIGGER_KIND_INVOKE }) {
    try {
      const index = await this.indexManager.getIndexForUri(document.uri);
      if (!index) {
        return [];
      }

      const file = normalizeFile(document.uri.fsPath);
      const region = resolveLiveCompletionRegion(index, document, position);
      if (!region) {
        return [];
      }

      const insertContext = determineInsertContext(document, position);
      if (!insertContext) {
        return [];
      }

      // Prevent the user from inserting the current target, any existing
      // descendants, and any target already known to be cyclic.
      const completionTargets = getCompletionTargets(index);
      const completionGraph = getCompletionGraph(index);
      const excluded = new Set(completionGraph.cyclicTargets || []);
      for (const targetName of region.enclosingTargets) {
        excluded.add(targetName);
        for (const descendant of completionGraph.descendants.get(targetName) || []) {
          excluded.add(descendant);
        }
      }

      const distances = buildAncestorDistanceMap(completionGraph, region.enclosingTargets);
      const prefix = extractPrefix(document, position).toLowerCase();
      const root = this.indexManager.getWorkspaceRoot(document.uri);
      const items = [];
      if (shouldDelayTargetCompletions(region, prefix)) {
        return buildIncompleteCompletionList();
      }
      const templateItems = buildTemplateCompletionItems(index, region, {
        distances,
        excluded,
        file,
        insertContext,
        prefix,
        root
      });

      items.push(...templateItems.items);

      for (const target of completionTargets.values()) {
        if (excluded.has(target.name)) {
          continue;
        }

        // Inside tar_map() template code, sibling mapped targets are completed by
        // their template names rather than by the generated names from each row.
        if (templateItems.coveredGeneratedTargets.has(target.name)) {
          continue;
        }

        const prefixScore = prefixScoreForName(target.name, prefix);
        const sameFileScore = target.file === file ? 0 : 1;
        const generatedScore = target.generated ? 1 : 0;
        const distanceScore = distances.has(target.name) ? distances.get(target.name) : 9999;
        const upstreamCount = (completionGraph.downstreamToUpstream.get(target.name) || new Set()).size;
        const downstreamCount = (completionGraph.descendants.get(target.name) || new Set()).size;

        const item = new vscode.CompletionItem(target.name, vscode.CompletionItemKind.Reference);
        item.detail = `${target.generated ? "generated target via tar_map" : "target"} • ${formatLocation(root, target.file, target.nameRange)} • up ${upstreamCount} • down ${downstreamCount}`;
        if (prefix && prefixScore > 1) {
          // Let the editor keep showing valid non-matching targets like `beta`
          // after typing `a`, while preserving natural matching for close hits.
          item.filterText = `${prefix} ${target.name}`;
        }
        item.sortText = [
          prefixScore.toString().padStart(2, "0"),
          sameFileScore.toString().padStart(2, "0"),
          generatedScore.toString().padStart(2, "0"),
          String(distanceScore).padStart(4, "0"),
          target.name
        ].join(":");

        if (insertContext.mode === "raw") {
          item.insertText = `"${target.name}"`;
          if (insertContext.replaceRange) {
            item.range = toVsCodeRange(insertContext.replaceRange);
          }
        } else if (insertContext.replaceRange) {
          item.range = toVsCodeRange(insertContext.replaceRange);
        }

        items.push(item);
      }

      return items;
    } catch (error) {
      this.indexManager.logFailure("Completion provider failed", error, buildProviderParseContext(document, position, "completionProvider"));
      return [];
    }
  }
}

module.exports = {
  TargetCompletionProvider
};
