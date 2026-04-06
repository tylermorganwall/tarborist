"use strict";

// Pipeline-scoped completion provider with DAG-aware filtering.
const vscode = require("vscode");

const { findNodeAt, getPositionalArgument, getShortCallName, isCommentNode, isStringNode, matchesCall } = require("../parser/ast");
const { parseText } = require("../parser/treeSitter");
const {
  TARGET_LOAD_CALLS,
  TARGET_LOAD_RAW_CALLS,
  TARGET_READ_CALLS,
  TARGET_READ_RAW_CALLS
} = require("../parser/queries");
const { formatLocation, normalizeFile } = require("../util/paths");
const { comparePositions, containsPosition, rangeFromNode } = require("../util/ranges");
const { toVsCodeRange } = require("../util/vscode");
const { findCompletionRegion } = require("./shared");

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

function extractPrefix(document, position) {
  const line = document.lineAt(position.line).text.slice(0, position.character);
  const match = line.match(/[A-Za-z0-9_.]+$/);
  return match ? match[0] : "";
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
  const tree = parseText(document.getText(), {
    file: document.uri.fsPath,
    phase: "completionProvider"
  });
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

function buildTemplateCompletionItems(index, region, options) {
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
      .map((generatedName) => index.targets.get(generatedName))
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

  async provideCompletionItems(document, position) {
    try {
      const index = await this.indexManager.getIndexForUri(document.uri);
      if (!index) {
        return [];
      }

      const file = normalizeFile(document.uri.fsPath);
      const point = {
        character: position.character,
        line: position.line
      };
      const region = findCompletionRegion(index, file, point);
      if (!region) {
        return [];
      }

      const insertContext = determineInsertContext(document, position);
      if (!insertContext) {
        return [];
      }

      // Prevent the user from inserting the current target, any existing
      // descendants, and any target already known to be cyclic.
      const excluded = new Set(index.graph.cyclicTargets || []);
      for (const targetName of region.enclosingTargets) {
        excluded.add(targetName);
        for (const descendant of index.graph.descendants.get(targetName) || []) {
          excluded.add(descendant);
        }
      }

      const distances = buildAncestorDistanceMap(index.graph, region.enclosingTargets);
      const prefix = extractPrefix(document, position).toLowerCase();
      const root = this.indexManager.getWorkspaceRoot(document.uri);
      const items = [];
      const templateItems = buildTemplateCompletionItems(index, region, {
        distances,
        excluded,
        file,
        insertContext,
        prefix,
        root
      });

      items.push(...templateItems.items);

      for (const target of index.targets.values()) {
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
        const upstreamCount = (index.graph.downstreamToUpstream.get(target.name) || new Set()).size;
        const downstreamCount = (index.graph.descendants.get(target.name) || new Set()).size;

        const item = new vscode.CompletionItem(target.name, vscode.CompletionItemKind.Reference);
        item.detail = `${target.generated ? "generated target via tar_map" : "target"} • ${formatLocation(root, target.file, target.nameRange)} • up ${upstreamCount} • down ${downstreamCount}`;
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
      this.indexManager.logFailure("Completion provider failed", error, {
        file: document.uri.fsPath
      });
      return [];
    }
  }
}

module.exports = {
  TargetCompletionProvider
};
