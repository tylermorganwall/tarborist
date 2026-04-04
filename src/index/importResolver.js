"use strict";

// Resolve the safe static subset of source()/tar_source() paths and generate
// both import edges and clickable document links.
const path = require("path");

const {
  getNamedArgument,
  getPositionalArgument,
  getStringValue,
  isStringNode,
  matchesCall,
  unpackArguments,
  unwrapNode
} = require("../parser/ast");
const { SOURCE_CALLS, TAR_SOURCE_CALLS } = require("../parser/queries");
const { rangeFromNode } = require("../util/ranges");
const { isRSourceFile, pathExists, resolveRelativePath, walkRFiles } = require("../util/paths");
const { createDiagnostic } = require("../diagnostics/unresolvedDiagnostics");

function resolveFilePathExpression(node, fromFile) {
  // Keep import resolution intentionally narrow: literal strings, c(...), and
  // file.path(...) are predictable without running user code.
  const current = unwrapNode(node);
  if (!current) {
    return {
      ok: false,
      reason: "Empty path expression"
    };
  }

  if (isStringNode(current)) {
    return {
      ok: true,
      items: [{
        range: rangeFromNode(current),
        value: getStringValue(current),
        resolvedPath: resolveRelativePath(fromFile, getStringValue(current))
      }]
    };
  }

  if (matchesCall(current, new Set(["c"]))) {
    const items = [];
    for (const argument of unpackArguments(current)) {
      const nested = resolveFilePathExpression(argument.value, fromFile);
      if (!nested.ok) {
        return nested;
      }

      items.push(...nested.items);
    }

    return {
      ok: true,
      items
    };
  }

  if (matchesCall(current, new Set(["file.path"]))) {
    const parts = [];
    for (const argument of unpackArguments(current)) {
      const partNode = unwrapNode(argument.value);
      if (!isStringNode(partNode)) {
        return {
          ok: false,
          reason: "Only literal file.path() segments are supported"
        };
      }

      parts.push(getStringValue(partNode));
    }

    const joined = path.join(...parts);
    return {
      ok: true,
      items: [{
        range: rangeFromNode(current),
        value: joined,
        resolvedPath: resolveRelativePath(fromFile, joined)
      }]
    };
  }

  return {
    ok: false,
    reason: "Only string literals, c(...), and file.path(...) are supported"
  };
}

function resolveSourceCall(callNode, fromFile) {
  const pathArgument = getNamedArgument(callNode, "file") || getPositionalArgument(callNode, 0);
  if (!pathArgument || !pathArgument.value) {
    return {
      diagnostics: [
        createDiagnostic(fromFile, rangeFromNode(callNode), "warning", "Could not statically resolve source() path expression")
      ],
      imports: [],
      links: [],
      partial: true
    };
  }

  const resolved = resolveFilePathExpression(pathArgument.value, fromFile);
  if (!resolved.ok || resolved.items.length !== 1) {
    return {
      diagnostics: [
        createDiagnostic(fromFile, rangeFromNode(pathArgument.value), "warning", "Could not statically resolve source() path expression")
      ],
      imports: [],
      links: [],
      partial: true
    };
  }

  const [item] = resolved.items;
  if (!pathExists(item.resolvedPath) || !isRSourceFile(item.resolvedPath)) {
    return {
      diagnostics: [
        createDiagnostic(fromFile, item.range, "warning", `Could not resolve sourced file '${item.value}'`)
      ],
      imports: [],
      links: [],
      partial: true
    };
  }

  return {
    diagnostics: [],
    imports: [{
      fromFile,
      kind: "source",
      toFile: item.resolvedPath
    }],
    links: [{
      range: item.range,
      target: item.resolvedPath
    }],
    partial: false
  };
}

function resolveTarSourceCall(callNode, fromFile) {
  // tar_source() can fan out to many files, so enumerate .R files eagerly.
  const pathArgument = getNamedArgument(callNode, "files") || getPositionalArgument(callNode, 0);
  const resolved = pathArgument && pathArgument.value
    ? resolveFilePathExpression(pathArgument.value, fromFile)
    : {
        ok: true,
        items: [{
          range: null,
          value: "R",
          resolvedPath: resolveRelativePath(fromFile, "R")
        }]
      };

  if (!resolved.ok) {
    return {
      diagnostics: [
        createDiagnostic(fromFile, pathArgument ? rangeFromNode(pathArgument.value) : rangeFromNode(callNode), "warning", "Could not statically resolve tar_source() path expression")
      ],
      imports: [],
      links: [],
      partial: true
    };
  }

  const imports = [];
  const links = [];
  const diagnostics = [];
  let partial = false;

  for (const item of resolved.items) {
    if (!pathExists(item.resolvedPath)) {
      diagnostics.push(createDiagnostic(fromFile, item.range || rangeFromNode(callNode), "warning", `Could not resolve tar_source() path '${item.value}'`));
      partial = true;
      continue;
    }

    if (item.range) {
      links.push({
        range: item.range,
        target: item.resolvedPath
      });
    }

    const files = walkRFiles(item.resolvedPath);
    if (!files.length) {
      diagnostics.push(createDiagnostic(fromFile, item.range || rangeFromNode(callNode), "information", `tar_source() path '${item.value}' did not resolve to any R files`));
      partial = true;
      continue;
    }

    for (const file of files) {
      imports.push({
        fromFile,
        kind: "tar_source",
        toFile: file
      });
    }
  }

  imports.sort((left, right) => left.toFile.localeCompare(right.toFile));

  return {
    diagnostics,
    imports,
    links,
    partial
  };
}

function resolveImportCall(callNode, fromFile) {
  if (matchesCall(callNode, SOURCE_CALLS)) {
    return resolveSourceCall(callNode, fromFile);
  }

  if (matchesCall(callNode, TAR_SOURCE_CALLS)) {
    return resolveTarSourceCall(callNode, fromFile);
  }

  return {
    diagnostics: [],
    imports: [],
    links: [],
    partial: false
  };
}

module.exports = {
  resolveFilePathExpression,
  resolveImportCall
};
