
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
- Shows an interactive dependency graph with source-defined subpipelines grouped into nested clusters
- Adds cycle diagnostics for statically detected cycles
- Provides target-aware hover, Go to Definition, Ctrl-click navigation, and import document links
- Adds a Positron-only `Targets: tar_load Here` command that loads the target under the cursor or selection into `.GlobalEnv` through the active R console
- Provides target-aware autocomplete only in valid target/factory command and pattern regions, including unsaved in-progress edits inside those regions
- Uses the full statically available target universe for hover and autocomplete, even when helpers such as `tar_select_targets()` trim the final pipeline
- Shows upstream/downstream info, cue settings, parallel-related target options, disabled-in-final-pipeline status, build size, build runtime, canceled progress, and indirect downstream depth markers in hover text and related pickers
- Can optionally color target definition names by direct descendant count, build size, or runtime using configurable heatmap buckets
- Emits more specific diagnostics for malformed pipeline `list(...)` entries, including likely missing commas and unsupported target factories

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

## Grouped pipeline graph

Run **tarborist: Show Grouped Pipeline Graph** from the command palette. The
view uses the existing Tree-sitter index and shows the targets returned by
the pipeline, grouped by the named lists that contain them:

```r
targets_inputs = list(
  tar_target(raw_data, read.csv("data.csv")),
  tar_target(clean_data, na.omit(raw_data)),
  NULL
)

targets_analysis = list(
  tar_target(model, lm(y ~ x, data = clean_data)),
  tar_target(model_summary, summary(model)),
  NULL
)

list(targets_inputs, targets_analysis, NULL)
```

No naming prefix is required. The group names come from list definitions,
and the arrows still connect individual targets across subpipelines.

- Drag to pan, scroll to zoom, and use **Fit** to see the whole graph.
- Search by target name or focus on a subpipeline.
- Select a target to inspect its command and direct dependencies/dependents.
- Hold **Shift** and click other targets to add or remove them from the
  selection. A normal click selects one target. Search preserves the selection.
- Select **Upstream only** to keep all selected targets and the union of their
  transitive dependencies. Shared dependencies appear once. Targets that do
  not feed any selection and empty groups are removed, then the graph is
  laid out again.
- Use **Show all** to restore the complete graph. Inspecting another visible
  target leaves the active upstream filter in place.
- Click a subpipeline box or its label, then use **Pin left** or **Pin right**
  in the inspector to place the whole group at that end of the graph. Choose
  **Top to bottom** in **Flow** to use **Pin top** and **Pin bottom** instead.
  Existing pins follow the new direction. Reverse directions are also available.
- Use **Clear pin** for the selected subpipeline, **Clear all pins** to keep the
  current direction with automatic placement, or **Reset layout** to return
  to automatic left-to-right flow. Upstream filtering preserves pins on hidden
  groups, which return when **Show all** restores them.
- In the selected box's **Box width** section, set **Target columns** to `1`
  and choose **Apply width** to make the subpipeline narrow and tall. Larger
  values allow more targets across. Leave the field blank or use **Clear width**
  for automatic placement. Labels keep their normal size; the limit changes
  how targets are arranged inside the box. **Reset layout** also clears widths.
- Use **Target graph width (px)** above the graph to request more horizontal room
  for the entire drawing. Enter a width and choose **Apply**, or press
  **Enter**. The layout adds horizontal spacing while keeping target text at
  its normal size. Leave the field blank or use **Clear width** for automatic
  spacing. The setting works alongside pins and individual box column limits.
- Right-click a target and choose **Open definition** to navigate to its current
  indexed source position. The menu preserves the existing target selection.
  **Shift+F10** opens it from the keyboard. Double-click and **Open source** use
  the same navigation.
- Export the displayed graph as SVG or Graphviz DOT. With an upstream filter
  active, both exports contain only the retained targets, edges, and groups.
  Both formats preserve the applied direction, group positions, column limits,
  and overall graph spacing.
- Open or refresh the view to include current unsaved editor buffers. Existing
  index refreshes update an open view automatically.

Groups preserve list identity through aliases, source-order reassignments,
imports, nested lists, supported `tar_map()` expansion, and
`tar_select_targets()` filtering. An outer list that only assembles named
subpipelines does not add a redundant enclosing box. Targets outside a named
list remain ungrouped. A duplicate target appearing in conflicting groups is
shown once in their nearest common group with a diagnostic.

The editor view is a static preview. It does not evaluate R setup code or run
target commands. Unsupported dynamic construction remains subject to the
index's existing partial-analysis diagnostics. Build colors describe the last
recorded build, not whether a target is currently up to date.

### R helper

