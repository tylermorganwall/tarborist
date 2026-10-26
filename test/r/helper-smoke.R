# Run with:
# Rscript test/r/helper-smoke.R /path/to/custom_graph.R /path/to/tarborist

#' Check the R helper's parser and subprocess boundary
#'
#' Exercises the bridge with temporary source files and an explicit network.
#' This stage checks JSON transfer and return modes after the JavaScript CLI
#' is installed, without evaluating targets or requiring the targets package.
#'
#' @param helper_file Path to the delivered custom_graph.R helper.
#' @param tarborist_root Path to the modified tarborist checkout.
#'
#' @return TRUE after all available checks succeed.
#' @keywords internal
run_bridge_smoke = function(helper_file, tarborist_root) {
  source(helper_file, local = TRUE)
  tarborist_root = normalizePath(tarborist_root, winslash = "/", mustWork = TRUE)
  directory = tempfile("tarborist bridge smoke ")
  stopifnot(dir.create(directory))
  on.exit(unlink(directory, recursive = TRUE), add = TRUE)
  script = file.path(directory, "pipeline with spaces.R")
  marker = file.path(directory, "setup-was-executed.txt")
  writeLines(c(
    "library(targets)",
    paste0("writeLines('setup executed', ", encodeString(marker, quote = '"'), ")"),
    "targets_alpha = list(",
    "  targets::tar_target(input, 1),",
    "  targets::tar_target(clean, input + 1),",
    "  NULL",
    ")",
    "targets_beta = list(",
    "  targets::tar_target(result, clean * 2),",
    "  NULL",
    ")",
    "list(targets_alpha, targets_beta, NULL)"
  ), script)

  graph = tar_graph_subpipelines(
    script = script,
    tarborist_path = tarborist_root,
    output = "data"
  )
  stopifnot(
    !file.exists(marker),
    identical(graph$partial, FALSE),
    identical(graph$graphSource, "static"),
    setequal(vapply(graph$nodes, `[[`, character(1), "name"), c("input", "clean", "result")),
    setequal(vapply(graph$groups, `[[`, character(1), "label"), c("targets_alpha", "targets_beta")),
    length(graph$edges) == 2L
  )

  # A length-one exclusion must cross JSON as an array, not a scalar.
  trimmed = tar_graph_subpipelines(
    script = script,
    tarborist_path = tarborist_root,
    exclude = "clean",
    output = "data"
  )
  stopifnot(
    setequal(vapply(trimmed$nodes, `[[`, character(1), "name"), c("input", "result")),
    length(trimmed$edges) == 0L
  )

  network = list(
    vertices = data.frame(
      name = c("input", "clean", "result", "factory_output"),
      status = c("uptodate", "outdated", "errored", "queued"),
      stringsAsFactors = FALSE
    ),
    edges = data.frame(
      from = c("input", "clean", "result"),
      to = c("clean", "result", "factory_output"),
      stringsAsFactors = FALSE
    )
  )
  evaluated = tar_graph_subpipelines(
    script = script,
    tarborist_path = tarborist_root,
    network = network,
    output = "data"
  )
  returned_names = vapply(evaluated$nodes, `[[`, character(1), "name")
  returned_statuses = vapply(evaluated$nodes, `[[`, character(1), "status")
  stopifnot(
    identical(evaluated$graphSource, "network"),
    identical(returned_names, network$vertices$name),
    identical(returned_statuses, network$vertices$status),
    length(evaluated$edges) == 3L,
    is.null(evaluated$nodes[[match("factory_output", returned_names)]]$groupId)
  )

  dot = tar_graph_subpipelines(
    script = script,
    tarborist_path = tarborist_root,
    direction = "TB",
    scale_nodes = TRUE,
    output = "dot"
  )
  stopifnot(
    is.character(dot),
    length(dot) == 1L,
    grepl("rankdir=TB", dot, fixed = TRUE),
    grepl("subgraph cluster_", dot, fixed = TRUE)
  )

  empty_network = list(
    vertices = data.frame(name = character(), status = character()),
    edges = data.frame(from = character(), to = character())
  )
  empty = tar_graph_subpipelines(
    script = script,
    tarborist_path = tarborist_root,
    network = empty_network,
    output = "data"
  )
  stopifnot(length(empty$nodes) == 0L, length(empty$groups) == 0L, length(empty$edges) == 0L)

  partial_script = file.path(directory, "partial.R")
  writeLines("list(make_targets())", partial_script)
  partial_warning = tryCatch(
    tar_graph_subpipelines(
      script = partial_script,
      tarborist_path = tarborist_root,
      output = "data"
    ),
    warning = identity
  )
  stopifnot(
    inherits(partial_warning, "warning"),
    grepl("partial", conditionMessage(partial_warning), fixed = TRUE)
  )

  invalid_network = network
  invalid_network$edges$to[1] = "missing_vertex"
  invalid = tryCatch(
    tar_graph_subpipelines(
      script = script,
      tarborist_path = tarborist_root,
      network = invalid_network,
      output = "data"
    ),
    error = identity
  )
  stopifnot(
    inherits(invalid, "error"),
    grepl("existing vertices", conditionMessage(invalid), fixed = TRUE)
  )

  # A failing CLI must return its stderr alongside the process exit status.
  failing_root = file.path(directory, "failing tarborist")
  stopifnot(dir.create(file.path(failing_root, "scripts"), recursive = TRUE))
  writeLines(
    "process.stderr.write('known graph failure\\n'); process.exit(7);",
    file.path(failing_root, "scripts", "pipeline-graph.js")
  )
  failure = tryCatch(
    tar_graph_subpipelines(
      script = script,
      tarborist_path = failing_root,
      output = "data"
    ),
    error = identity
  )
  stopifnot(
    inherits(failure, "error"),
    grepl("known graph failure", conditionMessage(failure), fixed = TRUE),
    grepl("status 7", conditionMessage(failure), fixed = TRUE)
  )

  if (requireNamespace("DiagrammeR", quietly = TRUE)) {
    widget = tar_graph_subpipelines(script = script, tarborist_path = tarborist_root)
    stopifnot(inherits(widget, "htmlwidget"), inherits(widget, "grViz"))
  } else {
    message("SKIP widget return check: DiagrammeR is not installed.")
  }
  stopifnot(!file.exists(marker))
  message("R bridge smoke checks passed.")
  return(TRUE)
}

arguments = commandArgs(trailingOnly = TRUE)
if (length(arguments) != 2L) {
  stop("Usage: Rscript test/r/helper-smoke.R helper_file tarborist_root", call. = FALSE)
}
run_bridge_smoke(arguments[[1]], arguments[[2]])
