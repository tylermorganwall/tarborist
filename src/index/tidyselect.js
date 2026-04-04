"use strict";

// Evaluate a small static tidyselect subset against a list of target names.
const {
  getPositionalArgument,
  getStringValue,
  isStringNode,
  matchesCall,
  unpackArguments,
  unwrapNode
} = require("../parser/ast");

function uniqueOrdered(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    if (seen.has(item)) {
      continue;
    }

    seen.add(item);
    result.push(item);
  }

  return result;
}

function unionOrdered(left, right) {
  return uniqueOrdered([...left, ...right]);
}

function intersectionOrdered(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function differenceOrdered(availableNames, excludedNames) {
  const excluded = new Set(excludedNames);
  return availableNames.filter((name) => !excluded.has(name));
}

function parseStringVector(node) {
  const current = unwrapNode(node);
  if (!current) {
    return null;
  }

  if (isStringNode(current)) {
    return [getStringValue(current)];
  }

  if (current.type === "identifier") {
    return [current.text];
  }

  if (!matchesCall(current, new Set(["c"]))) {
    return null;
  }

  const values = [];
  for (const argument of unpackArguments(current)) {
    const nested = parseStringVector(argument.value);
    if (!nested) {
      return null;
    }

    values.push(...nested);
  }

  return values;
}

function matchHelperNames(helperName, helperValue, availableNames) {
  switch (helperName) {
    case "everything":
      return availableNames.slice();
    case "starts_with":
      return availableNames.filter((name) => name.startsWith(helperValue));
    case "ends_with":
      return availableNames.filter((name) => name.endsWith(helperValue));
    case "contains":
      return availableNames.filter((name) => name.includes(helperValue));
    case "matches": {
      const pattern = new RegExp(helperValue);
      return availableNames.filter((name) => pattern.test(name));
    }
    default:
      return null;
  }
}

function evaluateTidyselectNode(node, availableNames) {
  const current = unwrapNode(node);
  if (!current) {
    return {
      ok: false,
      reason: "unsupported empty tidyselect expression"
    };
  }

  if (isStringNode(current)) {
    return {
      ok: true,
      names: availableNames.includes(getStringValue(current)) ? [getStringValue(current)] : []
    };
  }

  if (current.type === "identifier") {
    return {
      ok: true,
      names: availableNames.includes(current.text) ? [current.text] : []
    };
  }

  if (current.type === "unary_operator") {
    const operator = current.children && current.children.length ? current.children[0].text : null;
    const operand = current.namedChildren && current.namedChildren.length ? current.namedChildren[current.namedChildren.length - 1] : null;
    if (operator !== "!" && operator !== "-") {
      return {
        ok: false,
        reason: `unsupported tidyselect unary operator '${operator || "?"}'`
      };
    }

    const evaluated = evaluateTidyselectNode(operand, availableNames);
    if (!evaluated.ok) {
      return evaluated;
    }

    return {
      ok: true,
      names: differenceOrdered(availableNames, evaluated.names)
    };
  }

  if (current.type === "binary_operator") {
    const lhs = current.childForFieldName ? current.childForFieldName("lhs") : null;
    const rhs = current.childForFieldName ? current.childForFieldName("rhs") : null;
    const operatorNode = current.childForFieldName ? current.childForFieldName("operator") : null;
    const operator = operatorNode ? operatorNode.text : null;

    if (!lhs || !rhs || !operator) {
      return {
        ok: false,
        reason: "unsupported tidyselect binary expression"
      };
    }

    const left = evaluateTidyselectNode(lhs, availableNames);
    if (!left.ok) {
      return left;
    }

    const right = evaluateTidyselectNode(rhs, availableNames);
    if (!right.ok) {
      return right;
    }

    if (operator === "|") {
      return {
        ok: true,
        names: unionOrdered(left.names, right.names)
      };
    }

    if (operator === "&") {
      return {
        ok: true,
        names: intersectionOrdered(left.names, right.names)
      };
    }

    if (operator === ":") {
      if (left.names.length !== 1 || right.names.length !== 1) {
        return {
          ok: false,
          reason: "tidyselect ':' requires single start and end names"
        };
      }

      const start = availableNames.indexOf(left.names[0]);
      const end = availableNames.indexOf(right.names[0]);
      if (start < 0 || end < 0) {
        return {
          ok: true,
          names: []
        };
      }

      const [from, to] = start <= end ? [start, end] : [end, start];
      return {
        ok: true,
        names: availableNames.slice(from, to + 1)
      };
    }

    return {
      ok: false,
      reason: `unsupported tidyselect operator '${operator}'`
    };
  }

  if (!matchesCall(current, new Set([
    "all_of",
    "any_of",
    "c",
    "contains",
    "ends_with",
    "everything",
    "matches",
    "starts_with"
  ]))) {
    return {
      ok: false,
      reason: "unsupported tidyselect helper"
    };
  }

  const helper = current.childForFieldName ? current.childForFieldName("function") : null;
  const helperName = helper ? helper.text.split("::").pop() : null;
  if (!helperName) {
    return {
      ok: false,
      reason: "unsupported tidyselect helper"
    };
  }

  if (helperName === "c") {
    let names = [];
    for (const argument of unpackArguments(current)) {
      const evaluated = evaluateTidyselectNode(argument.value, availableNames);
      if (!evaluated.ok) {
        return evaluated;
      }

      names = unionOrdered(names, evaluated.names);
    }

    return {
      ok: true,
      names
    };
  }

  if (helperName === "all_of" || helperName === "any_of") {
    const firstArgument = getPositionalArgument(current, 0);
    const values = firstArgument && firstArgument.value ? parseStringVector(firstArgument.value) : null;
    if (!values) {
      return {
        ok: false,
        reason: `${helperName}() requires a static character vector`
      };
    }

    if (helperName === "all_of" && values.some((value) => !availableNames.includes(value))) {
      return {
        ok: false,
        reason: "all_of() references missing target names"
      };
    }

    return {
      ok: true,
      names: values.filter((value) => availableNames.includes(value))
    };
  }

  const firstArgument = getPositionalArgument(current, 0);
  const helperValue = firstArgument && firstArgument.value && isStringNode(firstArgument.value)
    ? getStringValue(firstArgument.value)
    : null;
  if (helperName !== "everything" && helperValue === null) {
    return {
      ok: false,
      reason: `${helperName}() requires a literal string`
    };
  }

  const names = matchHelperNames(helperName, helperValue, availableNames);
  if (!names) {
    return {
      ok: false,
      reason: "unsupported tidyselect helper"
    };
  }

  return {
    ok: true,
    names
  };
}

module.exports = {
  evaluateTidyselectNode
};
