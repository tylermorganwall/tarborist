# Grouped targets pipeline helper

`custom_graph.R` replaces project-specific target-name matching with the
subpipeline structure recovered by tarborist's Tree-sitter index. Source the
file and call `tar_graph_subpipelines()` from the directory containing your
pipeline.

The helper uses the accompanying modified tarborist build. An older tarborist
installation without `scripts/pipeline-graph.js` will not work.

## Install and configure

Install Node.js if it is not already available. In the modified tarborist
directory, install its JavaScript dependencies:

```sh
npm ci
```

In R:

```r
install.packages(c("jsonlite", "DiagrammeR"))

source("custom_graph.R")
options(tarborist.path = "/path/to/modified/tarborist")

tar_graph_subpipelines("_targets.R")
```

Alternatively, supply `tarborist_path` on each call. If Node.js is installed
outside the R process's search path, supply its executable path with `node`.
The helper returns a regular DiagrammeR HTML widget; it can be printed in an
HTML-capable R viewer or saved with `htmlwidgets::saveWidget()`.

## Pipeline structure

No special prefix is required for a subpipeline variable. For example:

```r
library(targets)

targets_inputs = list(
  tar_target(raw_data, datasets::airquality),
  tar_target(clean_data, stats::na.omit(raw_data)),
  NULL
)

targets_analysis = list(
  tar_target(model, stats::lm(Ozone ~ Wind + Temp, data = clean_data)),
  tar_target(model_summary, summary(model)),
  NULL
)

list(
  targets_inputs,
  targets_analysis,
  NULL
)
```

Targets are grouped by the referenced subpipeline lists. Dependency arrows
still connect individual targets across the groups. `NULL` entries do not
create nodes. Sourcing `custom_graph.R` only defines the helper; it does not
render a graph or evaluate a pipeline.

## Source-only preview and evaluated network

By default the helper reads source files without executing R code. This is
suitable for inspecting a pipeline before installing its R dependencies or
running it. Its dependency edges are provisional static-analysis results.
Unsupported expressions can leave the graph incomplete; the helper emits one
warning when tarborist marks the graph partial, and `output = "data"` retains
the full diagnostics.

For the vertices, edges, and statuses that `targets` itself resolves, compute
a network explicitly and pass it to the helper:

```r
network = targets::tar_network(
  script = "_targets.R",
  targets_only = TRUE,
  outdated = TRUE
)

tar_graph_subpipelines(
  script = "_targets.R",
  network = network
)
```

`tar_network()` evaluates pipeline setup code while constructing target
definitions. It does not run the target commands. Use `outdated = FALSE` to
skip potentially expensive stale-target checks; doing so still evaluates
setup code. Always use a network computed for the same script and source
version that you are plotting.

Supplying a network does not make arbitrary R metaprogramming statically
recoverable. A target whose source group cannot be resolved stays ungrouped
rather than being assigned by a name-prefix guess.

## Plot and inspect

```r
# Display a vertical graph and emphasize highly connected targets.
tar_graph_subpipelines(direction = "TB", scale_nodes = TRUE)

# Remove targets and their incident edges.
tar_graph_subpipelines(exclude = c("temporary_output", "debug_report"))

# Export DOT without loading DiagrammeR.
dot = tar_graph_subpipelines(output = "dot")
writeLines(dot, "pipeline.dot")

# Inspect membership, edges, and source diagnostics as nested R lists.
graph = tar_graph_subpipelines(output = "data")
graph$groups
graph$nodes
graph$diagnostics

# Save an HTML widget and its asset directory.
widget = tar_graph_subpipelines()
htmlwidgets::saveWidget(widget, "pipeline.html", selfcontained = FALSE)
```

Directions are `"LR"`, `"TB"`, `"RL"`, and `"BT"`. Uniform node sizing is the
default. `scale_nodes = TRUE` uses each target's incoming and outgoing edge
count. Source-derived groups, status colors when provided by the network,
and exclusions replace the original script's project-specific grouping. The
interactive view below also provides manual positioning for subpipeline boxes.

## Interactive upstream views and export

In Positron or VS Code, run **tarborist: Show Grouped Pipeline Graph** from the
command palette. Click a target, then hold **Shift** and click additional
targets to add them to the selection. Shift-click a selected target to remove
it; a normal click starts a new selection containing that target. Selected
targets are outlined and listed in the inspector. Searching and choosing a
subpipeline preserve the selection. Keyboard users can use **Shift+Enter** or
**Shift+Space** on a focused node, or **Shift+Enter** in the search field, to
toggle a target.

Click **Upstream only** to keep every selected target and the union of their
upstream dependencies, including dependencies several steps away and in other
subpipelines. Shared dependencies appear once. A target is retained if it feeds
into any selected target. Other targets and empty groups are removed, then the
remaining graph is laid out again. Surviving subpipelines retain their colors.

