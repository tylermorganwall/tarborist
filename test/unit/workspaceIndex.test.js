"use strict";

// Fixture-driven regression tests for the static workspace index.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { buildStaticWorkspaceIndex } = require("../../src/index/pipelineResolver");
const { ensureParserReady, parseText } = require("../../src/parser/treeSitter");

function buildIndex(fixtureName, options = {}) {
  // Each fixture directory acts like a tiny standalone targets project.
  const root = path.resolve(__dirname, "..", "fixtures", fixtureName);
  return buildStaticWorkspaceIndex({
    ...options,
    readFile: (file) => fs.readFileSync(file, "utf8"),
    workspaceRoot: root
  });
}

test.before(async () => {
  await ensureParserReady();
});

test("parses large target files without native tree-sitter failures", () => {
  const repeatedTarget = [
    "tar_target(",
    "  name = example_target,",
    "  command = {",
    "    tibble::tibble(x = 1:10, y = x + 1)",
    "  }",
    ")"
  ].join("\n");
  const largeFile = `list(\n${Array.from({ length: 250 }, () => repeatedTarget).join(",\n")}\n)\n`;
  const tree = parseText(largeFile);

  assert.equal(tree.rootNode.type, "program");
  assert.equal(tree.rootNode.hasError, false);
});

test("indexes direct targets and direct dependencies", () => {
  const index = buildIndex("direct");
  assert.deepEqual([...index.targets.keys()], ["a", "b"]);

  const bRefs = index.refs.filter((ref) => ref.enclosingTarget === "b" && !ref.synthetic);
  assert.equal(bRefs.length, 1);
  assert.equal(bRefs[0].targetName, "a");
  assert.equal(bRefs[0].context, "command");
  assert.deepEqual([...index.graph.descendants.get("a")], ["b"]);
});

test("detects static cycles and emits diagnostics", () => {
  const index = buildIndex("cycle");
  assert.equal(index.partial, false);
  assert.equal(index.graph.cycles.length, 1);
  assert.deepEqual(new Set(index.graph.cycles[0]), new Set(["a", "b"]));

  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.message.includes("Cycle detected")));
});

test("indexes sourced partial pipelines across files", () => {
  const index = buildIndex("sourced");
  const targetA = index.targets.get("a");
  const targetB = index.targets.get("b");

  assert.ok(targetA.file.endsWith(path.join("sourced", "part.R")));
  assert.ok(targetB.file.endsWith(path.join("sourced", "part.R")));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "b" && ref.targetName === "a"));
});

test("indexes tar_source imports and records import edges", () => {
  const index = buildIndex("tar_source");
  const importedFile = path.join("tar_source", "R", "part.R");

  assert.ok(index.imports.some((edge) => edge.toFile.endsWith(importedFile)));
  assert.ok(index.targets.has("a"));
  assert.ok(index.targets.has("b"));

  const rootRecord = [...index.files.values()].find((record) => record.file.endsWith(path.join("tar_source", "_targets.R")));
  assert.equal(rootRecord.importLinks.length, 1);
  assert.ok(rootRecord.importLinks[0].target.endsWith(path.join("tar_source", "R")));
});

test("expands statically resolvable tar_map calls", () => {
  const index = buildIndex("tar_map");

  assert.deepEqual(
    [...index.targets.keys()],
    [
      "fit_penguins_adelie",
      "report_penguins_adelie",
      "fit_penguins_gentoo",
      "report_penguins_gentoo"
    ]
  );

  const generated = index.targets.get("fit_penguins_adelie");
  assert.equal(generated.generated, true);
  assert.equal(generated.generator.templateName, "fit_penguins");
  assert.ok(generated.generator.generatedNamesPreview.includes("fit_penguins_adelie"));

  assert.ok(index.refs.some((ref) => ref.synthetic && ref.enclosingTarget === "report_penguins_adelie" && ref.targetName === "fit_penguins_adelie"));
  assert.equal(index.generators.length, 1);
  assert.equal(index.generators[0].count, 4);
});

