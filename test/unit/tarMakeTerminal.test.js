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
  return buildStaticWorkspaceIndex({
    readFile: (file) => fs.readFileSync(file, "utf8"),
    workspaceRoot: root
  });
}

test.before(async () => {
  await ensureParserReady();
});

function loadTarMakeTerminalModule() {
  const mockVscode = {
    TerminalLink: class TerminalLink {
      constructor(startIndex, length, tooltip) {
        this.length = length;
        this.startIndex = startIndex;
        this.tooltip = tooltip;
      }
    }
  };

  const modulePath = require.resolve("../../src/terminal/tarMakeTerminal");
  delete require.cache[modulePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return mockVscode;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/terminal/tarMakeTerminal");
  } finally {
    Module._load = originalLoad;
  }
}

test("terminal link matching finds exact target names in tar_make output", () => {
  const { findTerminalTargetMatches } = loadTarMakeTerminalModule();
  const index = buildIndex("direct");
  const matches = findTerminalTargetMatches("✔ ended target b [0.12 seconds]", index);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].target.name, "b");
  assert.equal(matches[0].startIndex, "✔ ended target ".length);
});

test("terminal link provider uses generated target destinations from the shared resolver", () => {
  const { TarMakeTerminalLinkProvider } = loadTarMakeTerminalModule();
  const index = buildIndex("tar_map");
  const root = path.resolve(__dirname, "..", "fixtures", "tar_map");
  const terminal = {
    creationOptions: {},
    shellIntegration: null
  };
  const provider = new TarMakeTerminalLinkProvider(
    { indices: new Map([[root, index]]) },
    new Map([[terminal, root]])
  );

  const links = provider.provideTerminalLinks({
    line: "→ building fit_penguins_adelie",
    terminal
  });

  assert.equal(links.length, 1);
  assert.equal(links[0].payload.target.name, "fit_penguins_adelie");
  assert.equal(links[0].payload.file, index.targets.get("fit_penguins_adelie").generator.file);
  assert.deepEqual(links[0].payload.range, index.targets.get("fit_penguins_adelie").generator.range);
});
