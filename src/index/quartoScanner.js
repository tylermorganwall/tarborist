"use strict";

// Extract R chunks from Quarto/R Markdown files and scan them for direct
// tar_read()/tar_load() dependencies.
const fs = require("fs");
const path = require("path");

const {
  getPositionalArgument,
  getStringValue,
  getShortCallName,
  isStringNode,
  matchesCall,
  unwrapNode,
  walkNamed
} = require("../parser/ast");
const { parseText } = require("../parser/treeSitter");
const { TARGET_LOAD_CALLS, TARGET_READ_CALLS } = require("../parser/queries");
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
    if (!isRead && !isLoad) {
      return;
    }

    const firstArgument = getPositionalArgument(node, 0);
    if (!firstArgument || !firstArgument.value) {
      return;
    }

    const current = unwrapNode(firstArgument.value);
    let targetName = null;
    if (current && current.type === "identifier") {
      targetName = current.text;
    } else if (isStringNode(current)) {
      targetName = getStringValue(current);
    }

    if (!targetName) {
      return;
    }

    const shortCallName = getShortCallName(node);
    refs.push({
      context: shortCallName && shortCallName.startsWith("tar_load") ? "tar_load" : "tar_read",
      file,
      range: remapRange(rangeFromNode(current), lineMap),
      synthetic: false,
      targetName
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