test("expands tar_map() values resolved from static expand.grid()/expand_grid() and bind_rows() helpers", () => {
  const index = buildIndex("tar_map_static_tables");

  assert.equal(index.partial, false);
  assert.deepEqual(
    [...index.targets.keys()],
    [
      "fit_penguins_adelie_basic",
      "report_penguins_adelie_basic",
      "fit_penguins_gentoo_basic",
      "report_penguins_gentoo_basic",
      "fit_penguins_chinstrap_extra",
      "report_penguins_chinstrap_extra"
    ]
  );

  const generated = index.targets.get("fit_penguins_chinstrap_extra");
  assert.equal(generated.generated, true);
  assert.equal(generated.generator.templateName, "fit_penguins");
  assert.equal(generated.generator.bindings.pipelines, "\"chinstrap_extra\"");
  assert.equal(index.generators.length, 1);
  assert.equal(index.generators[0].count, 6);
  assert.ok(index.refs.some((ref) => ref.synthetic && ref.enclosingTarget === "report_penguins_chinstrap_extra" && ref.targetName === "fit_penguins_chinstrap_extra"));
});

test("expands tar_map() values resolved from static rbind() helpers", () => {
  const index = buildIndex("tar_map_static_tables_rbind");

  assert.equal(index.partial, false);
  assert.deepEqual(
    [...index.targets.keys()],
    [
      "fit_penguins_adelie_basic",
      "report_penguins_adelie_basic",
      "fit_penguins_gentoo_extra",
      "report_penguins_gentoo_extra",
      "fit_penguins_chinstrap_more",
      "report_penguins_chinstrap_more"
    ]
  );

  const generated = index.targets.get("fit_penguins_gentoo_extra");
  assert.equal(generated.generated, true);
  assert.equal(generated.generator.templateName, "fit_penguins");
  assert.equal(generated.generator.bindings.pipelines, "\"gentoo_extra\"");
  assert.equal(index.generators.length, 1);
  assert.equal(index.generators[0].count, 6);
  assert.ok(index.refs.some((ref) => ref.synthetic && ref.enclosingTarget === "report_penguins_gentoo_extra" && ref.targetName === "fit_penguins_gentoo_extra"));
});

test("expands tar_map() templates built from built-in single-target factories", () => {
  const index = buildIndex("tar_map_additional_factory");
  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);

  assert.equal(index.partial, false);
  assert.deepEqual(
    [...index.targets.keys()],
    [
      "quarto_parameterized_alpha",
      "rendered_report_alpha",
      "quarto_parameterized_beta",
      "rendered_report_beta"
    ]
  );
  assert.ok(index.refs.some((ref) => ref.synthetic && ref.enclosingTarget === "rendered_report_alpha" && ref.targetName === "quarto_parameterized_alpha"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.message.includes("Could not statically resolve tar_map() target template")));
});

test("ignores trailing NULL templates inside tar_map()", () => {
  const index = buildIndex("tar_map_null");
  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);

  assert.equal(index.partial, false);
  assert.deepEqual(
    [...index.targets.keys()],
    [
      "fit_penguins_adelie",
      "report_penguins_adelie",
      "fit_penguins_gentoo",
      "report_penguins_gentoo"
    ]
  );
  assert.ok(index.refs.some((ref) => ref.synthetic && ref.enclosingTarget === "report_penguins_adelie" && ref.targetName === "fit_penguins_adelie"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.message.includes("Could not statically resolve tar_map() target template")));
});

test("resolves tar_map() outputs selected through list subsetting", () => {
  const index = buildIndex("tar_map_subset");
  const refs = index.refs.filter((ref) => ref.enclosingTarget === "summary_fit");

  assert.equal(index.partial, false);
  assert.deepEqual([...index.targets.keys()], ["fit_penguins_adelie", "summary_fit"]);
  assert.deepEqual(refs.map((ref) => ref.targetName), ["fit_penguins_adelie"]);
});

test("does not create self-cycles for target-local shadowed variables", () => {
  const index = buildIndex("local_shadow");
  const refs = index.refs.filter((ref) => ref.enclosingTarget === "designs_gl_theta_tbl");

  assert.deepEqual(refs.map((ref) => ref.targetName), ["designs_gl"]);
  assert.equal(index.graph.cycles.length, 0);
  assert.equal((index.graph.descendants.get("designs_gl_theta_tbl") || new Set()).size, 0);
});

test("ignores NULL pipeline entries without marking the index partial", () => {
  const index = buildIndex("null_ignore");
  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);

  assert.equal(index.partial, false);
  assert.deepEqual([...index.targets.keys()], ["a", "b"]);
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.message.includes("unsupported expression in pipeline")));
});

test("ignores trailing comments after the final pipeline expression", () => {
  const index = buildIndex("trailing_comment");
  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);

  assert.equal(index.partial, false);
  assert.deepEqual([...index.targets.keys()], ["x"]);
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.message.includes("unsupported expression in pipeline")));
});

