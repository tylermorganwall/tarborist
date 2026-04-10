"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const test = require("node:test");

const { buildStaticWorkspaceIndex } = require("../../src/index/pipelineResolver");
const { ensureParserReady } = require("../../src/parser/treeSitter");

function buildIndex(fixtureName) {
  const root = path.resolve(__dirname, "..", "fixtures", fixtureName);
  return {
    index: buildStaticWorkspaceIndex({
      readFile: (file) => fs.readFileSync(file, "utf8"),
      workspaceRoot: root
    }),
    root
  };
}

function loadSymbolProvidersWithMockVscode() {
  const mockVscode = {
    DocumentSymbol: class DocumentSymbol {
      constructor(name, detail, kind, range, selectionRange) {
        this.name = name;
        this.detail = detail;
        this.kind = kind;
        this.range = range;
        this.selectionRange = selectionRange;
        this.children = [];
      }
    },
    Location: class Location {
      constructor(uri, range) {
        this.uri = uri;
        this.range = range;
      }
    },
    Position: class Position {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    Range: class Range {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    SymbolInformation: class SymbolInformation {
      constructor(name, kind, containerName, location) {
        this.name = name;
        this.kind = kind;
        this.containerName = containerName;
        this.location = location;
      }
    },
    SymbolKind: {
      Variable: 13
    },
    Uri: {
      file(filePath) {
        return {
          fsPath: filePath
        };
      }
    }
  };

  const workspaceModulePath = require.resolve("../../src/providers/workspaceSymbolProvider");
  const documentModulePath = require.resolve("../../src/providers/documentSymbolProvider");
  delete require.cache[workspaceModulePath];
  delete require.cache[documentModulePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return mockVscode;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return {
      ...require("../../src/providers/workspaceSymbolProvider"),
      ...require("../../src/providers/documentSymbolProvider")
    };
  } finally {
    Module._load = originalLoad;
  }
}

test.before(async () => {
  await ensureParserReady();
});

test("workspace symbols include targets disabled in the final pipeline", () => {
  const { TargetWorkspaceSymbolProvider } = loadSymbolProvidersWithMockVscode();
  const { index, root } = buildIndex("tar_select_targets");
  const provider = new TargetWorkspaceSymbolProvider({
    indices: new Map([[root, index]])
  });

  const symbols = provider.provideWorkspaceSymbols("bet");
  const beta = symbols.find((symbol) => symbol.name === "beta");

  assert.ok(beta);
  assert.match(beta.containerName, /disabled in final pipeline/);
  assert.ok(beta.location.uri.fsPath.endsWith(path.join("tar_select_targets", "_targets.R")));
});

test("workspace symbols resolve generated targets to the tar_map() generator location", () => {
  const { TargetWorkspaceSymbolProvider } = loadSymbolProvidersWithMockVscode();
  const { index, root } = buildIndex("tar_map");
  const provider = new TargetWorkspaceSymbolProvider({
    indices: new Map([[root, index]])
  });

  const symbols = provider.provideWorkspaceSymbols("fit_penguins_adelie");
  const symbol = symbols.find((item) => item.name === "fit_penguins_adelie");
  const generatedTarget = index.completionTargets.get("fit_penguins_adelie");

  assert.ok(symbol);
  assert.equal(symbol.location.uri.fsPath, generatedTarget.generator.file);
  assert.deepEqual(symbol.location.range.start, generatedTarget.generator.range.start);
});

test("document symbols expose the full target universe for the current file", async () => {
  const { TargetDocumentSymbolProvider } = loadSymbolProvidersWithMockVscode();
  const { index, root } = buildIndex("tar_select_targets");
  const provider = new TargetDocumentSymbolProvider({
    async getIndexForUri() {
      return index;
    }
  });

  const symbols = await provider.provideDocumentSymbols({
    uri: {
      fsPath: path.join(root, "_targets.R")
    }
  });
  const names = symbols.map((symbol) => symbol.name);

  assert.deepEqual(names, ["alpha", "beta", "gamma", "lambda"]);
  assert.match(symbols.find((symbol) => symbol.name === "beta").detail, /disabled in final pipeline/);
});

test("document symbols include generated tar_map() targets in the source file outline", async () => {
  const { TargetDocumentSymbolProvider } = loadSymbolProvidersWithMockVscode();
  const { index, root } = buildIndex("tar_map");
  const provider = new TargetDocumentSymbolProvider({
    async getIndexForUri() {
      return index;
    }
  });

  const symbols = await provider.provideDocumentSymbols({
    uri: {
      fsPath: path.join(root, "_targets.R")
    }
  });

  assert.ok(symbols.some((symbol) => symbol.name === "fit_penguins_adelie"));
  assert.match(symbols.find((symbol) => symbol.name === "fit_penguins_adelie").detail, /generated target/);
});