The active filter names its targets and shows how many targets remain.
Selecting another visible target changes the selection and inspector without
changing that filter. Click **Upstream only** again to apply the new selection,
or **Show all** in the banner above the graph to restore the complete pipeline.
**Clear selection** removes the selected outlines while leaving the active
filter in place. A selected target with no dependencies is retained on its own.
Source refreshes retain filter targets by name and remove any that no longer
exist; the complete view returns when no filter targets remain.

### Open a target's definition

Right-click a target and choose **Open definition** in the editor view, or
**Open definition in Positron** in standalone HTML. The action uses the
right-clicked target without changing the current multi-target selection,
upstream filter, or layout settings. Keyboard users can focus a target and
press **Shift+F10** or the context-menu key, then activate the menu item.
**Escape** dismisses the menu. Double-clicking a target and the inspector's
**Open source** action use the same navigation.

Inside Positron or VS Code, tarborist opens the source document, places the
cursor at the indexed definition, and reveals it in the editor. The current
index supplies the position, including unsaved source changes. Generated
`tar_map()` targets navigate to their generator's source location, consistent
with tarborist's other definition-navigation features.

For navigation from standalone HTML:

1. Install the updated tarborist VSIX, which includes the target-link handler.
2. Open the matching targets project in Positron. If several Positron windows
   are open, bring the project window to the front.
3. Right-click a target in the HTML and choose **Open definition in Positron**.
   Your browser may ask for permission to open the application.

The link carries the target name and a pipeline hint. Tarborist resolves that
name against the current indices in the receiving Positron workspace, so
moving the definition to another line or sourced file does not leave the link
pointing at an old line number. Multiple matching pipelines produce a picker.
If an absolute pipeline hint no longer matches an open project, an alternative
pipeline must be selected explicitly. A removed target or an unavailable
project produces an explanation instead of opening a stale location.

The example HTML uses portable relative paths and can match the example
pipeline when it is open locally. It does not include the R source files;
those are in the source archive's `examples/grouped_pipeline` directory.
Targets without a statically recovered source location show an unavailable
navigation action. If an embedded HTML preview blocks application links,
open the HTML in a regular browser to use the Positron action.

### Position subpipeline boxes

Click a subpipeline's box or label to open its inspector. Choose **Pin left**
for the group that should start the flow, then select another group and choose
**Pin right** for the group that should finish it. A pin applies to the complete
box, including its nested subpipelines. Targets within that box retain their
internal dependency layout. One group can be pinned at each end, and either
end can be left automatic. Assigning a different group to an occupied end
replaces that end's previous pin. Choosing the opposite side for an already
pinned group moves its pin in one step.

Use **Flow** above the graph to switch directions:

| Flow | Start pin | End pin |
| --- | --- | --- |
| Left to right | Pin left | Pin right |
| Top to bottom | Pin top | Pin bottom |
| Right to left | Pin right | Pin left |
| Bottom to top | Pin bottom | Pin top |

Existing pins follow the selected direction. For example, a group pinned left
becomes the top group when changing from left-to-right to top-to-bottom flow.
The summary above the graph names the pinned groups and their current sides.
Keyboard users can focus a box and press **Enter** or **Space** to select it.

**Clear pin** removes the selected group's position constraint. **Clear all
pins** restores automatic placement while preserving the flow direction and
width settings. **Reset layout** removes pins and column limits, clears the
overall graph width, and restores left-to-right flow. Selecting a box preserves
the target selection; use **Back to targets** to return to it.

Pins survive upstream filtering. A pinned group that has no retained targets
is marked **hidden** in the summary and exerts no layout constraint until
**Show all** restores it. Source refreshes preserve pins by stable group
identity when line numbers or the final assembly order change, and clear
pins whose groups have been removed.

The two pinned groups must be separate: a group and its enclosing group cannot
occupy opposite ends. Pins change placement without changing the pipeline's
dependencies. When a chosen position opposes a dependency, its arrow still
points from the actual input to its dependent and may run backward across the
chosen flow.

### Control the width of a subpipeline

Select a box and use **Box width** in its inspector. Set **Target columns** to
`1`, then choose **Apply width** or press **Enter**, to arrange its targets in a
narrow, tall column. Larger values allow more targets across and can reduce
the box's height. The limit describes horizontal columns, including when the
overall graph flows top-to-bottom. Different subpipelines can have different
limits.

For the example pipeline, select the green `targets_prepare` box and apply
`1` column. This keeps the entire pipeline flowing left-to-right while stacking
the preparation targets vertically inside their box. It preserves target
labels, text size, and actual dependency arrows.

Leave **Target columns** blank and apply it, or choose **Clear width**, to return
that box to automatic layout. **Reset layout** clears every column limit as
well as the position pins. Width choices survive upstream filtering and source
line edits in the same way as pins. A hidden box keeps its setting until it is
shown again; removing the group from the source clears its setting.

The control limits the arrangement of targets rather than imposing an exact
pixel width. Labels, box padding, nested boxes, and routed arrows determine
the minimum usable width. Reflow keeps labels readable and reroutes their
arrows; it does not squeeze the rendered text or clip the box's contents.

