"use strict";

// Rich markdown hovers for direct targets, generated targets, pipeline objects,
// and tar_map() generator calls.
const vscode = require("vscode");

const { findNodeAt, matchesCall, unpackArguments } = require("../parser/ast");
const { parseText } = require("../parser/treeSitter");
const { formatLocation, normalizeFile } = require("../util/paths");
const { findGeneratorAtPosition, findTargetAtPosition } = require("./shared");

function createMarkdown() {
  // Hover links trigger extension commands, so mark only those commands as trusted.
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = {
    enabledCommands: ["tarborist.openLocation", "tarborist.showTargetList"]
  };
  markdown.supportThemeIcons = true;
  return markdown;
}

function commandLinkForTarget(target) {
  if (!target) {
    return null;
  }

  const payload = target.generated && target.generator
    ? { file: target.generator.file, range: target.generator.range }
    : { file: target.file, range: target.nameRange };
  const encoded = encodeURIComponent(JSON.stringify([payload]));
  return `[\`${target.name}\`](command:tarborist.openLocation?${encoded})`;
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
  const links = targetNames
    .map((targetName) => commandLinkForTarget(index.targets.get(targetName)))
    .filter(Boolean);

  return links.length ? links.join(", ") : "`None`";
}

function commandLinkForTargetList(label, title, targets, root) {
  if (!targets.length) {
    return `\`${label}\``;
  }

  // Large downstream sets are easier to inspect through a quick-pick than by
  // dumping every target directly into the hover.
  const payload = {
    targets: targets.map((target) => {
      const destination = target.generated && target.generator
        ? { file: target.generator.file, range: target.generator.range }
        : { file: target.file, range: target.nameRange };

      return {
        description: formatLocation(root, destination.file, destination.range),
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

  const tree = parseText(document.getText());
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
  const upstream = [...(index.graph.downstreamToUpstream.get(target.name) || new Set())].sort();
  const downstreamTargets = [...(index.graph.descendants.get(target.name) || new Set())]
    .sort()
    .map((targetName) => index.targets.get(targetName))
    .filter(Boolean);
  const downstreamCount = (index.graph.descendants.get(target.name) || new Set()).size;

  if (target.generated && target.generator) {
    markdown.appendMarkdown(`### $(symbol-array) Generated target \`${target.name}\`\n\n`);
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
        label: "Siblings",
        value: (target.generator.generatedNamesPreview || []).length
          ? target.generator.generatedNamesPreview.map((name) => commandLinkForTarget(index.targets.get(name)) || `\`${name}\``).join(", ")
          : "`None`"
      },
      ...buildTargetOptionRows(target)
    ]);
    markdown.appendMarkdown(`\n**Bindings**\n${formatBindings(target.generator.bindings)}\n`);
  } else {
    markdown.appendMarkdown(`### $(symbol-field) Target \`${target.name}\`\n\n`);
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
        value: downstreamCount
          ? commandLinkForTargetList(String(downstreamCount), `Downstream of ${target.name}`, downstreamTargets, root)
          : "`0`"
      },
      ...buildTargetOptionRows(target)
    ]);

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

    const target = findTargetAtPosition(index, file, point);
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
        const generatedTarget = index.targets.get(name);
        return `- ${commandLinkForTarget(generatedTarget) || `\`${name}\``}`;
      }).join("\n"));
    }

    return new vscode.Hover(markdown);
  }
}

module.exports = {
  TargetHoverProvider
};
