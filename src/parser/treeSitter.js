"use strict";

// Singleton WASM-backed Tree-sitter R parser used by all indexing passes.
const path = require("path");

let TreeSitter;
let language;
let parser;
let parserReady;
let parserGeneration = 0;
let runtimeGeneration = 0;
let runtimeInitialized = false;
let activeScope = null;
const statistics = { parses: 0, liveTrees: 0, resets: 0 };

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
  runtimeInitialized = false;
  runtimeGeneration += 1;
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
  // A pending initialization must finish against its own runtime. It cannot
  // publish into the next generation or change that generation's WASM binding.
  let reloadRuntime = options.reloadRuntime || Boolean(parserReady && !parser);
  if (!options.reloadRuntime && parser && typeof parser.delete === "function") {
    try {
      parser.delete();
    } catch (_error) {
      // Cleanup must not hide the original failure.
      reloadRuntime = true;
    }
  }
  parser = null;
  parserReady = null;
  parserGeneration += 1;
  statistics.resets += 1;
  if (reloadRuntime) {
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

function ensureParserReady() {
  if (parser) {
    return Promise.resolve(parser);
  }
  if (parserReady) {
    return parserReady;
  }

  const generation = parserGeneration;
  const initialize = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let candidate;
      try {
        const runtime = loadTreeSitterRuntime();
        if (!runtimeInitialized) {
          await runtime.Parser.init();
          if (generation !== parserGeneration) {
            return ensureParserReady();
          }
          runtimeInitialized = true;
        }
        const grammarRoot = path.dirname(require.resolve("@davisvaughan/tree-sitter-r/package.json"));
        const loadedLanguage = language || await runtime.Language.load(path.join(grammarRoot, "tree-sitter-r.wasm"));
        if (generation !== parserGeneration) {
          return ensureParserReady();
        }
        candidate = new runtime.Parser();
        candidate.setLanguage(loadedLanguage);
        language = loadedLanguage;
        parser = candidate;
        return parser;
      } catch (error) {
        if (generation !== parserGeneration) {
          return ensureParserReady();
        }
        if (isTreeSitterRuntimeError(error)) {
          // Keep the same shared promise throughout the retry.
          resetTreeSitterRuntime();
          if (attempt === 0) {
            continue;
          }
        } else if (candidate && typeof candidate.delete === "function") {
          try {
            candidate.delete();
          } catch (_error) {
            resetTreeSitterRuntime();
          }
        }
        throw error;
      }
    }
  };
  const ready = initialize().finally(() => {
    if (parserReady === ready) {
      parserReady = null;
    }
  });
  parserReady = ready;
  return ready;
}

// All operations using a scope are synchronous: nodes cannot escape or survive
// an await. Completed indexes and provider results contain only plain data.
function withTreeScope(operation) {
  const previousScope = activeScope;
  const scope = [];
  activeScope = scope;
  try {
    return operation();
  } catch (error) {
    if (isTreeSitterRuntimeError(error) && parser) {
      resetParser({ reloadRuntime: true });
    }
    throw error;
  } finally {
    activeScope = previousScope;
    for (const { tree, generation } of scope) {
      statistics.liveTrees -= 1;
      if (generation !== runtimeGeneration) {
        continue;
      }
      try {
        tree.delete();
      } catch (_error) {
        // Do not call further destructors against a failed runtime.
        resetParser({ reloadRuntime: true });
      }
    }
  }
}

async function runParserOperation(operation, options = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ensureParserReady();
      return withTreeScope(operation);
    } catch (error) {
      const recoverable = isParserUnavailableError(error);
      if (attempt || (!recoverable && !options.retryAll)) {
        throw error;
      }
      if (recoverable && parser) {
        resetParser({ reloadRuntime: isTreeSitterRuntimeError(error) });
      }
      if (options.onRetry) {
        options.onRetry(error);
      }
    }
  }
}

function getParserStatistics() {
  return { ...statistics, parserGeneration, runtimeGeneration };
}

function getParser() {
  if (!parser) {
    throw new Error("Tree-sitter parser is not initialized. Call ensureParserReady() before parsing.");
  }

  return parser;
}

function parseText(text, context = {}) {
  try {
    const tree = getParser().parse(text);
    if (!tree) {
      throw new Error("Tree-sitter parser is not initialized: parsing returned no tree");
    }
    statistics.parses += 1;
    if (activeScope) {
      activeScope.push({ tree, generation: runtimeGeneration });
      statistics.liveTrees += 1;
    }
    return tree;
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
  getParserStatistics,
  isParserUnavailableError,
  isTreeSitterRuntimeError,
  parseText,
  resetParser,
  runParserOperation,
  withTreeScope
};