For nested subpipelines, set a column limit on either the containing box or
its child boxes. Simultaneous limits on a parent and its descendants are
rejected. A containing box with a column limit also cannot have an independently
pinned child; apply the width to that child instead, or pin the containing box.
An incompatible choice leaves the previous layout in place and explains the
conflict.

### Give the entire graph more room

Use **Target graph width (px)** above the graph to request a wider drawing. For
example, enter `1800` and choose **Apply**, or press **Enter**. The
layout increases horizontal spacing between targets and subpipelines while
keeping target labels and font sizes unchanged. Individual box column limits
still apply, so the green preparation box can remain a single column while
the whole pipeline has more room. Accepted values are whole numbers from
`1` through `100000` pixels.

Leave the field blank and apply it, or choose **Clear width** beside it, to
restore automatic spacing. This clears only the overall width setting.
**Reset layout** also clears pins and individual box column limits. The overall
width survives upstream filtering, **Show all**, direction changes, and source
refreshes. Each view is laid out again using the requested width.

The value is a target drawing width in CSS pixels, measured across visible
targets and subpipeline boxes; export padding and captions can add space
outside that span. A smaller value does not
compress labels or force an already wider graph to shrink. Layout constraints
can prevent reaching the requested width, particularly a top-to-bottom chain
with no horizontal gaps to expand. The view reports the resulting width.
**Fit** continues to fit the drawing into the available window; use zoom to
inspect the wider layout at a larger scale.

### Export and share

**Export SVG** saves a vector image of the displayed graph. **Export DOT** saves
its Graphviz source. Both exports include only the retained target nodes and
their connecting edges and groups, plus the status legend and source-analysis
caption. Single-target filenames identify the focus, for example
`pipeline-upstream-linear_model.svg`; multiple selections use a name such as
`pipeline-upstream-2-targets.svg`. Panning, zooming, search highlights, and
selection outlines do not change which nodes are exported. Both formats retain
the chosen direction, subpipeline positions, column limits, and overall graph
spacing. DOT includes the resolved spacing and invisible layout constraints
that reproduce those positions without adding target nodes or dependency
edges to the pipeline data.

To use the same interactive view outside the editor, create a standalone HTML
file from the modified tarborist directory:

```sh
node scripts/pipeline-graph.js /path/to/_targets.R --format html --output pipeline.html
```

Open the file in a browser. Upstream filtering, subpipeline pins, column limits,
overall width, direction changes, graph layout, and both exports work offline. The HTML contains the
complete pipeline snapshot so **Show all**
can restore it; an exported filtered SVG or DOT contains only the selected
subgraph. Source navigation from the HTML uses the installed tarborist
extension in Positron, as described above. The R helper's default DiagrammeR widget provides the grouped plot;
the target inspector, upstream-filter controls, and subpipeline layout controls
are in tarborist's editor view and the standalone HTML above.

## Dependencies and verification

- Node.js and the modified tarborist build provide Tree-sitter parsing and
  graph construction.
- `jsonlite` transfers requests and results through temporary JSON files.
- `DiagrammeR` is required only for `output = "widget"`.
- `targets` is required only when you choose to compute `network` yourself.

Paths are passed as separately quoted subprocess arguments. Target names,
network data, and plotting choices travel in JSON rather than shell code.
The helper removes its temporary request and response files on exit.

The bridge was executed with R 4.3.3 and jsonlite 1.8.8 against the actual
Tree-sitter CLI. The smoke checks passed for source-only grouping, JSON
transfer, paths with spaces, singleton exclusions, supplied network statuses,
empty graphs, partial-analysis warnings, invalid network rejection, and
subprocess error reporting. An explicit setup-side-effect check confirmed that
the pipeline was not evaluated. The DiagrammeR return path was not exercised
because DiagrammeR was not installed in the isolated R test runtime.

The JavaScript implementation includes graph, CLI, HTML, and editor-controller
regression tests in addition to tarborist's existing tests. The interactive
view was also tested in Chromium, including selection, search, filtering,
subpipeline positioning and widths, flow direction, zooming, panning, and SVG/DOT downloads.
No JavaScript or content security policy errors were observed.

Source-navigation checks cover context-menu mouse and keyboard actions,
preserved selection and filter state, correctly encoded Positron links,
current indexed positions, generated-target origins, and ambiguous or missing
pipelines. The browser-to-operating-system launch of a live Positron instance
was not exercised in the isolated test runtime.

## References

- [tarborist](https://github.com/tylermorganwall/tarborist)
- [targets: tar_network](https://docs.ropensci.org/targets/reference/tar_network.html)
- [targets: arbitrarily nested target lists](https://docs.ropensci.org/targets/reference/tar_bind.html)
- [VS Code extension URI activation](https://code.visualstudio.com/api/references/activation-events#onUri)
- [Positron extension development](https://positron.posit.co/extension-development.html)
