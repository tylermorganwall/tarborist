# Changelog

## [0.3.0] - 2026-04-05

### Added

- Static support for `tar_assign()` targets defined with supported native-pipe `tar_target()` forms, including `expr |> tar_target()` and `expr |> tar_target(command = _)`.
- Optional support for additional user-configured single-target `tar_target()`-like factories through the `tarborist.additionalSingleTargetFactories` setting.

### Changed

- README installation and supported-workflow documentation now reflects the current release flow and the currently supported `targets` / `tarchetypes` patterns.

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
