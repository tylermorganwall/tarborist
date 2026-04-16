# Changelog

## [0.11.0] - 2026-04-15

### Added

- Static support for `tar_plan()` / `tarchetypes::tar_plan()` pipeline containers, including named `target = command` entries and mixed plans that also include ordinary target objects.

### Changed

- `tarborist: Organize Pipeline by DAG` now also reorders `tar_plan()` entries by dependency order while preserving tied order and keeping leading comments attached to their targets.

### Fixed

- Incomplete target command expressions inside malformed top-level `list(...)` and `tar_plan()` pipelines are now isolated to the surrounding target/factory, so later targets can still be recovered and partial-analysis warnings point at the broken target instead of the whole pipeline.
- DAG-based pipeline organization now keeps same-line trailing comments attached to their targets when entries are reordered, instead of duplicating or misassigning targets in commented lists.

## [0.10.0] - 2026-04-14

### Added

- A Positron-only `Targets: Run Here Without Moving Cursor` command that overrides Cmd/Ctrl+Enter in R editors and uses tarborist's pipeline-region awareness to run code in place.
- A `tarborist: Organize Pipeline by DAG` command that reorders literal pipeline lists so parent targets stay before their children while preserving original order for dependency ties.

### Changed

- Run-in-place execution now runs the current selection exactly when text is selected, executes the exact target command region for unbraced targets, falls back to Positron's normal statement execution for braced command blocks, refreshes the pipeline index first when the buffer is dirty, and then places the cursor at the end of the current valid command region instead of jumping to the end of the enclosing pipeline list.
- Run-in-place can now be turned off with `tarborist.executeInPlace.enabled`, which restores Positron's default Cmd/Ctrl+Enter behavior.
- The downstream hover quick-pick now sorts indirect descendants by child distance first and alphabetically second, and shows those distances as `[+N] target_name` labels.

### Fixed

- Pipeline organization keeps comments immediately above targets attached to the targets they describe, while leaving referenced sub-pipeline objects in place and organizing each literal sub-pipeline according to the targets it actually contains.

## [0.9.1] - 2026-04-13

### Fixed

- File-format targets now show `File size` in hover metadata instead of a generic `Size` label.
- File-format targets are excluded from heatmap background coloring so tracked files are not treated like in-memory object sizes.

## [0.9.0] - 2026-04-11

### Added

- Optional warning/error status decorations for target definition names, including configurable leading `▲` and `✖` icons/wavy colored underlines for targets whose last build recorded a warning or error in `_targets/meta/meta`.
- A separate configurable `not built yet` heatmap color for targets that have metadata rows but no recorded build timestamp.


## [0.8.0] - 2026-04-10

### Added

- Runtime duration from `_targets/meta/meta` is now shown in target hover metadata.
- An optional target heatmap that colors target definition names by `_targets/meta/meta` size or runtime using configurable thresholds, breaks, and palette values.

### Changed

- Direct-downstream targets now show a `<direct>` label when they are opened through the hover quick-pick instead of being listed inline.
- Target hovers no longer show the extra `Target info` section header above the metadata table.

### Fixed

- Pipeline `list(...)` diagnostics are now more specific: tarborist warns about likely missing commas between adjacent items, distinguishes invalid non-target list entries, and names unsupported target factories while pointing to `tarborist.additionalSingleTargetFactories` when appropriate.

## [0.7.0] - 2026-04-10

### Added

- Keyboard target navigation through workspace and document symbol providers, so targets can be reached from Go to Symbol in Workspace (`⌘T` / `Ctrl+T`), Go to Symbol in Editor, and the editor outline.
- Shared target-location handling for symbol, hover, and definition navigation so generated `tar_map()` targets consistently jump back to their generator location.
- Explicit regression coverage for positional `name, command` parsing in both `tar_target()` and target-like factories.
- Hover and definition navigation for target references inside `.qmd` and `.Rmd` documents, including parameterized Quarto patterns such as `tar_read_raw(params$raw_data)`.
- A Positron-only `Targets: tar_load Here` command that loads the target under the cursor or selection into `.GlobalEnv` from valid R target regions.

### Changed

- Target completions now wait for a three-character prefix before showing suggestions, including operator-triggered completion sessions inside valid target command and pattern regions.
- `Targets: tar_load Here` now resolves only single tarborist-known targets, is keybound only in valid target regions, and submits code to the Positron R console in silent mode so the generated wrapper is not echoed into the console.

## [0.6.1] - 2026-04-08

### Changed

- Removed the experimental `tarborist_make()` helper workflow and terminal/console link provider while upstream Positron infrastructure is pursued.
- Autocomplete now treats positions inside valid target/factory command bodies as completion regions even after unsaved edits grow past the last saved command range, and it retriggers on common operators such as `+`, `-`, `*`, `/`, `^`, `&`, `|`, `=`, and `%`.
- Autocomplete now uses the full statically available target universe instead of the final selected pipeline only, so helpers such as `tar_select_targets()` no longer trim the completion set, while downstream filtering still respects the full available DAG.
- Target hovers now use that same full available target universe, so targets excluded from the final pipeline still show full hover information together with an explicit note that they are disabled in the final pipeline.
- The hover title now links directly to the hovered target definition, and the further-downstream quick-pick now shows indirect-depth markers such as `<1 deep>` and `<2 deep>` before the file location.

## [0.6.0] - 2026-04-08

### Added

- A bundled `tarborist_make()` helper plus install/update commands for loading it into the active Positron R session with a tarborist-generated target manifest.
- A helper-driven `tarborist: Run tarborist_make() in R session` command that refreshes the manifest and runs `tarborist_make()` in the active Positron R console.
- Automatic background manifest refresh on save for workspaces where `tarborist_make()` has already been installed.
- Built-in parsing support for common single-target factories `tar_file()`, `tar_qs()`, and `tar_skip()`.

### Changed

- `tarborist_make()` now captures reporter stdout so dispatched/completed target lines are linkified in the console.
- The helper now prints an install confirmation when the manifest is set and returns invisibly so successful runs do not print a trailing `NULL`.
- Positron runtime diagnostics for helper commands now report the available runtime bridge state more clearly.
- tarborist popup errors now strip ANSI and CLI formatting before rendering user-facing messages.
- Tree-sitter/provider parse failures now log richer context, including provider phase, file, line, hovered word, and line/source previews, while tarborist errors no longer force the output channel to steal focus.
- Hover downstream summaries now show direct downstream targets inline when possible and collapse the rest into a `(+N further)` picker link.
- `tar_map()` template completions now wait for a two-character prefix before suggesting mapped target names.
- README now documents the helper-based `tarborist_make()` workflow and its current runtime limitations.

## [0.5.3] - 2026-04-06

### Fixed

- `tar_map()` now ignores a trailing `NULL` template entry instead of marking the template list as partially unsupported.

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
