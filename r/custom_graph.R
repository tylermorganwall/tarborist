#' Plot a targets pipeline with its source subpipelines grouped
#'
#' Reads a pipeline through tarborist's Tree-sitter index and returns a
#' grouped Graphviz widget, DOT text, or graph data. The default path parses
#' source files without evaluating R code. Supply a precomputed
#' `targets::tar_network()` result to use its vertices, edges, and statuses
#' while retaining groups inferred from the source.
#'
#' This bridge runs after pipeline definition and before graph inspection.
#' It requires Node.js and the accompanying tarborist build containing
#' `scripts/pipeline-graph.js`. Source analysis is provisional: unsupported
#' expressions produce diagnostics, and source-only dependency edges may
#' differ from targets' evaluated dependency graph.
#'
#' @param script Default `"_targets.R"`. Path to the pipeline's entry script.
#' @param tarborist_path Default `getOption("tarborist.path")`. Path to the
#'   tarborist checkout or installed extension directory containing the
#'   graph CLI and its installed Node.js dependencies.
#' @param network Default `NULL`. Optional result of
#'   `targets::tar_network(targets_only = TRUE, script = script)` for this
#'   pipeline. Computing that result evaluates pipeline setup code, but this
#'   helper never calls `tar_network()` or executes target commands itself.
#' @param exclude Default `character()`. Target names to omit from the plot.
#'   Incident edges are removed as well.
#' @param direction Default `c("LR", "TB", "RL", "BT")`. Graph direction:
#'   left to right, top to bottom, right to left, or bottom to top.
#' @param scale_nodes Default `FALSE`. Whether to scale target nodes by
#'   their number of incoming and outgoing graph edges.
#' @param output Default `c("widget", "dot", "data")`. Return a DiagrammeR
#'   HTML widget, a DOT character scalar, or the graph's nested R list.
#' @param node Default `Sys.which("node")`. Path to the Node.js executable,
#'   or its executable name on the process search path.
#'
#' @return The object selected by `output`. Graph data contains `nodes`,
#'   `groups`, `edges`, `partial`, and `diagnostics`. Record arrays remain
#'   lists so empty arrays and nested fields preserve their JSON structure.
#' @keywords internal
tar_graph_subpipelines = function(
  script = "_targets.R",
  tarborist_path = getOption("tarborist.path"),
  network = NULL,
  exclude = character(),
  direction = c("LR", "TB", "RL", "BT"),
  scale_nodes = FALSE,
  output = c("widget", "dot", "data"),
  node = Sys.which("node")
) {
  # Validate caller inputs before starting the parser subprocess.
  if (!is.character(script) || length(script) != 1L ||
      is.na(script) || !nzchar(script)) {
    stop("`script` must be one nonempty file path.", call. = FALSE)
  }
  if (!is.character(tarborist_path) || length(tarborist_path) != 1L ||
      is.na(tarborist_path) || !nzchar(tarborist_path)) {
    stop(
      "Set `tarborist_path`, or options(tarborist.path = '/path/to/tarborist').",
      call. = FALSE
    )
  }
  if (!is.character(node) || length(node) != 1L ||
      is.na(node) || !nzchar(node)) {
    stop("Install Node.js or set `node` to its executable path.", call. = FALSE)
  }
  if (!is.character(exclude) || anyNA(exclude) || any(!nzchar(exclude))) {
    stop("`exclude` must contain nonempty target names without NA.", call. = FALSE)
  }
  if (!is.logical(scale_nodes) || length(scale_nodes) != 1L ||
      is.na(scale_nodes)) {
    stop("`scale_nodes` must be TRUE or FALSE.", call. = FALSE)
  }
  direction = match.arg(direction)
  output = match.arg(output)

  if (!is.null(network)) {
    if (!is.list(network) ||
        !is.data.frame(network$vertices) ||
        !is.data.frame(network$edges) ||
        !"name" %in% names(network$vertices) ||
        !all(c("from", "to") %in% names(network$edges))) {
      stop(
        "`network` must have data frames `vertices` (name) and `edges` (from, to).",
        call. = FALSE
      )
    }
    target_names = network$vertices$name
    if (!(is.character(target_names) || is.factor(target_names)) ||
        anyNA(target_names) || any(!nzchar(as.character(target_names))) ||
        anyDuplicated(target_names)) {
      stop("`network$vertices$name` must contain unique target names.", call. = FALSE)
    }
    for (column in c("from", "to")) {
      endpoints = network$edges[[column]]
      if (!(is.character(endpoints) || is.factor(endpoints)) ||
          anyNA(endpoints) || any(!nzchar(as.character(endpoints))) ||
          any(!endpoints %in% target_names)) {
        stop(
          paste0("`network$edges$", column, "` must reference existing vertices."),
          call. = FALSE
        )
      }
    }
    if ("status" %in% names(network$vertices) &&
        !(is.character(network$vertices$status) ||
          is.factor(network$vertices$status))) {
      stop("`network$vertices$status` must be character or factor.", call. = FALSE)
    }
  }

  # Canonical paths keep the subprocess independent of shell expansion.
  script = path.expand(script)
  tarborist_path = path.expand(tarborist_path)
  node = path.expand(node)
  if (!file.exists(script) || dir.exists(script) || file.access(script, 4L) != 0L) {
    stop(paste0("Cannot read pipeline script: ", script), call. = FALSE)
  }
  if (!dir.exists(tarborist_path)) {
    stop(paste0("Cannot find tarborist directory: ", tarborist_path), call. = FALSE)
  }
  cli = file.path(tarborist_path, "scripts", "pipeline-graph.js")
  if (!file.exists(cli) || dir.exists(cli) || file.access(cli, 4L) != 0L) {
    stop(
      paste0("Cannot read ", cli, ". Use the tarborist build with grouped graphs."),
      call. = FALSE
    )
  }
  if (!file.exists(node)) {
    node = unname(Sys.which(node))
  }
  if (!nzchar(node) || !file.exists(node) || dir.exists(node)) {
    stop("Cannot find the Node.js executable. Check `node` or your PATH.", call. = FALSE)
  }
  script = normalizePath(script, winslash = "/", mustWork = TRUE)
  cli = normalizePath(cli, winslash = "/", mustWork = TRUE)
  node = normalizePath(node, winslash = "/", mustWork = TRUE)
  exclude = unique(unname(exclude))
  if (!is.null(network)) {
    network$vertices$name = as.character(network$vertices$name)
    network$edges$from = as.character(network$edges$from)
    network$edges$to = as.character(network$edges$to)
    if ("status" %in% names(network$vertices)) {
      network$vertices$status = as.character(network$vertices$status)
    }
  }

  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("Install `jsonlite` to communicate with tarborist.", call. = FALSE)
  }
  if (output == "widget" && !requireNamespace("DiagrammeR", quietly = TRUE)) {
    stop("Install `DiagrammeR`, or use output = 'dot' or 'data'.", call. = FALSE)
  }

  # JSON files avoid interpolating R code or target names into shell arguments.
  temporary_directory = tempfile("tarborist_graph_")
  if (!dir.create(temporary_directory, mode = "0700")) {
    stop("Cannot create the temporary graph request directory.", call. = FALSE)
  }
  on.exit(unlink(temporary_directory, recursive = TRUE), add = TRUE)
  request_file = file.path(temporary_directory, "request.json")
  response_file = file.path(temporary_directory, "response.json")
  error_file = file.path(temporary_directory, "stderr.txt")
  request = list(
    script = script,
    network = network,
    exclude = I(exclude),
    direction = direction,
    scaleNodes = scale_nodes
  )
  jsonlite::write_json(
    request,
    path = request_file,
    auto_unbox = TRUE,
    dataframe = "rows",
    null = "null",
    na = "null",
    digits = NA
  )

  # system2 quotes the executable itself; each file argument needs shQuote().
  status = tryCatch(
    suppressWarnings(system2(
      command = node,
      args = c(shQuote(cli), "--request", shQuote(request_file)),
      stdout = response_file,
      stderr = error_file,
      wait = TRUE
    )),
    error = identity
  )
  stderr = character()
  if (file.exists(error_file)) {
    stderr = readLines(error_file, warn = FALSE, encoding = "UTF-8")
  }
  if (inherits(status, "error") || !identical(as.integer(status), 0L)) {
    details = if (inherits(status, "error")) conditionMessage(status) else {
      paste0("Node.js exited with status ", status, ".")
    }
    stop(
      paste(c("tarborist could not construct the graph.", details, stderr), collapse = "\n"),
      call. = FALSE
    )
  }

  # Validate the process boundary before exposing its graph to the caller.
  response = tryCatch(
    jsonlite::fromJSON(response_file, simplifyVector = FALSE),
    error = identity
  )
  if (inherits(response, "error")) {
    stop(
      paste(
        c("tarborist returned invalid JSON.", conditionMessage(response), stderr),
        collapse = "\n"
      ),
      call. = FALSE
    )
  }
  if (!is.list(response)) {
    stop("tarborist returned an incompatible graph response.", call. = FALSE)
  }
  graph = response$graph
  if (!is.list(graph) ||
      !is.character(response$dot) || length(response$dot) != 1L ||
      is.na(response$dot) ||
      !is.logical(graph$partial) || length(graph$partial) != 1L ||
      is.na(graph$partial) ||
      !all(vapply(graph[c("nodes", "groups", "edges", "diagnostics")], is.list, logical(1)))) {
    stop("tarborist returned an incompatible graph response.", call. = FALSE)
  }

  if (graph$partial) {
    messages = character()
    for (diagnostic in graph$diagnostics) {
      message = if (is.list(diagnostic)) diagnostic$message else diagnostic
      if (is.character(message) && length(message) == 1L &&
          !is.na(message) && nzchar(message)) {
        messages = c(messages, message)
      }
    }
    messages = unique(messages)
    detail = paste(utils::head(messages, 3L), collapse = " ")
    if (length(messages) > 3L) {
      detail = paste0(detail, " (", length(messages) - 3L, " more diagnostics.)")
    }
    warning(
      trimws(paste("The pipeline graph is partial.", detail)),
      call. = FALSE
    )
  }

  if (output == "data") {
    return(graph)
  }
  if (output == "dot") {
    return(response$dot)
  }
  return(DiagrammeR::grViz(response$dot))
}
