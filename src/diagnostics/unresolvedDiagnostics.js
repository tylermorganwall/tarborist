"use strict";

// Minimal diagnostic record helpers shared across the static analysis pipeline.
function createDiagnostic(file, range, severity, message) {
  return {
    file,
    message,
    range,
    severity
  };
}

function groupDiagnosticsByFile(diagnostics) {
  const grouped = new Map();

  for (const diagnostic of diagnostics) {
    if (!grouped.has(diagnostic.file)) {
      grouped.set(diagnostic.file, []);
    }

    grouped.get(diagnostic.file).push(diagnostic);
  }

  return grouped;
}

module.exports = {
  createDiagnostic,
  groupDiagnosticsByFile
};
