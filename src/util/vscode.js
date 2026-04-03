"use strict";

// Convert tarborist's plain JS data model into VS Code editor objects.
const vscode = require("vscode");
const { zeroRange } = require("./ranges");

function toVsCodePosition(position) {
  return new vscode.Position(position.line, position.character);
}

function toVsCodeRange(range) {
  const safeRange = range || zeroRange();
  return new vscode.Range(
    safeRange.start.line,
    safeRange.start.character,
    safeRange.end.line,
    safeRange.end.character
  );
}

function toVsCodeLocation(file, range) {
  return new vscode.Location(vscode.Uri.file(file), toVsCodeRange(range));
}

function toSeverity(severity) {
  switch (severity) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "information":
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Hint;
  }
}

function toVsCodeDiagnostic(diagnostic) {
  const result = new vscode.Diagnostic(
    toVsCodeRange(diagnostic.range),
    diagnostic.message,
    toSeverity(diagnostic.severity)
  );
  result.source = "tarborist";
  return result;
}

module.exports = {
  toVsCodeDiagnostic,
  toVsCodeLocation,
  toVsCodePosition,
  toVsCodeRange
};
