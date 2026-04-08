"use strict";

// Singleton WASM-backed Tree-sitter R parser used by all indexing passes.
const path = require("path");

const TreeSitter = require("web-tree-sitter");

let parser;
let parserReady;

function summarizeText(text) {
  const source = typeof text === "string" ? text : "";
  const lineCount = source ? source.split(/\r?\n/).length : 0;
  const preview = source
    .slice(0, 200)
    .replace(/\s+/g, " ")
    .trim();

  return {
    lineCount,
    preview: preview || "<empty>",
    textLength: source.length
  };
}

function buildParseError(error, text, context = {}) {
  const summary = summarizeText(text);
  const details = [
    "Tree-sitter parse failed",
    context.phase ? `phase=${context.phase}` : null,
    context.file ? `file=${context.file}` : null,
    context.label ? `label=${context.label}` : null,
    Number.isFinite(context.line) ? `line=${context.line}` : null,
    Number.isFinite(context.character) ? `character=${context.character}` : null,
    context.word ? `word=${JSON.stringify(context.word)}` : null,
    context.linePreview ? `linePreview=${JSON.stringify(context.linePreview)}` : null,
    `chars=${summary.textLength}`,
    `lines=${summary.lineCount}`,
    `preview=${JSON.stringify(summary.preview)}`,
    `cause=${error && error.message ? error.message : String(error)}`
  ].filter(Boolean);

  const wrapped = new Error(details.join(" | "));
  wrapped.cause = error;
  wrapped.parseContext = {
    ...context,
    ...summary
  };
  return wrapped;
}

async function ensureParserReady() {
  if (parser) {
    return parser;
  }

  if (!parserReady) {
    parserReady = (async () => {
      await TreeSitter.Parser.init();

      // Load the compiled R grammar once and reuse the parser across files.
      const grammarRoot = path.dirname(require.resolve("@davisvaughan/tree-sitter-r/package.json"));
      const language = await TreeSitter.Language.load(path.join(grammarRoot, "tree-sitter-r.wasm"));

      parser = new TreeSitter.Parser();
      parser.setLanguage(language);
      return parser;
    })().catch((error) => {
      parserReady = null;
      throw error;
    });
  }

  return parserReady;
}

function getParser() {
  if (!parser) {
    throw new Error("Tree-sitter parser is not initialized. Call ensureParserReady() before parsing.");
  }

  return parser;
}

function parseText(text, context = {}) {
  try {
    return getParser().parse(text);
  } catch (error) {
    throw buildParseError(error, text, context);
  }
}

module.exports = {
  ensureParserReady,
  getParser,
  parseText
};
