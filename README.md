# tarborist

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
- Expands a supported static subset of `tar_map()`
- Builds a provisional dependency graph
- Adds cycle diagnostics for statically detected cycles
- Provides target-aware hover, Go to Definition, Ctrl-click navigation, and import document links
- Provides pipeline-scoped autocomplete only in valid `targets` regions
- Shows upstream/downstream info, cue settings, and parallel-related target options in hover text

## Supported static patterns

- `tar_target(...)`
- `source("file.R")`, `base::source(...)`
- `tar_source("R")`, `tar_source(files = c(...))`
- target objects assigned to symbols and later included in `list(...)`
- sourced partial pipelines
- statically resolvable `tar_map(values = ...)`

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

### From a VSIX

```sh
npm install
./node_modules/.bin/vsce package --allow-missing-repository
```

Then install the generated `.vsix` with `Extensions: Install from VSIX...`.

## Demo pipeline

See `examples/demo_pipeline/_targets.R` for a small pipeline that demonstrates:

- direct `tar_target()` navigation
- sourced partial pipelines from `source()`
- imported helpers and target objects from `tar_source()`
- static `tar_map()` expansion and generated-target hover
- cue and parallel option display in hover
- document links for imports
- a commented cycle demo you can enable to test diagnostics

## Development

```sh
npm install
npm test
./node_modules/.bin/vsce package --allow-missing-repository
```
