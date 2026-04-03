"use strict";

// Static expander for the supported tar_map() subset: parse values rows, gather
// template targets, and synthesize generated target definitions.
const {
  getNamedArgument,
  getPositionalArgument,
  getShortCallName,
  getStringValue,
  isStringNode,
  matchesCall,
  unpackArguments,
  unwrapNode
} = require("../parser/ast");
const { TAR_MAP_CONTROL_ARGUMENTS } = require("../parser/queries");
const { rangeFromNode } = require("../util/ranges");
const { parseTarTargetCall } = require("./targetFactories");

function sanitizeNamePart(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._]+/g, "_")
    .replace(/^_+|_+$/g, "") || "value";
}

function bindingValueFromNode(node) {
  // Capture both a printable preview and a sanitized name fragment for generated
  // target names.
  const current = unwrapNode(node);
  if (!current) {
    return null;
  }

  if (isStringNode(current)) {
    const text = getStringValue(current);
    return {
      kind: "string",
      node: current,
      preview: text,
      text: current.text,
      namePart: sanitizeNamePart(text)
    };
  }

  if (current.type === "identifier") {
    return {
      kind: "symbol",
      node: current,
      preview: current.text,
      text: current.text,
      namePart: sanitizeNamePart(current.text)
    };
  }

  if (current.type === "integer" || current.type === "float" || current.type === "complex" || current.type === "true" || current.type === "false" || current.type === "null") {
    return {
      kind: "literal",
      node: current,
      preview: current.text,
      text: current.text,
      namePart: sanitizeNamePart(current.text)
    };
  }

  if (current.type === "unary_operator") {
    return {
      kind: "expr",
      node: current,
      preview: current.text,
      text: current.text,
      namePart: sanitizeNamePart(current.text)
    };
  }

  if (matchesCall(current, new Set(["quote"]))) {
    const quoted = getPositionalArgument(current, 0);
    if (!quoted || !quoted.value) {
      return null;
    }

    return {
      kind: "expr",
      node: quoted.value,
      preview: quoted.value.text,
      text: quoted.value.text,
      namePart: sanitizeNamePart(quoted.value.text)
    };
  }

  return {
    kind: "expr",
    node: current,
    preview: current.text,
    text: current.text,
    namePart: sanitizeNamePart(current.text)
  };
}

function parseVectorValues(node) {
  const current = unwrapNode(node);
  if (!current) {
    return null;
  }

  if (matchesCall(current, new Set(["c", "list"]))) {
    const values = [];
    for (const argument of unpackArguments(current)) {
      const binding = bindingValueFromNode(argument.value);
      if (!binding) {
        return null;
      }

      values.push(binding);
    }

    return values;
  }

  const scalar = bindingValueFromNode(current);
  return scalar ? [scalar] : null;
}

function buildRowsFromColumns(columns) {
  const names = Object.keys(columns);
  if (!names.length) {
    return [];
  }

  const lengths = names.map((name) => columns[name].length);
  const rowCount = Math.max(...lengths);
  if (!Number.isFinite(rowCount) || rowCount < 1) {
    return [];
  }

  for (const length of lengths) {
    if (length !== 1 && length !== rowCount) {
      return null;
    }
  }

  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    const row = {};
    for (const name of names) {
      const values = columns[name];
      row[name] = values.length === 1 ? values[0] : values[index];
    }
    rows.push(row);
  }

  return rows;
}

function parseRowObject(node) {
  const current = unwrapNode(node);
  if (!matchesCall(current, new Set(["list"]))) {
    return null;
  }

  const row = {};
  for (const argument of unpackArguments(current)) {
    if (!argument.name) {
      return null;
    }

    const binding = bindingValueFromNode(argument.value);
    if (!binding) {
      return null;
    }

    row[argument.name] = binding;
  }

  return row;
}

