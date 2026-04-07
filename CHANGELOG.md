# Changelog

## [0.5.2] - 2026-04-06

### Changed

- The root `Static pipeline analysis is partial` diagnostic now summarizes the actual underlying issue locations and messages, so large pipelines surface where partial analysis is coming from by default.

## [0.5.1] - 2026-04-06

### Fixed

- `tar_map()` template expansion now recognizes configured `tar_target()`-like single-target factories such as `tar_file()` instead of emitting a spurious `Could not statically resolve tar_map() target template` diagnostic.
- User-facing diagnostics now refer to `tar_target()/target-like factory` in the remaining places where configured single-target factories share the same static parsing path.

## [0.5.0] - 2026-04-06

### Added

- Static support for parameterized `tar_quarto()` reports that reference raw targets through `tar_read_raw(params$target_name)`, `tar_load_raw(params$target_name)`, and related `params[[...]]` access.

## [0.4.0] - 2026-04-06

### Added

- Static support for `tar_assign()` targets defined with supported native-pipe `tar_target()` forms, including `expr |> tar_target()` and `expr |> tar_target(command = _)`.
- Optional support for additional user-configured single-target `tar_target()`-like factories through the `tarborist.additionalSingleTargetFactories` setting.
- Runtime hover metadata from `_targets/meta/meta`, including last updated time, status, size, warnings, and errors.
- Static support for selecting pipeline objects with `[[ ]]`, including selecting generated `tar_map()` targets into the final pipeline.
- Static support for `tar_map(values = some_symbol, names = some_column, ...)` when `some_symbol` is built from a supported static table subset, including `tidyr::expand_grid()`, `expand.grid()`, `dplyr::bind_rows()`, `rbind()`, and top-level `$` / `[[ ]]` column assignment.

### Changed

- README installation and supported-workflow documentation now reflects the current release flow and the currently supported `targets` / `tarchetypes` patterns.
- Runtime hover metadata now shows relative update ages, uses `not built yet` when a meta row exists without a build timestamp, and includes build age in related-target quick-pick descriptions.

### Fixed

- Trailing comments after the final pipeline expression no longer replace the pipeline with an unsupported expression.
- Comments inside `tar_assign({})` no longer trigger spurious `requires target factory assignments` warnings.

## [0.3.0] - 2026-04-05

### Added

- Optional support for additional user-configured single-target `tar_target()`-like factories through the `tarborist.additionalSingleTargetFactories` setting.
- Regression coverage for configured `tar_target()`-like factory aliases such as `tar_qs()` and `tar_parquet()`.

### Changed

- Workspace indexes now refresh when `tarborist.additionalSingleTargetFactories` changes, so newly configured factory aliases are picked up immediately.

## [0.2.0] - 2026-04-03

### Added

- Static support for `tar_assign()` target lists.
- Static support for `tar_select_targets()` with a tidyselect subset, including helpers like `starts_with()`, `ends_with()`, `contains()`, `matches()`, `everything()`, `all_of()`, and `any_of()`, plus `!`, `-`, `&`, `|`, `c()`, and `:`.
- Static support for `tar_quarto()` by scanning referenced `.qmd` and `.Rmd` files for `tar_read()` and `tar_load()` calls in R code chunks.
- Static support for `tar_combine()` so combined targets index their upstream target arguments correctly.
- Regression coverage for hover behavior around `tar_combine()` aliases.

### Changed

- `tar_map()` completions now suggest template target names inside `tar_map()` template code while continuing to suggest generated target names elsewhere in the pipeline.
- Static pipeline indexing now handles a broader slice of `targets` and `tarchetypes` workflows.

### Fixed

- Hovering a `tar_combine()` target object symbol now shows upstream targets instead of the generic pipeline-object hover.

## [0.1.0] - 2026-04-03

### Added

- Initial public release of `tarborist`.
- Static parsing of `_targets.R`, `source()`, and `tar_source()` imports.
- Indexing for direct `tar_target()` definitions and a supported static subset of `tar_map()`.
- Target hovers, Go to Definition, Ctrl-click navigation, document links for imports, and DAG-aware completions in valid pipeline regions.
- Static dependency graph construction and cycle diagnostics.
