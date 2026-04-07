"use strict";

// Extract R chunks from Quarto/R Markdown files and scan them for direct
// tar_read()/tar_load() dependencies.
const fs = require("fs");
const path = require("path");

const {
  getArgumentValue,
  getPositionalArgument,
  getStringValue,
  getShortCallName,
  isStringNode,
  matchesCall,
  unwrapNode,
  walkNamed
} = require("../parser/ast");
const { parseText } = require("../parser/treeSitter");
const { TARGET_LOAD_CALLS, TARGET_LOAD_RAW_CALLS, TARGET_READ_CALLS, TARGET_READ_RAW_CALLS } = require("../parser/queries");
const { normalizeFile, pathExists } = require("../util/paths");
const { rangeFromNode } = require("../util/ranges");

function isQuartoFile(file) {
  return /\.(qmd|QMD|rmd|Rmd)$/.test(file);
}

function walkQuartoFiles(targetPath) {
  const resolved = normalizeFile(targetPath);

  if (!pathExists(resolved)) {
    return [];
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    return isQuartoFile(resolved) ? [resolved] : [];
  }

  const files = [];
  const entries = fs.readdirSync(resolved, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const entryPath = path.join(resolved, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkQuartoFiles(entryPath));
      continue;
    }

    if (entry.isFile() && isQuartoFile(entryPath)) {
      files.push(normalizeFile(entryPath));
    }
  }

  return files;
}

function extractRChunks(text) {
  const lines = text.split(/\r?\n/);
  const codeLines = [];
  const lineMap = [];
  let activeFence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!activeFence) {
      const chunkStart = line.match(/^(\s*)(`{3,})\s*\{r(?:[\s,}].*)?$/i);
      if (!chunkStart) {
        continue;
      }

      activeFence = chunkStart[2];
      continue;
    }

    const chunkEndPattern = new RegExp(`^\\s*${activeFence}\\s*$`);
    if (chunkEndPattern.test(line)) {
      activeFence = null;
      codeLines.push("");
      lineMap.push(index);
      continue;
    }

    codeLines.push(line);
    lineMap.push(index);
  }

  return {
    code: codeLines.join("\n"),
    lineMap
  };
}

function remapRange(range, lineMap) {
  return {
    start: {
      line: lineMap[range.start.line] ?? range.start.line,
      character: range.start.character
    },
    end: {
      line: lineMap[range.end.line] ?? lineMap[range.start.line] ?? range.end.line,
      character: range.end.character
    }
  };
}

function extractParamTargetReference(node) {
  const current = unwrapNode(node);
  if (!current) {
    return null;
  }

  if (current.type === "extract_operator") {
    const objectNode = current.namedChildren && current.namedChildren.length ? unwrapNode(current.namedChildren[0]) : null;
    const propertyNode = current.namedChildren && current.namedChildren.length > 1 ? unwrapNode(current.namedChildren[1]) : null;
    if (objectNode && objectNode.type === "identifier" && objectNode.text === "params" && propertyNode && propertyNode.type === "identifier") {
      return {
        range: rangeFromNode(propertyNode),
        targetName: propertyNode.text
      };
    }
  }

  if (current.type !== "subset2" && current.type !== "subset") {
    return null;
  }

  const objectNode = current.namedChildren && current.namedChildren.length ? unwrapNode(current.namedChildren[0]) : null;
  if (!objectNode || objectNode.type !== "identifier" || objectNode.text !== "params") {
    return null;
  }

  const argumentsNode = (current.namedChildren || []).find((child) => child.type === "arguments");
  const argumentNode = argumentsNode && argumentsNode.namedChildren
    ? argumentsNode.namedChildren.find((child) => child.type === "argument")
    : null;
  const indexNode = argumentNode ? unwrapNode(getArgumentValue(argumentNode)) : null;
  if (!indexNode) {
    return null;
  }

  if (indexNode.type === "identifier") {
    return {
      range: rangeFromNode(indexNode),
      targetName: indexNode.text
    };
  }

  if (isStringNode(indexNode)) {
    return {
      range: rangeFromNode(indexNode),
      targetName: getStringValue(indexNode)
    };
  }

  return null;
}

function extractQuartoTargetReference(node) {
  const current = unwrapNode(node);
  if (!current) {
    return null;
  }

  if (current.type === "identifier") {
    return {
      range: rangeFromNode(current),
      targetName: current.text
    };
  }

  if (isStringNode(current)) {
    return {
      range: rangeFromNode(current),
      targetName: getStringValue(current)
    };
  }

  return extractParamTargetReference(current);
}

function collectQuartoRefsFromCode(code, file, lineMap) {
  if (!code.trim()) {
    return [];
  }

  const refs = [];
  const tree = parseText(code, {
    file,
    phase: "scanQuartoRChunks"
  });
  walkNamed(tree.rootNode, (node) => {
    if (node.type !== "call") {
      return;
    }

    const isRead = matchesCall(node, TARGET_READ_CALLS);
    const isLoad = matchesCall(node, TARGET_LOAD_CALLS);
    const isReadRaw = matchesCall(node, TARGET_READ_RAW_CALLS);
    const isLoadRaw = matchesCall(node, TARGET_LOAD_RAW_CALLS);
    if (!isRead && !isLoad && !isReadRaw && !isLoadRaw) {
      return;
    }

    const firstArgument = getPositionalArgument(node, 0);
    if (!firstArgument || !firstArgument.value) {
      return;
    }

    const reference = extractQuartoTargetReference(firstArgument.value);
    if (!reference || !reference.targetName) {
      return;
    }

    const shortCallName = getShortCallName(node);
    refs.push({
      context: shortCallName && shortCallName.startsWith("tar_load")
        ? (shortCallName.endsWith("_raw") ? "tar_load_raw" : "tar_load")
        : (shortCallName && shortCallName.endsWith("_raw") ? "tar_read_raw" : "tar_read"),
      file,
      range: remapRange(reference.range, lineMap),
      synthetic: false,
      targetName: reference.targetName
    });
  });

  return refs;
}

function scanQuartoDependencyRefs(targetPath, readFile) {
  const files = walkQuartoFiles(targetPath);
  const refs = [];

  for (const file of files) {
    const text = readFile(file);
    const extracted = extractRChunks(text);
    refs.push(...collectQuartoRefsFromCode(extracted.code, file, extracted.lineMap));
  }

  return {
    files,
    refs
  };
}

module.exports = {
  scanQuartoDependencyRefs
};
