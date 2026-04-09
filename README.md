
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
- Indexes `tar_quarto()` targets and scans referenced `.qmd` / `.Rmd` files for `tar_read()`, `tar_load()`, `tar_read_raw()`, and `tar_load_raw()`, including parameterized report refs like `params$target_name` and `params[[\"target_name\"]]`
- Expands a supported static subset of `tar_map()`, including `values = some_symbol` when `some_symbol` is built from supported static table helpers such as `expand_grid()`, `expand.grid()`, `bind_rows()`, `rbind()`, and top-level column assignment
- Supports common single-target factories like `tar_file()`, `tar_qs()`, and `tar_skip()` out of the box, and can opt into additional `tar_target()`-like factories through the `tarborist.additionalSingleTargetFactories` setting
- Builds a provisional dependency graph
- Adds cycle diagnostics for statically detected cycles
- Provides target-aware hover, Go to Definition, Ctrl-click navigation, and import document links
- Provides target-aware autocomplete only in valid target/factory command and pattern regions, including unsaved in-progress edits inside those regions
- Uses the full statically available target universe for hover and autocomplete, even when helpers such as `tar_select_targets()` trim the final pipeline
- Shows upstream/downstream info, cue settings, parallel-related target options, disabled-in-final-pipeline status, and indirect downstream depth markers in hover text and related pickers

## Currently supported workflows

- `tar_target(...)`
- `tar_assign({ ... })`
- `tar_assign()` targets written as `x <- expr |> tar_target()` or `x <- expr |> tar_target(command = _)`
- `tar_select_targets(...)` with a supported tidyselect subset
- `tar_combine(...)`
- `tar_quarto(...)` with static scanning of referenced `.qmd` / `.Rmd` files, including parameterized raw-target access through `params$...` and `params[[...]]`
- `tar_map(...)` in a supported static subset
- `tar_map(values = some_symbol, names = some_column, ...)` when `some_symbol` is statically built from supported helper-table constructors such as `tidyr::expand_grid(...)`, `expand.grid(...)`, `dplyr::bind_rows(...)`, `rbind(...)`, and top-level `$` / `[[ ]]` column assignment
- user-configured single-target factories that follow the same `name` / `command` / `pattern` shape as `tar_target()`
- `source("file.R")`, `base::source(...)`
- `tar_source("R")`, `tar_source(files = c(...))`
- target objects assigned to symbols and later included in `list(...)`
- sourced partial pipelines
- static target lists built from `list(...)`
- static target references from bare symbols, `tar_read(...)`, `tar_load(...)`, raw variants when statically obvious, and parameterized Quarto raw-target refs such as `tar_read_raw(params$target_name)`

## What it does not do

- execute arbitrary R code
- evaluate dynamic metaprogramming
- recover every possible `targets` factory
- fully resolve dynamic `tar_source()` paths or computed `tar_map()` values outside the supported static table subset

When static analysis can only recover part of the pipeline, `tarborist` degrades gracefully and marks the index as partial.

## Optional settings

- `tarborist.additionalSingleTargetFactories`: additional factory names to treat like `tar_target()` during static analysis. Built-in support already includes `tar_file()`, `tar_qs()`, and `tar_skip()`. Use this setting for extra single-target factories such as `tar_parquet()` that preserve the same `name` / `command` / `pattern` shape.

## Typical workflows

1. Hover a target reference to inspect where it is defined and what it depends on.
2. Ctrl-click or Go to Definition to jump across sourced pipeline files.
3. Use completions inside target/factory commands and patterns to add upstream targets without creating obvious cycles, even when the final pipeline is filtered through helpers such as `tar_select_targets()`.
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
