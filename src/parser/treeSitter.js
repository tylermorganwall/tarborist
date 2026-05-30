"use strict";

// Singleton WASM-backed Tree-sitter R parser used by all indexing passes.
const path = require("path");

let TreeSitter;
let language;
let parser;
let parserReady;

function loadTreeSitterRuntime() {
  if (!TreeSitter) {
    TreeSitter = require("web-tree-sitter");
  }

  return TreeSitter;
}

function resetTreeSitterRuntime() {
  try {
    delete require.cache[require.resolve("web-tree-sitter")];
  } catch (_error) {
    // If the module cannot be resolved, the next require() will surface it.
  }

  TreeSitter = null;
  language = null;
}

function isTreeSitterRuntimeError(error) {
  const message = String(error && error.message ? error.message : error);
  return error instanceof WebAssembly.RuntimeError ||
    /Aborted\(/.test(message) ||
    /memory access out of bounds/i.test(message) ||
    /table index is out of bounds/i.test(message);
}

function isParserUnavailableError(error) {
  const message = String(error && error.message ? error.message : error);
  return isTreeSitterRuntimeError(error) ||
    /Tree-sitter parser is not initialized/i.test(message) ||
    /cannot construct a Parser before calling `init\(\)`/i.test(message);
}

function resetParser(options = {}) {
  if (parser && typeof parser.delete === "function") {
    try {
      parser.delete();
    } catch (_error) {
      // Best-effort cleanup only. The next ensureParserReady() call will rebuild.
    }
  }

  parser = null;
  parserReady = null;
  language = null;

  if (options.reloadRuntime) {
    resetTreeSitterRuntime();
  }
}

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
    const initializeParser = async () => {
      const runtime = loadTreeSitterRuntime();
      await runtime.Parser.init();

      // Load the compiled R grammar once and reuse the parser across files.
      const grammarRoot = path.dirname(require.resolve("@davisvaughan/tree-sitter-r/package.json"));
      language = await runtime.Language.load(path.join(grammarRoot, "tree-sitter-r.wasm"));

      parser = new runtime.Parser();
      parser.setLanguage(language);
      return parser;
    };

    parserReady = (async () => {
      try {
        return await initializeParser();
      } catch (error) {
        if (!isTreeSitterRuntimeError(error)) {
          throw error;
        }

        resetParser({
          reloadRuntime: true
        });
        return initializeParser();
      }
    })().catch((error) => {
      if (isTreeSitterRuntimeError(error)) {
        resetParser({
          reloadRuntime: true
        });
      } else {
        parserReady = null;
      }
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
    const parserWasInitialized = Boolean(parser);
    resetParser({
      reloadRuntime: isTreeSitterRuntimeError(error)
    });
    throw buildParseError(error, text, {
      ...context,
      parserReset: parserWasInitialized
    });
  }
}

module.exports = {
  ensureParserReady,
  getParser,
  isParserUnavailableError,
  isTreeSitterRuntimeError,
  parseText,
  resetParser
};
