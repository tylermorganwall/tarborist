"use strict";

// Rich markdown hovers for direct targets, generated targets, pipeline objects,
// and tar_map() generator calls.
const vscode = require("vscode");

const { findNodeAt, matchesCall, unpackArguments } = require("../parser/ast");
const { parseText } = require("../parser/treeSitter");
const { getTargetDestination } = require("../targetDestination");
const { formatLocation, normalizeFile } = require("../util/paths");
const { containsPosition, rangeLength } = require("../util/ranges");
const { findGeneratorAtPosition, findTargetAtPosition } = require("./shared");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_INLINE_DIRECT_DOWNSTREAM = 5;

function createMarkdown() {
  // Hover links trigger extension commands, so mark only those commands as trusted.
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = {
    enabledCommands: ["tarborist.openLocation", "tarborist.showTargetList"]
  };
  markdown.supportThemeIcons = true;
  return markdown;
}

function getHoverTargets(index) {
  return index.completionTargets || index.targets || new Map();
}

function getHoverGraph(index) {
  return index.completionGraph || index.graph;
}

function pickSmallest(matches) {
  if (!matches.length) {
    return null;
  }

  return matches.sort((left, right) => rangeLength(left.range) - rangeLength(right.range))[0];
}

function findHoverTargetAtPosition(index, file, position) {
  const targets = getHoverTargets(index);
  const directMatches = [];
  for (const target of targets.values()) {
    if (target.file === file && containsPosition(target.nameRange, position)) {
      directMatches.push({
        range: target.nameRange,
        target
      });
    }
  }

  const directMatch = pickSmallest(directMatches);
  if (directMatch) {
    return directMatch.target;
  }

  const refs = index.completionRefs || index.refs || [];
  const refMatches = refs
    .filter((ref) => !ref.synthetic && ref.file === file && containsPosition(ref.range, position))
    .map((ref) => ({
      range: ref.range,
      target: targets.get(ref.targetName) || null
    }))
    .filter((match) => match.target);
  const refMatch = pickSmallest(refMatches);
  return refMatch ? refMatch.target : null;
}

function commandLinkForTarget(target) {
  if (!target) {
    return null;
  }

  const payload = getTargetDestination(target);
  const encoded = encodeURIComponent(JSON.stringify([payload]));
  return `[\`${target.name}\`](command:tarborist.openLocation?${encoded})`;
}

function buildDownstreamDepthMap(graph, rootTargetName) {
  const adjacency = graph.upstreamToDownstream || new Map();
  const depths = new Map([[rootTargetName, 0]]);
  const queue = [rootTargetName];

  while (queue.length) {
    const current = queue.shift();
    const currentDepth = depths.get(current) || 0;
    for (const downstream of adjacency.get(current) || []) {
      if (depths.has(downstream)) {
        continue;
      }

      depths.set(downstream, currentDepth + 1);
      queue.push(downstream);
    }
  }

  depths.delete(rootTargetName);
  return depths;
}

function formatBindings(bindings) {
  const entries = Object.entries(bindings || {});
  if (!entries.length) {
    return "`none`";
  }

  return entries
    .map(([name, value]) => `- **${name}**: \`${value}\``)
    .join("\n");
}

function formatTargetLinks(index, targetNames) {
  const targets = getHoverTargets(index);
  const links = targetNames
    .map((targetName) => commandLinkForTarget(targets.get(targetName)))
    .filter(Boolean);

  return links.length ? links.join(", ") : "`None`";
}

function commandLinkForTargetList(index, label, title, targets, root, options = {}) {
  if (!targets.length) {
    return `\`${label}\``;
  }

  // Large downstream sets are easier to inspect through a quick-pick than by
  // dumping every target directly into the hover.
  const payload = {
    targets: targets.map((target) => {
      const destination = getTargetDestination(target);

      return {
        description: buildTargetListDescription(index, target, root, destination, {
          indirectDistance: options.indirectDepths ? options.indirectDepths.get(target.name) : null
        }),
        file: destination.file,
        name: target.name,
        range: destination.range
      };
    }),
    title
  };
  const encoded = encodeURIComponent(JSON.stringify([payload]));
  return `[\`${label}\`](command:tarborist.showTargetList?${encoded})`;
}

