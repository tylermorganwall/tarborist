"use strict";

// Build one diagnostic per target participating in a statically detected cycle.
const { createDiagnostic } = require("./unresolvedDiagnostics");

function buildCycleDiagnostics(targets, graph, partial) {
  const diagnostics = [];

  for (const cycle of graph.cycles) {
    const message = cycle.length === 1
      ? `${partial ? "Possible cycle detected in static pipeline index" : "Cycle detected"}: ${cycle[0]} -> ${cycle[0]}`
      : `${partial ? "Possible cycle detected in static pipeline index" : "Cycle detected"}: ${cycle.join(" -> ")} -> ${cycle[0]}`;

    for (const targetName of cycle) {
      const target = targets.get(targetName);
      if (!target) {
        continue;
      }

      diagnostics.push(createDiagnostic(target.file, target.nameRange, "error", message));
    }
  }

  return diagnostics;
}

module.exports = {
  buildCycleDiagnostics
};