test("warns specifically about missing commas between pipeline list items", () => {
  const index = buildIndex("missing_pipeline_comma");
  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);
  const missingComma = diagnostics.find((diagnostic) => diagnostic.message.includes("possible missing comma after pipeline item in list()"));

  assert.equal(index.partial, true);
  assert.ok(missingComma);
  assert.equal(missingComma.range.start.line, 1);
});

test("warns specifically about invalid non-target pipeline list items", () => {
  const index = buildIndex("invalid_pipeline_item");
  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);
  const invalidItem = diagnostics.find((diagnostic) => diagnostic.message.includes("list() pipeline items must be target factories, target objects, or pipeline lists"));

  assert.equal(index.partial, true);
  assert.ok(invalidItem);
  assert.equal(invalidItem.range.start.line, 2);
});

test("warns specifically about unsupported target factories in pipeline lists", () => {
  const index = buildIndex("unsupported_pipeline_factory");
  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);
  const unsupportedFactory = diagnostics.find((diagnostic) => diagnostic.message.includes("unsupported target factory 'tar_parquet()'"));

  assert.equal(index.partial, true);
  assert.ok(unsupportedFactory);
  assert.match(unsupportedFactory.message, /tarborist\.additionalSingleTargetFactories/);
  assert.equal(unsupportedFactory.range.start.line, 2);
});

test("reads runtime metadata from _targets/meta/meta", () => {
  const index = buildIndex("meta_hover");
  const meta = index.targetsMeta.get("x");

  assert.ok(meta);
  assert.equal(meta.time, "2025-10-10 15:56:12.925 UTC");
  assert.equal(meta.runtime, "174 ms");
  assert.equal(meta.size, "4.42 KB (4521 B)");
  assert.equal(meta.hasWarnings, true);
  assert.equal(meta.hasError, true);
  assert.equal(meta.warnings, "warning text");
  assert.equal(meta.error, "error text");
});

test("labels file-format metadata size as file size", () => {
  const index = buildIndex("meta_file_hover");
  const meta = index.targetsMeta.get("report_file");

  assert.ok(meta);
  assert.equal(meta.format, "file");
  assert.equal(meta.sizeLabel, "File size");
  assert.equal(meta.size, "64.0 KB (65536 B)");
});

test("root partial-analysis diagnostic summarizes the underlying issue locations", () => {
  const index = buildIndex("partial_summary");
  const rootRecord = [...index.files.values()].find((record) => record.file.endsWith(path.join("partial_summary", "_targets.R")));
  const summary = rootRecord.diagnostics.find((diagnostic) => diagnostic.severity === "information" && diagnostic.message.startsWith("Static pipeline analysis is partial. Issues:"));

  assert.equal(index.partial, true);
  assert.ok(summary);
  assert.match(summary.message, /_targets\.R:2 unresolved symbol 'part'/);
});

test("root partial-analysis diagnostic includes issue locations from imported files", () => {
  const index = buildIndex("partial_summary_import");
  const rootRecord = [...index.files.values()].find((record) => record.file.endsWith(path.join("partial_summary_import", "_targets.R")));
  const summary = rootRecord.diagnostics.find((diagnostic) => diagnostic.severity === "information" && diagnostic.message.startsWith("Static pipeline analysis is partial. Issues:"));

  assert.equal(index.partial, true);
  assert.ok(index.targets.has("a"));
  assert.ok(summary);
  assert.match(summary.message, /part\.R:3 unresolved symbol 'missing_part'/);
});

test("isolates incomplete target commands to the surrounding target instead of the whole pipeline", () => {
  const index = buildIndex("partial_target_command");
  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);
  const targetDiagnostic = diagnostics.find((diagnostic) => diagnostic.message.includes("unsupported or incomplete command expression in target 'plot'"));
  const rootRecord = [...index.files.values()].find((record) => record.file.endsWith(path.join("partial_target_command", "_targets.R")));
  const summary = rootRecord.diagnostics.find((diagnostic) => diagnostic.severity === "information" && diagnostic.message.startsWith("Static pipeline analysis is partial. Issues:"));

  assert.equal(index.partial, true);
  assert.deepEqual([...index.targets.keys()], ["plot", "other", "third"]);
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "third" && ref.targetName === "other"));
  assert.ok(targetDiagnostic);
  assert.equal(targetDiagnostic.range.start.line, 1);
  assert.ok(summary);
  assert.match(summary.message, /_targets\.R:2 unsupported or incomplete command expression in target 'plot'/);
});