function buildDownstreamSummaryValue(index, root, targetName, directDownstreamTargets, furtherDownstreamTargets) {
  if (!directDownstreamTargets.length) {
    return "`0`";
  }

  const directValue = directDownstreamTargets.length <= MAX_INLINE_DIRECT_DOWNSTREAM
    ? directDownstreamTargets.map((downstreamTarget) => commandLinkForTarget(downstreamTarget) || `\`${downstreamTarget.name}\``).join(", ")
    : commandLinkForTargetList(index, `(${directDownstreamTargets.length})`, `Direct downstream of ${targetName}`, directDownstreamTargets, root);

  if (!furtherDownstreamTargets.length) {
    return directValue;
  }

  const indirectDepths = buildDownstreamDepthMap(getHoverGraph(index), targetName);
  return `${directValue}, ${commandLinkForTargetList(index, `(+${furtherDownstreamTargets.length} further)`, `Further downstream of ${targetName}`, furtherDownstreamTargets, root, {
    indirectDepths
  })}`;
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

function appendInfoSection(markdown, title = "Target info") {
  markdown.appendMarkdown(`**${title}**\n\n---\n\n`);
}

function appendFieldRows(markdown, rows) {
  markdown.appendMarkdown("|  |  |\n");
  markdown.appendMarkdown("| :--- | :--- |\n");
  for (const row of rows) {
    markdown.appendMarkdown(`| **${row.label}** | ${row.value} |\n`);
  }
  markdown.appendMarkdown("\n");
}

function buildTargetOptionRows(target) {
  const cueText = target.options && target.options.cue;
  const parallelTexts = target.options && Array.isArray(target.options.parallel) ? target.options.parallel : [];
  const rows = [];

  if (cueText) {
    rows.push({
      label: "Cue",
      value: `\`${cueText}\``
    });
  }

  if (parallelTexts.length) {
    rows.push({
      label: "Parallel",
      value: parallelTexts.map((text) => `\`${text}\``).join("<br>")
    });
  }

  return rows;
}

function buildMetaStatus(meta) {
  if (!meta) {
    return null;
  }

  if (meta.hasWarnings && meta.hasError) {
    return "`warning + error`";
  }

  if (meta.hasError) {
    return "`error`";
  }

  if (meta.hasWarnings) {
    return "`warning`";
  }

  return "`clean`";
}

function formatMetaUpdated(meta) {
  if (!meta) {
    return null;
  }

  if (!meta.time) {
    return "`not built yet`";
  }

  const age = formatMetaAge(meta);
  if (!age) {
    return `\`${meta.time}\``;
  }

  return `\`${age}, ${meta.time}\``;
}

function formatMetaAge(meta) {
  if (!meta || !Number.isFinite(meta.timestampMs)) {
    return null;
  }

  const elapsedDays = Math.max(0, Math.floor((Date.now() - meta.timestampMs) / DAY_MS));
  const dayLabel = elapsedDays === 1 ? "day" : "days";
  return `${elapsedDays} ${dayLabel} ago`;
}

function buildTargetListDescription(index, target, root, destination, options = {}) {
  const location = formatLocation(root, destination.file, destination.range);
  const indirectDistance = options.indirectDistance;
  const depthPrefix = Number.isFinite(indirectDistance) && indirectDistance >= 2
    ? `<${indirectDistance - 1} deep> `
    : "";
  const meta = index.targetsMeta && index.targetsMeta.get(target.name);
  if (meta && !meta.time) {
    return `${depthPrefix}${location} (not built yet)`;
  }

  const age = formatMetaAge(meta);
  const suffixParts = age ? [`updated ${age}`] : [];

  return suffixParts.length
    ? `${depthPrefix}${location} (${suffixParts.join(", ")})`
    : `${depthPrefix}${location}`;
}

function appendTextBlock(markdown, title, text) {
  if (!text) {
    return;
  }

  markdown.appendMarkdown(`\n**${title}**\n\n`);
  markdown.appendMarkdown("```text\n");
  markdown.appendMarkdown(`${text}\n`);
  markdown.appendMarkdown("```\n");
}

function buildMetaRows(index, target) {
  const meta = index.targetsMeta && index.targetsMeta.get(target.name);
  if (!meta) {
    return [];
  }

  const rows = [];
  const updated = formatMetaUpdated(meta);
  if (updated) {
    rows.push({
      label: "Updated",
      value: updated
    });
  }

  rows.push({
    label: "Status",
    value: buildMetaStatus(meta)
  });

  if (meta.size) {
    rows.push({
      label: "Size",
      value: `\`${meta.size}\``
    });
  }

  return rows;
}

function appendMetaDetails(markdown, index, target) {
  const meta = index.targetsMeta && index.targetsMeta.get(target.name);
  if (!meta) {
    return;
  }

  appendTextBlock(markdown, "Warnings", meta.warnings);
  appendTextBlock(markdown, "Error", meta.error);
}

function flattenTargetsFromValue(value) {
  if (!value) {
    return [];
  }

  if (value.kind === "TargetObject") {
    return [value.target];
  }

  if (value.kind === "TargetList") {
    return value.items.flatMap((item) => flattenTargetsFromValue(item));
  }

  if (value.kind === "StaticMap") {
    return value.targets.slice();
  }

  return [];
}

function collectTargetsFromListCall(index, file, document, position) {
  // Hovering the pipeline's final list(...) should reveal which targets or
  // sourced pipeline objects that list contributes.
  const record = index.files.get(file);
  if (!record) {
    return [];
  }

  const tree = parseText(document.getText(), buildProviderParseContext(document, position, "hoverProvider"));
  const node = findNodeAt(tree.rootNode, position);
  if (!node || node.type !== "identifier" || node.text !== "list") {
    return [];
  }

  const listCall = node.parent && node.parent.type === "call" && matchesCall(node.parent, new Set(["list"]))
    ? node.parent
    : null;
  if (!listCall) {
    return [];
  }

  const functionNode = listCall.childForFieldName ? listCall.childForFieldName("function") : null;
  if (functionNode !== node) {
    return [];
  }

  const targets = [];
  for (const argument of unpackArguments(listCall)) {
    if (!argument.value) {
      continue;
    }

    if (argument.value.type === "identifier") {
      targets.push(...flattenTargetsFromValue(record.exportedSymbols.get(argument.value.text)));
      continue;
    }

    for (const target of index.targets.values()) {
      if (target.file === file && target.fullRange.start.line === argument.value.startPosition.row && target.fullRange.start.character === argument.value.startPosition.column) {
        targets.push(target);
      }
    }
  }

  return targets;
}

function buildTargetHover(index, root, target) {
  // Target hovers are the main navigation surface: show graph info and link
  // related targets directly from the hover body.
  const markdown = createMarkdown();
  const hoverTargets = getHoverTargets(index);
  const hoverGraph = getHoverGraph(index);
  const disabledInFinalPipeline = !index.targets.has(target.name);
  const upstream = [...(hoverGraph.downstreamToUpstream.get(target.name) || new Set())].sort();
  const directDownstreamTargets = [...(hoverGraph.upstreamToDownstream.get(target.name) || new Set())]
    .sort()
    .map((targetName) => hoverTargets.get(targetName))
    .filter(Boolean);
  const directDownstreamNames = new Set(directDownstreamTargets.map((downstreamTarget) => downstreamTarget.name));
  const downstreamTargets = [...(hoverGraph.descendants.get(target.name) || new Set())]
    .sort()
    .map((targetName) => hoverTargets.get(targetName))
    .filter(Boolean);
  const furtherDownstreamTargets = downstreamTargets.filter((downstreamTarget) => !directDownstreamNames.has(downstreamTarget.name));
  const downstreamSummaryValue = buildDownstreamSummaryValue(index, root, target.name, directDownstreamTargets, furtherDownstreamTargets);
  const targetHeaderLink = commandLinkForTarget(target) || `\`${target.name}\``;

  if (target.generated && target.generator) {
    markdown.appendMarkdown(`### $(symbol-array) Generated target ${targetHeaderLink}\n\n`);
    appendInfoSection(markdown);
    appendFieldRows(markdown, [
      {
        label: "Origin",
        value: `\`${formatLocation(root, target.generator.file, target.generator.range)}\``
      },
      {
        label: "Template",
        value: `\`${target.generator.templateName}\``
      },
      {
        label: "Downstream",
        value: downstreamSummaryValue
      },
      {
        label: "Siblings",
          value: (target.generator.generatedNamesPreview || []).length
          ? target.generator.generatedNamesPreview.map((name) => commandLinkForTarget(hoverTargets.get(name)) || `\`${name}\``).join(", ")
          : "`None`"
      },
      ...buildTargetOptionRows(target),
      ...buildMetaRows(index, target)
    ]);
    appendMetaDetails(markdown, index, target);
    markdown.appendMarkdown(`\n**Bindings**\n${formatBindings(target.generator.bindings)}\n`);
  } else {
    markdown.appendMarkdown(`### $(symbol-field) Target ${targetHeaderLink}\n\n`);
    appendInfoSection(markdown);
    appendFieldRows(markdown, [
      {
        label: "Defined in",
        value: `\`${formatLocation(root, target.file, target.nameRange)}\``
      },
      {
        label: "Upstream",
        value: formatTargetLinks(index, upstream)
      },
      {
        label: "Downstream",
        value: downstreamSummaryValue
      },
      ...buildTargetOptionRows(target),
      ...buildMetaRows(index, target)
    ]);
    appendMetaDetails(markdown, index, target);

    if (disabledInFinalPipeline) {
      markdown.appendMarkdown(`\n> $(circle-slash) Disabled in the final pipeline.\n`);
    }

    if (index.partial) {
      markdown.appendMarkdown(`\n> $(warning) Static analysis is partial.\n`);
    }
  }

  return new vscode.Hover(markdown);
}

class TargetHoverProvider {
  constructor(indexManager) {
    this.indexManager = indexManager;
  }

  async provideHover(document, position) {
    try {
      const index = await this.indexManager.getIndexForUri(document.uri);
      if (!index) {
        return null;
      }

      const root = this.indexManager.getWorkspaceRoot(document.uri);
      const file = normalizeFile(document.uri.fsPath);
      const point = {
        character: position.character,
        line: position.line
      };

      const target = findHoverTargetAtPosition(index, file, point) || findTargetAtPosition(index, file, point);
      if (target) {
        return buildTargetHover(index, root, target);
      }

      const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z.][A-Za-z0-9._]*/);
      const record = index.files.get(file);
      if (record && wordRange) {
        const symbol = document.getText(wordRange);
        const value = record.exportedSymbols.get(symbol);
        if (value && value.kind === "TargetObject" && value.target) {
          return buildTargetHover(index, root, value.target);
        }

        const containedTargets = flattenTargetsFromValue(value);
        if (containedTargets.length) {
          const markdown = createMarkdown();
          markdown.appendMarkdown(`### $(list-flat) Pipeline object \`${symbol}\`\n\n`);
          markdown.appendMarkdown(`Contains **${containedTargets.length}** target${containedTargets.length === 1 ? "" : "s"}:\n\n`);
          markdown.appendMarkdown(containedTargets.map((containedTarget) => `- ${commandLinkForTarget(containedTarget) || `\`${containedTarget.name}\``}`).join("\n"));
          return new vscode.Hover(markdown);
        }
      }

      const listTargets = collectTargetsFromListCall(index, file, document, point);
      if (listTargets.length) {
        const markdown = createMarkdown();
        markdown.appendMarkdown(`### $(list-flat) Pipeline list\n\n`);
        markdown.appendMarkdown(`Contains **${listTargets.length}** target${listTargets.length === 1 ? "" : "s"}:\n\n`);
        markdown.appendMarkdown(listTargets.map((containedTarget) => `- ${commandLinkForTarget(containedTarget) || `\`${containedTarget.name}\``}`).join("\n"));
        return new vscode.Hover(markdown);
      }

      const generator = findGeneratorAtPosition(index, file, point);
      if (!generator) {
        return null;
      }

      const markdown = createMarkdown();
      markdown.appendMarkdown(`### $(symbol-array) Static \`tar_map()\` expansion\n\n`);
      appendInfoSection(markdown, "Expansion info");
      appendFieldRows(markdown, [
        {
          label: "Origin",
          value: `\`${formatLocation(root, generator.file, generator.range)}\``
        },
        {
          label: "Generated targets",
          value: `\`${generator.count}\``
        }
      ]);

      if ((generator.generatedNamesPreview || []).length) {
        markdown.appendMarkdown(`\n**Preview**\n`);
        markdown.appendMarkdown(generator.generatedNamesPreview.map((name) => {
          const generatedTarget = getHoverTargets(index).get(name);
          return `- ${commandLinkForTarget(generatedTarget) || `\`${name}\``}`;
        }).join("\n"));
      }

      return new vscode.Hover(markdown);
    } catch (error) {
      this.indexManager.logFailure("Hover provider failed", error, buildProviderParseContext(document, position, "hoverProvider"));
      return null;
    }
  }
}

module.exports = {
  TargetHoverProvider
};
