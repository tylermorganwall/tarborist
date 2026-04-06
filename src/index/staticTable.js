"use strict";

// Resolve a very small, explicitly safe subset of table-building code for
// tar_map(values = ...) without evaluating arbitrary user R.
const {
  getPositionalArgument,
  getStringValue,
  isStringNode,
  matchesCall,
  unpackArguments,
  unwrapNode
} = require("../parser/ast");

const EXPAND_GRID_CALLS = new Set(["expand_grid", "tidyr::expand_grid", "expand.grid", "base::expand.grid"]);
const BIND_ROWS_CALLS = new Set(["bind_rows", "dplyr::bind_rows", "rbind", "base::rbind"]);
const ROW_TABLE_CALLS = new Set(["data.frame", "tibble", "tibble::tibble"]);
const BASE_EXPAND_GRID_CONTROL_ARGUMENTS = new Set(["KEEP.OUT.ATTRS", "stringsAsFactors"]);

function sanitizeNamePart(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._]+/g, "_")
    .replace(/^_+|_+$/g, "") || "value";
}

function createStaticTable(rows) {
  return {
    kind: "StaticTable",
    rows
  };
}

function isStaticTable(value) {
  return Boolean(value && value.kind === "StaticTable" && Array.isArray(value.rows));
}

function bindingValueFromNode(node) {
  // Store the original node/text so later target-ref extraction can substitute
  // through tar_map bindings without re-parsing anything.
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

function buildBroadcastRows(columns) {
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

function buildExpandGridRows(columns) {
  const names = Object.keys(columns);
  if (!names.length) {
    return [];
  }

  const rows = [];
  const visit = (columnIndex, row) => {
    if (columnIndex >= names.length) {
      rows.push({ ...row });
      return;
    }

    const name = names[columnIndex];
    const values = columns[name];
    if (!values.length) {
      return;
    }

    for (const value of values) {
      row[name] = value;
      visit(columnIndex + 1, row);
    }
  };

  visit(0, {});
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

function parseLiteralRows(node) {
  // Accept row-like literal tables that tar_map() already supported before the
  // StaticTable symbol work, e.g. list(a = c(...)) and tibble(a = 1:2).
  const current = unwrapNode(node);
  if (!current) {
    return null;
  }

  if (matchesCall(current, new Set(["list", ...ROW_TABLE_CALLS]))) {
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

      return buildBroadcastRows(columns);
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

function resolveExpandGrid(node) {
  const current = unwrapNode(node);
  if (!matchesCall(current, EXPAND_GRID_CALLS)) {
    return null;
  }

  const isBaseExpandGrid = matchesCall(current, new Set(["expand.grid", "base::expand.grid"]));
  const columns = {};
  for (const argument of unpackArguments(current)) {
    if (isBaseExpandGrid && argument.name && BASE_EXPAND_GRID_CONTROL_ARGUMENTS.has(argument.name)) {
      continue;
    }

    if (!argument.name) {
      return null;
    }

    const values = parseVectorValues(argument.value);
    if (!values) {
      return null;
    }

    columns[argument.name] = values;
  }

  return createStaticTable(buildExpandGridRows(columns));
}

function cloneRows(rows) {
  return rows.map((row) => ({ ...row }));
}

function resolveBindRows(node, env) {
  const current = unwrapNode(node);
  if (!matchesCall(current, BIND_ROWS_CALLS)) {
    return null;
  }

  const rows = [];
  for (const argument of unpackArguments(current)) {
    if (!argument.value) {
      return null;
    }

    const resolved = resolveStaticTableExpression(argument.value, env);
    if (!isStaticTable(resolved)) {
      return null;
    }

    rows.push(...cloneRows(resolved.rows));
  }

  return createStaticTable(rows);
}

function resolveStaticTableExpression(node, env) {
  const current = unwrapNode(node);
  if (!current) {
    return null;
  }

  if (current.type === "identifier") {
    const value = env.get(current.text);
    return isStaticTable(value) ? createStaticTable(cloneRows(value.rows)) : null;
  }

  if (matchesCall(current, ROW_TABLE_CALLS)) {
    const inlineRows = parseLiteralRows(current);
    if (inlineRows !== null) {
      return createStaticTable(inlineRows);
    }
  }

  const expanded = resolveExpandGrid(current);
  if (expanded) {
    return expanded;
  }

  const boundRows = resolveBindRows(current, env);
  if (boundRows) {
    return boundRows;
  }

  return null;
}

function resolveStaticTableRows(node, env) {
  const resolved = resolveStaticTableExpression(node, env);
  if (resolved) {
    return resolved.rows;
  }

  const inlineRows = parseLiteralRows(node);
  if (inlineRows !== null) {
    return inlineRows;
  }

  return null;
}

function assignStaticTableColumn(value, columnName, valueNode) {
  if (!isStaticTable(value)) {
    return null;
  }

  const values = parseVectorValues(valueNode);
  if (!values) {
    return null;
  }

  const rowCount = value.rows.length;
  if (!rowCount) {
    if (values.length !== 1) {
      return null;
    }

    return createStaticTable([]);
  }

  if (values.length !== 1 && values.length !== rowCount) {
    return null;
  }

  const rows = value.rows.map((row, index) => ({
    ...row,
    [columnName]: values.length === 1 ? values[0] : values[index]
  }));

  return createStaticTable(rows);
}

module.exports = {
  assignStaticTableColumn,
  bindingValueFromNode,
  createStaticTable,
  isStaticTable,
  parseLiteralRows,
  parseVectorValues,
  resolveStaticTableExpression,
  resolveStaticTableRows
};
