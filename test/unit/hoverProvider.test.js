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

function loadHoverProviderWithMockVscode() {
  const mockVscode = {
    Hover: class Hover {
      constructor(contents) {
        this.contents = Array.isArray(contents) ? contents : [contents];
      }
    },
    MarkdownString: class MarkdownString {
      constructor() {
        this.value = "";
        this.isTrusted = false;
        this.supportThemeIcons = false;
      }

      appendMarkdown(text) {
        this.value += text;
      }
    }
  };

  const modulePath = require.resolve("../../src/providers/hoverProvider");
  delete require.cache[modulePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return mockVscode;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/providers/hoverProvider");
  } finally {
    Module._load = originalLoad;
  }
}

function createDocument(text, filePath) {
  const lines = text.split("\n");
  const lineOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  function offsetAt(position) {
    return (lineOffsets[position.line] || 0) + position.character;
  }

  function positionAt(offsetValue) {
    let line = 0;
    for (let i = 0; i < lineOffsets.length; i += 1) {
      const nextOffset = i + 1 < lineOffsets.length ? lineOffsets[i + 1] : text.length + 1;
      if (offsetValue >= lineOffsets[i] && offsetValue < nextOffset) {
        line = i;
        break;
      }
    }

    return {
      line,
      character: offsetValue - lineOffsets[line]
    };
  }

  return {
    uri: {
      fsPath: filePath
    },
    getText(range) {
      if (!range) {
        return text;
      }

      return text.slice(offsetAt(range.start), offsetAt(range.end));
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
            start: { line: position.line, character: startCharacter },
            end: { line: position.line, character: endCharacter }
          };
        }

        match = matcher.exec(lineText);
      }

      return null;
    },
    positionAt
  };
}

test.before(async () => {
  await ensureParserReady();
});

test("hovering a tar_combine() alias outside target code uses the target hover", async () => {
  const { TargetHoverProvider } = loadHoverProviderWithMockVscode();
  const { index, root } = buildIndex("tar_combine");
  const filePath = path.join(root, "_targets.R");
  const text = fs.readFileSync(filePath, "utf8");
  const document = createDocument(text, filePath);
  const lineIndex = text.split("\n").findIndex((line) => line.trim() === "combined");
  const position = { line: lineIndex, character: 2 };
  const provider = new TargetHoverProvider({
    async getIndexForUri() {
      return index;
    },
    getWorkspaceRoot() {
      return root;
    }
  });

  const hover = await provider.provideHover(document, position);
  const markdown = hover.contents[0].value;

  assert.match(markdown, /### \$\(symbol-field\) Target `combined`/);
  assert.match(markdown, /`first`/);
  assert.match(markdown, /`second`/);
  assert.doesNotMatch(markdown, /Pipeline object `combined`/);
});
