"use strict";

// Singleton WASM-backed Tree-sitter R parser used by all indexing passes.
const path = require("path");

const TreeSitter = require("web-tree-sitter");

let parser;
let parserReady;

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

function parseText(text) {
  return getParser().parse(text);
}

module.exports = {
  ensureParserReady,
  getParser,
  parseText
};
