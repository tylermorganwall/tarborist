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
    CompletionList: class CompletionList {
      constructor(items, isIncomplete) {
        this.isIncomplete = isIncomplete;
        this.items = items;
      }
    },
    CompletionItemKind: {
      Reference: 18
    },
    workspace: {
      getConfiguration() {
        return {
          get() {
            return [];
          }
        };
      }
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

test("tar_map template completions wait for a three-character prefix", async () => {
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
  const threeCharacterItems = await provider.provideCompletionItems(document, {
    character: fitIndex + 3,
    line: lineIndex
  });

  if (Array.isArray(noPrefixItems)) {
    assert.deepEqual(noPrefixItems, []);
  } else {
    assert.deepEqual(noPrefixItems.items, []);
    assert.equal(noPrefixItems.isIncomplete, true);
  }
  assert.ok(threeCharacterItems.some((item) => item.label === "fit_penguins"));
});

test("triggered completions stay incomplete until a three-character prefix is typed", async () => {
  const { TargetCompletionProvider } = loadCompletionProviderWithMockVscode();
  const { index, root } = buildIndex("completion_live_region");
  const filePath = path.join(root, "_targets.R");
  const text = fs.readFileSync(filePath, "utf8").replace(
    "tar_target(lambda, 3)",
    "tar_target(lambda, 3 + alp)"
  );
  const lineIndex = text.split("\n").findIndex((line) => line.includes("tar_target(lambda, 3 + alp)"));
  const lineText = text.split("\n")[lineIndex];
  const positionAfterPlus = lineText.indexOf("+") + 1;
  const positionAfterOneCharacter = lineText.indexOf("a") + 1;
  const positionAfterTwoCharacters = lineText.indexOf("al") + 2;
  const positionAfterThreeCharacters = lineText.indexOf("alp") + 3;
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

  const plusTriggeredItems = await provider.provideCompletionItems(
    document,
    {
      character: positionAfterPlus,
      line: lineIndex
    },
    undefined,
    {
      triggerCharacter: "+",
      triggerKind: 1
    }
  );
  const oneCharacterItems = await provider.provideCompletionItems(document, {
    character: positionAfterOneCharacter,
    line: lineIndex
  });
  const twoCharacterItems = await provider.provideCompletionItems(document, {
    character: positionAfterTwoCharacters,
    line: lineIndex
  });
  const threeCharacterItems = await provider.provideCompletionItems(document, {
    character: positionAfterThreeCharacters,
    line: lineIndex
  });

  if (Array.isArray(plusTriggeredItems)) {
    assert.deepEqual(plusTriggeredItems, []);
  } else {
    assert.deepEqual(plusTriggeredItems.items, []);
    assert.equal(plusTriggeredItems.isIncomplete, true);
  }
  if (Array.isArray(oneCharacterItems)) {
    assert.deepEqual(oneCharacterItems, []);
  } else {
    assert.deepEqual(oneCharacterItems.items, []);
    assert.equal(oneCharacterItems.isIncomplete, true);
  }
  if (Array.isArray(twoCharacterItems)) {
    assert.deepEqual(twoCharacterItems, []);
  } else {
    assert.deepEqual(twoCharacterItems.items, []);
    assert.equal(twoCharacterItems.isIncomplete, true);
  }
  assert.ok(threeCharacterItems.some((item) => item.label === "alpha"));
});

test("assigned target lists still provide target completions inside target commands", async () => {
  const { TargetCompletionProvider } = loadCompletionProviderWithMockVscode();
  const { index, root } = buildIndex("completion_assigned");
  const filePath = path.join(root, "_targets.R");
  const text = fs.readFileSync(filePath, "utf8");
  const lineIndex = text.split("\n").findIndex((line) => line.includes("tar_target(lambda, 3 + alpha)"));
  const lineText = text.split("\n")[lineIndex];
  const position = {
    character: lineText.indexOf("alpha") + 3,
    line: lineIndex
  };
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

  const items = await provider.provideCompletionItems(document, position);

  assert.ok(items.some((item) => item.label === "alpha"));
  assert.ok(items.some((item) => item.label === "beta"));
  assert.ok(items.some((item) => item.label === "gamma"));
});

test("live completions still work after editing past the saved command range", async () => {
  const { TargetCompletionProvider } = loadCompletionProviderWithMockVscode();
  const { index, root } = buildIndex("completion_live_region");
  const filePath = path.join(root, "_targets.R");
  const text = fs.readFileSync(filePath, "utf8").replace(
    "tar_target(lambda, 3)",
    "tar_target(lambda, 3 + alp)"
  );
  const lineIndex = text.split("\n").findIndex((line) => line.includes("tar_target(lambda, 3 + alp)"));
  const lineText = text.split("\n")[lineIndex];
  const position = {
    character: lineText.indexOf("alp)") + 3,
    line: lineIndex
  };
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

  const items = await provider.provideCompletionItems(document, position);

  assert.ok(items.some((item) => item.label === "alpha"));
  assert.ok(items.some((item) => item.label === "beta"));
  assert.ok(items.some((item) => item.label === "gamma"));
});

test("typed prefixes keep the full valid target set visible while ranking matches first", async () => {
  const { TargetCompletionProvider } = loadCompletionProviderWithMockVscode();
  const { index, root } = buildIndex("completion_live_region");
  const filePath = path.join(root, "_targets.R");
  const text = fs.readFileSync(filePath, "utf8").replace(
    "tar_target(lambda, 3)",
    "tar_target(lambda, 3 + alp)"
  );
  const lineIndex = text.split("\n").findIndex((line) => line.includes("tar_target(lambda, 3 + alp)"));
  const lineText = text.split("\n")[lineIndex];
  const position = {
    character: lineText.indexOf("alp)") + 3,
    line: lineIndex
  };
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

  const items = await provider.provideCompletionItems(document, position);
  const labels = items.map((item) => item.label);

  assert.ok(labels.includes("alpha"));
  assert.ok(labels.includes("beta"));
  assert.ok(labels.includes("gamma"));
  const alphaItem = items.find((item) => item.label === "alpha");
  const betaItem = items.find((item) => item.label === "beta");
  const gammaItem = items.find((item) => item.label === "gamma");

  assert.equal(alphaItem.filterText, undefined);
  assert.equal(betaItem.filterText, "alp beta");
  assert.equal(gammaItem.filterText, "alp gamma");
});

test("editing another saved target still offers newly typed unrelated targets", async () => {
  const { TargetCompletionProvider } = loadCompletionProviderWithMockVscode();
  const { index, root } = buildIndex("completion_live_region");
  const filePath = path.join(root, "_targets.R");
  const text = fs.readFileSync(filePath, "utf8").replace(
    "tar_target(alpha, 1)",
    "tar_target(alpha, 1 + lam)"
  );
  const lineIndex = text.split("\n").findIndex((line) => line.includes("tar_target(alpha, 1 + lam)"));
  const lineText = text.split("\n")[lineIndex];
  const position = {
    character: lineText.indexOf("lam)") + 3,
    line: lineIndex
  };
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

  const items = await provider.provideCompletionItems(document, position);
  const labels = items.map((item) => item.label);

  assert.ok(labels.includes("beta"));
  assert.ok(labels.includes("lambda"));
  assert.ok(!labels.includes("gamma"));
  assert.equal(items.find((item) => item.label === "lambda").filterText, undefined);
  assert.equal(items.find((item) => item.label === "beta").filterText, "lam beta");
});

test("tar_select_targets() does not shrink the completion target set", async () => {
  const { TargetCompletionProvider } = loadCompletionProviderWithMockVscode();
  const { index, root } = buildIndex("tar_select_targets");
  const filePath = path.join(root, "_targets.R");
  const text = fs.readFileSync(filePath, "utf8").replace(
    "tar_target(lambda, 3)",
    "tar_target(lambda, 3 + alp)"
  );
  const lineIndex = text.split("\n").findIndex((line) => line.includes("tar_target(lambda, 3 + alp)"));
  const lineText = text.split("\n")[lineIndex];
  const position = {
    character: lineText.indexOf("alp)") + 3,
    line: lineIndex
  };
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

  const items = await provider.provideCompletionItems(document, position);
  const labels = items.map((item) => item.label);

  assert.ok(labels.includes("alpha"));
  assert.ok(labels.includes("beta"));
  assert.ok(labels.includes("gamma"));
});

test("completion descendant filtering uses the full available target graph", async () => {
  const { TargetCompletionProvider } = loadCompletionProviderWithMockVscode();
  const { index, root } = buildIndex("tar_select_targets");
  const filePath = path.join(root, "_targets.R");
  const text = fs.readFileSync(filePath, "utf8").replace(
    "tar_target(alpha, 1)",
    "tar_target(alpha, 1 + lam)"
  );
  const lineIndex = text.split("\n").findIndex((line) => line.includes("tar_target(alpha, 1 + lam)"));
  const lineText = text.split("\n")[lineIndex];
  const position = {
    character: lineText.indexOf("lam)") + 3,
    line: lineIndex
  };
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

  const items = await provider.provideCompletionItems(document, position);
  const labels = items.map((item) => item.label);

  assert.ok(labels.includes("beta"));
  assert.ok(labels.includes("lambda"));
  assert.ok(!labels.includes("gamma"));
});
