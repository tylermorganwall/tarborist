local({
  tarborist_env = if (exists(".tarborist_env", envir = .GlobalEnv, inherits = FALSE)) {
    get(".tarborist_env", envir = .GlobalEnv, inherits = FALSE)
  } else {
    env = new.env(parent = emptyenv())
    assign(".tarborist_env", env, envir = .GlobalEnv)
    env
  }

  read_manifest = function(path) {
    manifest = utils::read.delim(
      file = path,
      sep = "\t",
      quote = "",
      header = TRUE,
      stringsAsFactors = FALSE,
      check.names = FALSE
    )

    required = c("name", "file", "line", "column")
    missing = setdiff(required, names(manifest))
    if (length(missing) > 0L) {
      stop(
        "tarborist manifest is missing columns: ",
        paste(missing, collapse = ", "),
        call. = FALSE
      )
    }

    manifest$name = as.character(manifest$name)
    manifest$file = as.character(manifest$file)
    manifest$line = as.integer(manifest$line)
    manifest$column = as.integer(manifest$column)

    manifest = manifest[!is.na(manifest$name) & nzchar(manifest$name), , drop = FALSE]
    manifest$column[is.na(manifest$column)] = 1L
    manifest$line[is.na(manifest$line)] = 1L

    manifest
  }

  normalize_manifest_path = function(path) {
    if (!is.character(path) || length(path) != 1L || is.na(path) || !nzchar(path)) {
      stop("`path` must be a non-empty scalar character string.", call. = FALSE)
    }

    normalizePath(path, winslash = "/", mustWork = TRUE)
  }

  ensure_manifest_loaded = function(path) {
    path = normalize_manifest_path(path)
    info = file.info(path)
    mtime = as.numeric(info$mtime[[1]])

    current_path = get0("manifest_path", envir = tarborist_env, inherits = FALSE, ifnotfound = NULL)
    current_mtime = get0("manifest_mtime", envir = tarborist_env, inherits = FALSE, ifnotfound = NA_real_)

    if (
      identical(current_path, path) &&
      identical(current_mtime, mtime) &&
      exists("link_index", envir = tarborist_env, inherits = FALSE)
    ) {
      return(invisible(path))
    }

    manifest = read_manifest(path)
    link_index = new.env(parent = emptyenv())

    if (nrow(manifest) > 0L) {
      for (i in seq_len(nrow(manifest))) {
        assign(
          manifest$name[[i]],
          list(
            file = manifest$file[[i]],
            line = manifest$line[[i]],
            column = manifest$column[[i]]
          ),
          envir = link_index
        )
      }
    }

    tarborist_env$link_index = link_index
    tarborist_env$branch_parent_index = new.env(parent = emptyenv())
    tarborist_env$branch_parent_refreshed_at = 0
    tarborist_env$manifest_path = path
    tarborist_env$manifest_mtime = mtime

    invisible(path)
  }

  encode_file_path = function(path) {
    encoded = utils::URLencode(path, reserved = TRUE)
    encoded = gsub("%2F", "/", encoded, fixed = TRUE)
    encoded = gsub("%3A", ":", encoded, fixed = TRUE)
    encoded
  }

  normalize_file_uri = function(path) {
    normalized = normalizePath(path, winslash = "/", mustWork = FALSE)
    encoded = encode_file_path(normalized)

    if (.Platform$OS.type == "windows") {
      paste0("file:///", encoded)
    } else {
      paste0("file://", encoded)
    }
  }

  osc8_file_link = function(label, file, line, column = 1L) {
    params = paste0("line=", as.integer(line), ":col=", as.integer(column))
    uri = normalize_file_uri(file)

    paste0(
      "\033]8;", params, ";", uri, "\007",
      label,
      "\033]8;;\007"
    )
  }

  refresh_branch_parent_index = function(store, force = FALSE) {
    now = as.numeric(Sys.time())
    last_refresh = get0(
      "branch_parent_refreshed_at",
      envir = tarborist_env,
      inherits = FALSE,
      ifnotfound = 0
    )

    if (!isTRUE(force) && is.finite(last_refresh) && (now - last_refresh) < 0.25) {
      return(invisible(NULL))
    }

    tarborist_env$branch_parent_refreshed_at = now

    progress = tryCatch(
      targets::tar_progress(store = store),
      error = function(e) NULL
    )

    if (
      is.null(progress) ||
      !is.data.frame(progress) ||
      nrow(progress) == 0L ||
      !all(c("name", "type", "parent") %in% names(progress))
    ) {
      return(invisible(NULL))
    }

    branch_parent_index = new.env(parent = emptyenv())
    is_branch = !is.na(progress$type) &
      progress$type == "branch" &
      !is.na(progress$parent) &
      nzchar(progress$parent)

    if (any(is_branch)) {
      rows = which(is_branch)
      for (i in rows) {
        assign(progress$name[[i]], progress$parent[[i]], envir = branch_parent_index)
      }
    }

    tarborist_env$branch_parent_index = branch_parent_index
    invisible(NULL)
  }

  resolve_destination = function(token, store) {
    if (
      exists("link_index", envir = tarborist_env, inherits = FALSE) &&
      exists(token, envir = tarborist_env$link_index, inherits = FALSE)
    ) {
      return(get(token, envir = tarborist_env$link_index, inherits = FALSE))
    }

    refresh_branch_parent_index(store = store)

    if (
      exists("branch_parent_index", envir = tarborist_env, inherits = FALSE) &&
      exists(token, envir = tarborist_env$branch_parent_index, inherits = FALSE)
    ) {
      parent = get(token, envir = tarborist_env$branch_parent_index, inherits = FALSE)
      if (
        exists("link_index", envir = tarborist_env, inherits = FALSE) &&
        exists(parent, envir = tarborist_env$link_index, inherits = FALSE)
      ) {
        return(get(parent, envir = tarborist_env$link_index, inherits = FALSE))
      }
    }

    NULL
  }

  rewrite_line = function(text, store) {
    if (!nzchar(text)) {
      return(text)
    }

    starts = gregexpr("[A-Za-z][A-Za-z0-9._]*", text, perl = TRUE)[[1]]
    if (length(starts) == 1L && identical(starts[[1]], -1L)) {
      return(text)
    }

    lengths = attr(starts, "match.length")
    cache = new.env(parent = emptyenv())
    pieces = character(0)
    cursor = 1L
    total = nchar(text, type = "chars")

    for (i in seq_along(starts)) {
      start = starts[[i]]
      end = start + lengths[[i]] - 1L
      token = substr(text, start, end)

      if (start > cursor) {
        pieces = c(pieces, substr(text, cursor, start - 1L))
      }

      destination = if (exists(token, envir = cache, inherits = FALSE)) {
        get(token, envir = cache, inherits = FALSE)
      } else {
        value = resolve_destination(token, store = store)
        assign(token, value, envir = cache)
        value
      }

      if (is.null(destination)) {
        pieces = c(pieces, token)
      } else {
        pieces = c(
          pieces,
          osc8_file_link(
            label = token,
            file = destination$file,
            line = destination$line,
            column = destination$column
          )
        )
      }

      cursor = end + 1L
    }

    if (cursor <= total) {
      pieces = c(pieces, substr(text, cursor, total))
    }

    paste(pieces, collapse = "")
  }

  rewrite_text = function(text, store) {
    lines = strsplit(as.character(text), "\n", fixed = TRUE)[[1]]
    rewritten = vapply(
      lines,
      FUN = function(line) rewrite_line(line, store = store),
      FUN.VALUE = character(1),
      USE.NAMES = FALSE
    )
    paste(rewritten, collapse = "\n")
  }

  emit_console = function(text) {
    cat(text, "\n", sep = "", file = stderr())
    flush(stderr())
  }

  emit_captured_output = function(lines, store) {
    if (!length(lines)) {
      return(invisible(NULL))
    }

    for (line in lines) {
      emit_console(rewrite_line(line, store = store))
    }

    invisible(NULL)
  }

  #' Set the active tarborist manifest.
  #'
  #' @param path Default `NULL`. Absolute path to the tarborist manifest TSV.
  #' @return Invisibly returns the normalized manifest path.
  tarborist_set_manifest = function(path) {
    path = normalize_manifest_path(path)
    tarborist_env$manifest_path = path
    tarborist_env$manifest_mtime = NA_real_
    ensure_manifest_loaded(path)
    emit_console(
      paste0(
        "tarborist_make() was installed in .GlobalEnv and is ready to use with manifest ",
        path
      )
    )
    invisible(path)
  }

  #' Run `targets::tar_make()` with tarborist link rewriting.
  #'
  #' @param ... Default empty. Arguments forwarded to `targets::tar_make()`.
  #' @param .tarborist_manifest Default `NULL`. Override path to the tarborist manifest TSV.
  #' @param .tarborist_mode Default `"strict"`. `"strict"` sets link-friendly defaults when absent, `"best_effort"` forwards arguments unchanged.
  #' @return Returns the result of `targets::tar_make()`.
  tarborist_make = function(
    ...,
    .tarborist_manifest = NULL,
    .tarborist_mode = c("strict", "best_effort")
  ) {
    .tarborist_mode = match.arg(.tarborist_mode)
    args = list(...)

    manifest_path = .tarborist_manifest
    if (is.null(manifest_path)) {
      manifest_path = get0("manifest_path", envir = tarborist_env, inherits = FALSE, ifnotfound = NULL)
    }

    if (is.null(manifest_path) || !nzchar(manifest_path)) {
      stop(
        "No tarborist manifest is configured. Run `tarborist_set_manifest(path)` first.",
        call. = FALSE
      )
    }

    ensure_manifest_loaded(manifest_path)

    store = if (!is.null(args$store)) {
      args$store
    } else {
      targets::tar_config_get("store")
    }

    if (.tarborist_mode == "strict") {
      if (is.null(args$reporter)) {
        args$reporter = "verbose"
      }
      if (is.null(args$callr_function)) {
        args$callr_function = NULL
      }
      if (is.null(args$use_crew)) {
        args$use_crew = FALSE
      }
      if (is.null(args$as_job)) {
        args$as_job = FALSE
      }

      if (!identical(args$reporter, "verbose") && !identical(args$reporter, "timestamp")) {
        warning(
          "Linkification is most reliable with `reporter = \"verbose\"` or `\"timestamp\"`.",
          call. = FALSE
        )
      }
      if (!is.null(args$callr_function)) {
        warning(
          "Linkification is most reliable with `callr_function = NULL`.",
          call. = FALSE
        )
      }
      if (!identical(args$use_crew, FALSE)) {
        warning(
          "Linkification is most reliable with `use_crew = FALSE`.",
          call. = FALSE
        )
      }
    }

    captured_output = character(0)
    output_connection = textConnection("captured_output", "w", local = TRUE)
    run_error = NULL

    sink(output_connection, type = "output")
    on.exit({
      while (sink.number(type = "output") > 0) {
        sink(type = "output")
      }
      close(output_connection)
      emit_captured_output(captured_output, store = store)
    }, add = TRUE)

    result = withCallingHandlers(
      tryCatch(
        do.call(targets::tar_make, args),
        error = function(e) {
          run_error <<- e
          NULL
        }
      ),
      message = function(cnd) {
        emit_console(rewrite_text(conditionMessage(cnd), store = store))
        invokeRestart("muffleMessage")
      },
      warning = function(cnd) {
        emit_console(paste0("Warning: ", rewrite_text(conditionMessage(cnd), store = store)))
        invokeRestart("muffleWarning")
      }
    )

    if (!is.null(run_error)) {
      stop(
        simpleError(
          message = rewrite_text(conditionMessage(run_error), store = store),
          call = conditionCall(run_error)
        )
      )
    }

    invisible(result)
  }

  assign("tarborist_set_manifest", tarborist_set_manifest, envir = .GlobalEnv)
  assign("tarborist_make", tarborist_make, envir = .GlobalEnv)
})