test("captures cue and parallel target options verbatim", () => {
  const index = buildIndex("target_options");
  const target = index.targets.get("a");

  assert.equal(target.options.cue, "cue_on_global(\"yes\")");
  assert.deepEqual(target.options.parallel, [
    "deployment = \"main\"",
    "priority = 10"
  ]);
});

test("indexes tar_assign() blocks as target lists", () => {
  const index = buildIndex("tar_assign");

  assert.deepEqual([...index.targets.keys()], ["alpha", "beta", "gamma"]);
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "beta" && ref.targetName === "alpha"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "gamma" && ref.targetName === "alpha"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "gamma" && ref.targetName === "beta"));
});

test("ignores comments inside tar_assign() blocks", () => {
  const index = buildIndex("tar_assign_comments");
  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);

  assert.equal(index.partial, false);
  assert.deepEqual([...index.targets.keys()], ["alpha", "beta"]);
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "beta" && ref.targetName === "alpha"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.message.includes("requires target factory assignments")));
});

test("indexes tar_assign() targets defined with native-pipe tar_target() forms", () => {
  const index = buildIndex("tar_assign_pipe");
  const diagnostics = [...index.files.values()].flatMap((record) => record.diagnostics);

  assert.equal(index.partial, false);
  assert.deepEqual([...index.targets.keys()], ["alpha", "beta", "gamma", "delta"]);
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "beta" && ref.targetName === "alpha"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "gamma" && ref.targetName === "alpha"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "delta" && ref.targetName === "gamma"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.message.includes("tar_assign()")));
});

test("indexes tar_select_targets() with tidyselect operators", () => {
  const index = buildIndex("tar_select_targets");

  assert.deepEqual([...index.targets.keys()], ["alpha", "gamma"]);
});

test("indexes tar_plan() named targets and unnamed target objects", () => {
  const index = buildIndex("tar_plan");
  const beta = index.targets.get("beta");
  const gamma = index.targets.get("gamma");
  const betaRegion = index.completionRegions.find((region) => (
    region.kind === "command" && region.enclosingTargets.includes("beta")
  ));

  assert.equal(index.partial, false);
  assert.deepEqual([...index.targets.keys()], ["alpha", "beta", "gamma"]);
  assert.equal(beta.origin, "tar_plan");
  assert.ok(beta.commandRange);
  assert.ok(betaRegion);
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "beta" && ref.targetName === "alpha"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "gamma" && ref.targetName === "beta"));
  assert.equal(gamma.origin, "tar_target");
});

test("indexes configured additional single-target factories", () => {
  const index = buildIndex("additional_target_factories", {
    additionalSingleTargetFactories: ["tar_parquet"]
  });

  assert.equal(index.partial, false);
  assert.deepEqual([...index.targets.keys()], ["a", "b", "c", "d"]);
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "b" && ref.targetName === "a"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "c" && ref.targetName === "a"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "c" && ref.targetName === "b"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "d" && ref.targetName === "c"));
});

test("scans tar_quarto() documents for tar_read()/tar_load() dependencies, including raw params access", () => {
  const index = buildIndex("tar_quarto");
  const report = index.targets.get("report");

  assert.ok(report);
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "report" && ref.targetName === "data" && ref.context === "tar_read"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "report" && ref.targetName === "other" && ref.context === "tar_load"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "report" && ref.targetName === "raw_data" && ref.context === "tar_read_raw"));
  assert.ok(index.refs.some((ref) => ref.enclosingTarget === "report" && ref.targetName === "raw_loaded" && ref.context === "tar_load_raw"));
});

test("does not scan tracked quarto files referenced by tar_file()", () => {
  const index = buildIndex("tar_file_qmd");
  const refs = index.refs.filter((ref) => ref.enclosingTarget === "report_source");

  assert.equal(index.partial, false);
  assert.deepEqual([...index.targets.keys()], ["data", "report_source"]);
  assert.deepEqual(refs, []);
});

test("indexes tar_combine() upstream target arguments", () => {
  const index = buildIndex("tar_combine");
  const refs = index.refs.filter((ref) => ref.enclosingTarget === "combined");

  assert.deepEqual(refs.map((ref) => ref.targetName).sort(), ["first", "second"]);
});