The source tree also includes `R/custom_graph.R`. This defines
`tar_graph_subpipelines()` and uses the same parser and DOT renderer:

```r
source("/path/to/tarborist/R/custom_graph.R")
options(tarborist.path = "/path/to/tarborist")

tar_graph_subpipelines("_targets.R")
tar_graph_subpipelines(direction = "TB", scale_nodes = TRUE)
graph = tar_graph_subpipelines(output = "data")
```

Install the checkout's dependencies with `npm ci`, install the R packages
`jsonlite` and `DiagrammeR`, and ensure Node.js is on R's PATH (or pass `node`).
The default return is a DiagrammeR HTML widget. Use `output = "dot"` or
`output = "data"` without DiagrammeR.

To preserve the exact nodes, edges, and statuses resolved by `targets`, pass a
network computed for the same script and source version:

```r
network = targets::tar_network(
  script = "_targets.R",
  targets_only = TRUE,
  outdated = TRUE
)
tar_graph_subpipelines("_targets.R", network = network)
```

Computing `tar_network()` evaluates pipeline setup code, although it does not
run target commands. The helper never calls it implicitly. With a supplied
network, Tree-sitter contributes group membership and source locations; the
network owns the node set, dependencies, and statuses. Targets that cannot be
matched to a statically resolved definition remain ungrouped.

See [the helper guide](docs/grouped-pipelines.md) for all options.

### Command line and shareable HTML

```sh
node scripts/pipeline-graph.js /path/to/_targets.R --format html --output pipeline.html
node scripts/pipeline-graph.js /path/to/_targets.R --format svg --output pipeline.svg
node scripts/pipeline-graph.js /path/to/_targets.R --format dot --output pipeline.dot
node scripts/pipeline-graph.js /path/to/_targets.R --format json --output pipeline.json
```

HTML output contains the complete interactive view and works offline, including
upstream filtering, subpipeline pins, column limits, overall graph width, flow
direction, and SVG/DOT exports.
In standalone HTML, right-click and choose **Open definition in Positron**.
Install this updated tarborist extension and open the matching project in
Positron first. The link sends the target name and pipeline hint to tarborist,
which resolves its current definition; moved source lines remain navigable.
If several pipelines match, Positron asks which one to use. Refresh remains
available in the editor; the standalone HTML graph is a snapshot.
Graphviz is bundled as WebAssembly, so a system Graphviz installation is not
required. Layout runs in a worker to keep the interface responsive.

## Optional settings

- `tarborist.additionalSingleTargetFactories`: additional factory names to treat like `tar_target()` during static analysis. Built-in support already includes `tar_file()`, `tar_qs()`, and `tar_skip()`. Use this setting for extra single-target factories such as `tar_parquet()` that preserve the same `name` / `command` / `pattern` shape.
- `tarborist.targetHeatmap.enabled`: turn on editor background highlighting for target definition names based on target graph or `_targets/meta/meta` metadata.
- `tarborist.targetHeatmap.metric`: choose whether the heatmap is based on direct descendant count, target output `size`, or build `runtime`. Defaults to direct descendant count.
- `tarborist.targetHeatmap.minDirectDescendants` / `tarborist.targetHeatmap.minSizeBytes` / `tarborist.targetHeatmap.minRuntimeSeconds`: minimum values before any heatmap color is applied.
- `tarborist.targetHeatmap.directDescendantBreaks` / `tarborist.targetHeatmap.sizeBreaksBytes` / `tarborist.targetHeatmap.runtimeBreaksSeconds`: ascending breakpoints used to bucket targets into reusable heatmap bands.
- `tarborist.targetHeatmap.palette`: semi-transparent background colors for the heatmap buckets. 

## Typical workflows

1. Hover a target reference to inspect where it is defined and what it depends on.
2. Ctrl-click or Go to Definition to jump across sourced pipeline files.
3. Use completions inside target/factory commands and patterns to add upstream targets without creating obvious cycles, even when the final pipeline is filtered through helpers such as `tar_select_targets()`.
4. In Positron, use `Targets: tar_load Here` to load the hovered/selected target into `.GlobalEnv` from a valid target region without pasting the helper code into the console history.
5. Read diagnostics when a static cycle or unresolved pipeline fragment is detected.

## Positron command

In Positron, `Targets: tar_load Here` loads a single target into `.GlobalEnv` from the active R editor when the cursor or primary selection is on a tarborist-resolvable target name or reference.

- Default shortcut on macOS: `cmd+alt+shift+l`
- Default shortcut on Windows and Linux: `ctrl+alt+shift+l`
- The command is enabled only in valid R target regions
- Execution is sent through the active Positron R console in silent mode, so the generated `tar_load_raw(...)` wrapper is not echoed into the console

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
