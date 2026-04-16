"use strict";

const { ensureParserReady, parseText } = require("./parser/treeSitter");
const { getArgumentValue, getAssignmentParts, matchesCall, unwrapNode } = require("./parser/ast");
const { comparePositions } = require("./util/ranges");

const PIPELINE_CALLS = new Set(["list", "tar_plan"]);

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

  return offset + position.character;
}

function getLineStartOffset(text, line) {
  return positionToOffset(text, { character: 0, line });
}

function containsRange(outer, inner) {
  return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
}

function getTopLevelListCalls(tree) {
  const calls = [];

  for (const node of tree.rootNode.namedChildren || []) {
    const assignment = getAssignmentParts(node);
    const candidate = unwrapNode(assignment ? assignment.rhs : node);
    if (candidate && candidate.type === "call" && matchesCall(candidate, PIPELINE_CALLS)) {
      calls.push(candidate);
    }
  }

  return calls;
}

function buildTargetLookup(index, file) {
  const targets = index.completionTargets || index.targets || new Map();
  return [...targets.values()].filter((target) => !target.generated && target.file === file);
}

function findMovableTarget(argumentNode, targetsInFile) {
  const argumentRange = {
    start: {
      character: argumentNode.startPosition.column,
      line: argumentNode.startPosition.row
    },
    end: {
      character: argumentNode.endPosition.column,
      line: argumentNode.endPosition.row
    }
  };

  const matches = targetsInFile.filter((target) => containsRange(argumentRange, target.nameRange));
  return matches.length === 1 ? matches[0] : null;
}

function collectListEntries(callNode, text, targetsInFile) {
  const argumentsNode = callNode.childForFieldName ? callNode.childForFieldName("arguments") : null;
  if (!argumentsNode) {
    return null;
  }

  const entries = [];
  const children = argumentsNode.children || [];
  const interiorStart = positionToOffset(text, {
    character: argumentsNode.startPosition.column + 1,
    line: argumentsNode.startPosition.row
  });
  const interiorEnd = positionToOffset(text, {
    character: argumentsNode.endPosition.column - 1,
    line: argumentsNode.endPosition.row
  });

  let pendingComments = [];
  for (const child of children) {
    if (child.type === "comment") {
      pendingComments.push(child);
      continue;
    }

    if (child.type !== "argument") {
      continue;
    }

    const leadingNode = pendingComments.length ? pendingComments[0] : child;
    const startOffset = getLineStartOffset(text, leadingNode.startPosition.row);
    const endOffset = positionToOffset(text, {
      character: child.endPosition.column,
      line: child.endPosition.row
    });
    const target = findMovableTarget(child, targetsInFile);

    entries.push({
      argEndOffset: endOffset,
      endOffset,
      startOffset,
      target,
      text: text.slice(startOffset, endOffset)
    });

    pendingComments = [];
  }

  if (!entries.length) {
    return null;
  }

  const separators = [];
  for (let index = 0; index < entries.length - 1; index += 1) {
    separators.push(text.slice(entries[index].argEndOffset, entries[index + 1].startOffset));
  }

  const prefix = text.slice(interiorStart, entries[0].startOffset);
  const suffix = text.slice(entries[entries.length - 1].argEndOffset, interiorEnd);

  return {
    entries,
    prefix,
    separators,
    suffix
  };
}

function stableTopologicalOrder(entries, graph) {
  const originalIndex = new Map(entries.map((entry, index) => [entry.target.name, index]));
  const localNames = new Set(entries.map((entry) => entry.target.name));
  const adjacency = graph && graph.upstreamToDownstream ? graph.upstreamToDownstream : new Map();
  const indegree = new Map(entries.map((entry) => [entry.target.name, 0]));

  for (const entry of entries) {
    for (const downstream of adjacency.get(entry.target.name) || []) {
      if (!localNames.has(downstream)) {
        continue;
      }

      indegree.set(downstream, (indegree.get(downstream) || 0) + 1);
    }
  }

  const queue = entries
    .map((entry) => entry.target.name)
    .filter((name) => (indegree.get(name) || 0) === 0);
  const orderedNames = [];
  const seen = new Set();

  while (queue.length) {
    queue.sort((left, right) => (originalIndex.get(left) || 0) - (originalIndex.get(right) || 0));
    const current = queue.shift();
    if (seen.has(current)) {
      continue;
    }

    seen.add(current);
    orderedNames.push(current);

    for (const downstream of adjacency.get(current) || []) {
      if (!localNames.has(downstream) || seen.has(downstream)) {
        continue;
      }

      indegree.set(downstream, (indegree.get(downstream) || 0) - 1);
      if ((indegree.get(downstream) || 0) === 0) {
        queue.push(downstream);
      }
    }
  }

  for (const entry of entries) {
    if (!seen.has(entry.target.name)) {
      orderedNames.push(entry.target.name);
    }
  }

  const entryByName = new Map(entries.map((entry) => [entry.target.name, entry]));
  return orderedNames.map((name) => entryByName.get(name)).filter(Boolean);
}

function reorderEntries(entries, graph) {
  const reordered = [];
  let movableBuffer = [];

  const flushBuffer = () => {
    if (!movableBuffer.length) {
      return;
    }

    reordered.push(...stableTopologicalOrder(movableBuffer, graph));
    movableBuffer = [];
  };

  for (const entry of entries) {
    if (!entry.target) {
      flushBuffer();
      reordered.push(entry);
      continue;
    }

    movableBuffer.push(entry);
  }

  flushBuffer();
  return reordered;
}

function buildListReplacement(listData, graph) {
  const reorderedEntries = reorderEntries(listData.entries, graph);
  const changed = reorderedEntries.some((entry, index) => entry !== listData.entries[index]);
  if (!changed) {
    return null;
  }

  let body = listData.prefix;
  for (let index = 0; index < reorderedEntries.length; index += 1) {
    body += reorderedEntries[index].text;
    if (index < reorderedEntries.length - 1) {
      body += listData.separators[index] || ",\n";
    }
  }

  return `${body}${listData.suffix}`;
}

async function organizePipelineText({ file, index, text }) {
  if (!text || !file || !index) {
    return {
      changed: false,
      text
    };
  }

  await ensureParserReady();
  const tree = parseText(text, {
    file,
    phase: "organizePipeline"
  });
  const targetsInFile = buildTargetLookup(index, file);
  const replacements = [];

  for (const callNode of getTopLevelListCalls(tree)) {
    const listData = collectListEntries(callNode, text, targetsInFile);
    if (!listData) {
      continue;
    }

    const replacement = buildListReplacement(listData, index.completionGraph || index.graph);
    if (!replacement) {
      continue;
    }

    const argumentsNode = callNode.childForFieldName ? callNode.childForFieldName("arguments") : null;
    if (!argumentsNode) {
      continue;
    }

    replacements.push({
      end: positionToOffset(text, {
        character: argumentsNode.endPosition.column - 1,
        line: argumentsNode.endPosition.row
      }),
      start: positionToOffset(text, {
        character: argumentsNode.startPosition.column + 1,
        line: argumentsNode.startPosition.row
      }),
      text: replacement
    });
  }

  if (!replacements.length) {
    return {
      changed: false,
      text
    };
  }

  let nextText = text;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    nextText = `${nextText.slice(0, replacement.start)}${replacement.text}${nextText.slice(replacement.end)}`;
  }

  return {
    changed: nextText !== text,
    text: nextText
  };
}

module.exports = {
  organizePipelineText
};