function parseValuesRows(node) {
  // Accept either column-oriented values (list(a = c(...))) or explicit row
  // objects (list(list(a = 1), list(a = 2))).
  const current = unwrapNode(node);
  if (!current) {
    return null;
  }

  if (matchesCall(current, new Set(["list", "data.frame", "tibble", "tibble::tibble"]))) {
    const argumentsList = unpackArguments(current);
    if (!argumentsList.length) {
      return [];
    }

    if (argumentsList.every((argument) => Boolean(argument.name))) {
      const columns = {};
      for (const argument of argumentsList) {
        const values = parseVectorValues(argument.value);
        if (!values) {
          return null;
        }

        columns[argument.name] = values;
      }

      return buildRowsFromColumns(columns);
    }

    if (argumentsList.every((argument) => !argument.name)) {
      const rows = [];
      for (const argument of argumentsList) {
        const row = parseRowObject(argument.value);
        if (!row) {
          return null;
        }

        rows.push(row);
      }

      return rows;
    }
  }

  return null;
}

function parseNameColumns(node, availableColumns) {
  const current = unwrapNode(node);
  if (!current) {
    return availableColumns;
  }

  const shortCallName = getShortCallName(current);
  if (shortCallName === "everything") {
    return availableColumns;
  }

  if (shortCallName === "any_of" || shortCallName === "all_of") {
    const inner = getPositionalArgument(current, 0);
    return inner && inner.value ? parseNameColumns(inner.value, availableColumns) : availableColumns;
  }

  if (isStringNode(current)) {
    return [getStringValue(current)];
  }

  if (current.type === "identifier") {
    return [current.text];
  }

  if (matchesCall(current, new Set(["c"]))) {
    const columns = [];
    for (const argument of unpackArguments(current)) {
      const value = unwrapNode(argument.value);
      if (isStringNode(value)) {
        columns.push(getStringValue(value));
        continue;
      }

      if (value && value.type === "identifier") {
        columns.push(value.text);
        continue;
      }

      return availableColumns;
    }

    return columns;
  }

  return availableColumns;
}

function collectTemplateTargets(node, file, generatorMeta, diagnostics) {
  const current = unwrapNode(node);
  if (!current) {
    return [];
  }

  if (matchesCall(current, new Set(["tar_target", "targets::tar_target"]))) {
    const parsed = parseTarTargetCall(current, file, {
      origin: "tar_target"
    });

    if (!parsed.ok) {
      diagnostics.push({
        range: rangeFromNode(current),
        severity: "information",
        message: parsed.reason
      });
      return [];
    }

    return [parsed.target];
  }

  if (matchesCall(current, new Set(["list"]))) {
    const targets = [];
    for (const argument of unpackArguments(current)) {
      targets.push(...collectTemplateTargets(argument.value, file, generatorMeta, diagnostics));
    }

    return targets;
  }

  diagnostics.push({
    range: rangeFromNode(current),
    severity: "information",
    message: "Could not statically resolve tar_map() target template"
  });
  return [];
}

