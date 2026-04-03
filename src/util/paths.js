"use strict";

// Path utilities for discovering pipeline roots, imports, and readable locations.
const fs = require("fs");
const path = require("path");

function normalizeFile(file) {
  return path.normalize(path.resolve(file));
}

function resolveRelativePath(fromFile, candidate) {
  if (!candidate) {
    return null;
  }

  if (path.isAbsolute(candidate)) {
    return normalizeFile(candidate);
  }

  return normalizeFile(path.resolve(path.dirname(fromFile), candidate));
}

function findNearestTargetsRoot(fromFile, workspaceRoot) {
  // Anchor analysis to the closest enclosing _targets.R so nested files are
  // indexed against the right pipeline.
  if (!fromFile || !workspaceRoot) {
    return null;
  }

  const normalizedWorkspaceRoot = normalizeFile(workspaceRoot);
  let currentDir = normalizeFile(path.dirname(fromFile));

  while (currentDir.startsWith(normalizedWorkspaceRoot)) {
    const candidate = path.join(currentDir, "_targets.R");
    if (pathExists(candidate)) {
      return currentDir;
    }

    if (currentDir === normalizedWorkspaceRoot) {
      break;
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }

    currentDir = parent;
  }

  return null;
}

function isRSourceFile(file) {
  return /\.(R|r)$/.test(file);
}

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function walkRFiles(targetPath) {
  // tar_source() imports should be deterministic, so recurse in sorted order.
  const resolved = normalizeFile(targetPath);

  if (!pathExists(resolved)) {
    return [];
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    return isRSourceFile(resolved) ? [resolved] : [];
  }

  const files = [];
  const entries = fs.readdirSync(resolved, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const entryPath = path.join(resolved, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkRFiles(entryPath));
      continue;
    }

    if (entry.isFile() && isRSourceFile(entryPath)) {
      files.push(normalizeFile(entryPath));
    }
  }

  return files;
}

function relativeFile(workspaceRoot, file) {
  if (!workspaceRoot) {
    return file;
  }

  const relative = path.relative(workspaceRoot, file);
  return relative && !relative.startsWith("..") ? relative : file;
}

function formatLocation(workspaceRoot, file, targetRange) {
  const line = targetRange && targetRange.start ? targetRange.start.line + 1 : 1;
  return `${relativeFile(workspaceRoot, file)}:${line}`;
}

module.exports = {
  findNearestTargetsRoot,
  formatLocation,
  isRSourceFile,
  normalizeFile,
  pathExists,
  relativeFile,
  resolveRelativePath,
  walkRFiles
};
