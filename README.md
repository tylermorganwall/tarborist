
# tarborist 

![](https://raw.githubusercontent.com/tylermorganwall/tarborist/refs/heads/main/tarborist.gif)

Static analysis for navigating and debugging complex R `targets` pipelines in Positron and VS Code.

> Static analysis only. `tarborist` does not execute arbitrary user R code.

## Why tarborist

As `targets` pipelines grow, it becomes harder to answer simple questions quickly:

- Where is this target defined?
- Which imported file did this come from?
- What depends on this target?
- Would adding this dependency create a cycle?
- Why is the pipeline shape different from what I expect?

`tarborist` builds a static index of your pipeline from `_targets.R` and imported files so you can inspect structure without executing arbitrary user code.

## What tarborist does today

- Parses `_targets.R` and imported files with Tree-sitter
- Resolves `source()` and `tar_source()` imports in a safe static subset
- Indexes direct `tar_target()` definitions
- Indexes `tar_assign()` target lists, including supported native-pipe `tar_target()` forms
- Indexes `tar_select_targets()` in a supported static tidyselect subset
- Indexes `tar_combine()` upstream target arguments
- Indexes `tar_quarto()` targets and scans referenced `.qmd` / `.Rmd` files for `tar_read()` and `tar_load()`
- Expands a supported static subset of `tar_map()`
- Builds a provisional dependency graph
- Adds cycle diagnostics for statically detected cycles
- Provides target-aware hover, Go to Definition, Ctrl-click navigation, and import document links
- Provides pipeline-scoped autocomplete only in valid `targets` regions
- Shows upstream/downstream info, cue settings, and parallel-related target options in hover text

## Currently supported workflows

- `tar_target(...)`
- `tar_assign({ ... })`
- `tar_assign()` targets written as `x <- expr |> tar_target()` or `x <- expr |> tar_target(command = _)`
- `tar_select_targets(...)` with a supported tidyselect subset
- `tar_combine(...)`
- `tar_quarto(...)` with static scanning of referenced `.qmd` / `.Rmd` files
- `tar_map(...)` in a supported static subset
- `source("file.R")`, `base::source(...)`
- `tar_source("R")`, `tar_source(files = c(...))`
- target objects assigned to symbols and later included in `list(...)`
- sourced partial pipelines
- static target lists built from `list(...)`
- static target references from bare symbols, `tar_read(...)`, `tar_load(...)`, and raw-string variants when statically obvious

## What it does not do

- execute arbitrary R code
- evaluate dynamic metaprogramming
- recover every possible `targets` factory
- fully resolve dynamic `tar_source()` paths or computed `tar_map()` values

When static analysis can only recover part of the pipeline, `tarborist` degrades gracefully and marks the index as partial.

## Typical workflows

1. Hover a target reference to inspect where it is defined and what it depends on.
2. Ctrl-click or Go to Definition to jump across sourced pipeline files.
3. Use completions inside `tar_target()` commands and patterns to add upstream targets without creating obvious cycles.
4. Read diagnostics when a static cycle or unresolved pipeline fragment is detected.

## Install in Positron or VS Code

### From a GitHub release or registry

If a release is available, install `tarborist` from the Open VSX-compatible registry your editor uses, or download the `.vsix` asset from the GitHub release and install it with `Extensions: Install from VSIX...`.

### Build a VSIX locally

```sh
npm install
./node_modules/.bin/vsce package
```

Then install the generated `.vsix` with `Extensions: Install from VSIX...`.

## Demo pipeline

See `examples/demo_pipeline/_targets.R` for a small pipeline that demonstrates:

- direct `tar_target()` navigation
- sourced partial pipelines from `source()`
- imported helpers and target objects from `tar_source()`
- static `tar_map()` expansion and generated-target hover
- `tar_assign()` and `tar_combine()` target composition
- cue and parallel option display in hover
- document links for imports
- a commented cycle demo you can enable to test diagnostics

## Development

```sh
npm install
npm test
./node_modules/.bin/vsce package
```