function expandTarMap(callNode, file) {
  // Expand the generator without evaluating NSE: derive rows, generate names,
  // and attach binding metadata for hover/ref extraction later.
  const diagnostics = [];
  const valuesArgument = getNamedArgument(callNode, "values") || getPositionalArgument(callNode, 0);
  if (!valuesArgument || !valuesArgument.value) {
    diagnostics.push({
      range: rangeFromNode(callNode),
      severity: "information",
      message: "Could not statically expand tar_map(): missing values argument"
    });
    return {
      kind: "Unknown",
      file,
      range: rangeFromNode(callNode),
      message: "Could not statically expand tar_map(): missing values argument",
      alreadyDiagnosed: true,
      diagnostics
    };
  }

  const rows = parseValuesRows(valuesArgument.value);
  if (!rows) {
    diagnostics.push({
      range: rangeFromNode(valuesArgument.value),
      severity: "information",
      message: "Could not statically expand tar_map(): unsupported values expression"
    });
    return {
      kind: "Unknown",
      file,
      range: rangeFromNode(valuesArgument.value),
      message: "Could not statically expand tar_map(): unsupported values expression",
      alreadyDiagnosed: true,
      diagnostics
    };
  }

  const availableColumns = rows.length ? Object.keys(rows[0]) : [];
  const namesArgument = getNamedArgument(callNode, "names");
  const delimiterArgument = getNamedArgument(callNode, "delimiter");
  const selectedColumns = namesArgument && namesArgument.value
    ? parseNameColumns(namesArgument.value, availableColumns)
    : availableColumns;
  const delimiter = delimiterArgument && delimiterArgument.value && isStringNode(delimiterArgument.value)
    ? getStringValue(delimiterArgument.value)
    : "_";

  const templateArguments = unpackArguments(callNode).filter((argument) => {
    if (!argument.name) {
      return argument.index > 0;
    }

    return !TAR_MAP_CONTROL_ARGUMENTS.has(argument.name) && argument.name !== "values";
  });

  const templateTargets = [];
  for (const argument of templateArguments) {
    templateTargets.push(...collectTemplateTargets(argument.value, file, rangeFromNode(callNode), diagnostics));
  }

  if (!templateTargets.length) {
    diagnostics.push({
      range: rangeFromNode(callNode),
      severity: "information",
      message: "Could not statically expand tar_map(): no target templates were found"
    });
    return {
      kind: "Unknown",
      file,
      range: rangeFromNode(callNode),
      message: "Could not statically expand tar_map(): no target templates were found",
      alreadyDiagnosed: true,
      diagnostics
    };
  }

  const templateGeneratedNames = new Map();
  const generatedTargets = [];

  for (const row of rows) {
    // First compute all generated names for this row so templates can refer to
    // sibling template names within the same tar_map() expansion.
    const templateNameMap = {};
    for (const templateTarget of templateTargets) {
      const suffix = selectedColumns
        .filter((column) => Object.prototype.hasOwnProperty.call(row, column))
        .map((column) => row[column].namePart)
        .filter(Boolean);
      const generatedName = [templateTarget.name, ...suffix].join(delimiter);
      templateNameMap[templateTarget.name] = generatedName;
    }

    for (const templateTarget of templateTargets) {
      const generatedName = templateNameMap[templateTarget.name];
      if (!templateGeneratedNames.has(templateTarget.name)) {
        templateGeneratedNames.set(templateTarget.name, []);
      }
      templateGeneratedNames.get(templateTarget.name).push(generatedName);

      generatedTargets.push({
        name: generatedName,
        file,
        nameRange: templateTarget.nameRange,
        fullRange: rangeFromNode(callNode),
        commandRange: templateTarget.commandRange,
        patternRange: templateTarget.patternRange,
        origin: "tar_map",
        generated: true,
        generator: {
          file,
          range: rangeFromNode(callNode),
          templateName: templateTarget.name,
          bindings: Object.fromEntries(Object.entries(row).map(([key, binding]) => [key, binding.text])),
          generatedNamesPreview: []
        },
        _analysis: {
          bindings: row,
          commandNode: templateTarget._analysis.commandNode,
          patternNode: templateTarget._analysis.patternNode,
          templateName: templateTarget.name,
          templateNameMap
        }
      });
    }
  }

  for (const generatedTarget of generatedTargets) {
    const preview = templateGeneratedNames.get(generatedTarget.generator.templateName) || [];
    generatedTarget.generator.generatedNamesPreview = preview.slice(0, 8);
  }

  return {
    kind: "StaticMap",
    targets: generatedTargets,
    preview: {
      file,
      range: rangeFromNode(callNode),
      count: generatedTargets.length,
      generatedNamesPreview: generatedTargets.slice(0, 10).map((target) => target.name),
      templates: templateTargets.map((templateTarget) => ({
        templateName: templateTarget.name,
        commandRange: templateTarget.commandRange,
        patternRange: templateTarget.patternRange,
        generatedNames: (templateGeneratedNames.get(templateTarget.name) || []).slice()
      }))
    },
    diagnostics
  };
}

module.exports = {
  expandTarMap
};
