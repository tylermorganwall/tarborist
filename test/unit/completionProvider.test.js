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

function loadCompletionProviderWithMockVscode() {
  const mockVscode = {
    CompletionItem: class CompletionItem {
      constructor(label, kind) {
        this.kind = kind;
        this.label = label;
      }
    },
    CompletionItemKind: {
      Reference: 18
    },
    Range: class Range {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.end = { character: endCharacter, line: endLine };
        this.start = { character: startCharacter, line: startLine };
      }
    }
  };

  const modulePath = require.resolve("../../src/providers/completionProvider");
  delete require.cache[modulePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return mockVscode;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/providers/completionProvider");
  } finally {
    Module._load = originalLoad;
  }
}

function createDocument(text, filePath) {
  const lines = text.split("\n");
  return {
    lineAt(line) {
      return { text: lines[line] || "" };
    },
    getText(range) {
      if (!range) {
        return text;
      }

      const line = lines[range.start.line] || "";
      return line.slice(range.start.character, range.end.character);
    },
    getWordRangeAtPosition(position, regex) {
      const lineText = lines[position.line] || "";
      const matcher = new RegExp(regex.source, "g");
      let match = matcher.exec(lineText);

      while (match) {
        const startCharacter = match.index;
        const endCharacter = startCharacter + match[0].length;
        if (position.character >= startCharacter && position.character <= endCharacter) {
          return {
            end: { character: endCharacter, line: position.line },
            start: { character: startCharacter, line: position.line }
          };
        }

        match = matcher.exec(lineText);
      }

      return null;
    },
    uri: {
      fsPath: filePath
    }
  };
}

test.before(async () => {
  await ensureParserReady();
});

test("tar_map template completions wait for a two-character prefix", async () => {
  const { TargetCompletionProvider } = loadCompletionProviderWithMockVscode();
  const { index, root } = buildIndex("tar_map");
  const filePath = path.join(root, "_targets.R");
  const text = fs.readFileSync(filePath, "utf8");
  const lineIndex = text.split("\n").findIndex((line) => line.includes("tar_target(report_penguins"));
  const lineText = text.split("\n")[lineIndex];
  const fitIndex = lineText.indexOf("fit_penguins");
  const document = createDocument(text, filePath);
  const provider = new TargetCompletionProvider({
    async getIndexForUri() {
      return index;
    },
    getWorkspaceRoot() {
      return root;
    },
    logFailure() {}
  });

  const noPrefixItems = await provider.provideCompletionItems(document, {
    character: fitIndex,
    line: lineIndex
  });
  const twoCharacterItems = await provider.provideCompletionItems(document, {
    character: fitIndex + 2,
    line: lineIndex
  });

  assert.deepEqual(noPrefixItems, []);
  assert.ok(twoCharacterItems.some((item) => item.label === "fit_penguins"));
});
