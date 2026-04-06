map_values_basic = expand.grid(
  species = "adelie",
  ranking_function = list(rlang::sym("rank_basic")),
  KEEP.OUT.ATTRS = FALSE,
  stringsAsFactors = FALSE
)
map_values_basic$pipelines = "adelie_basic"

map_values_extra = base::expand.grid(
  species = "gentoo",
  ranking_function = list(rlang::sym("rank_extra")),
  KEEP.OUT.ATTRS = FALSE,
  stringsAsFactors = FALSE
)
map_values_extra[["pipelines"]] = "gentoo_extra"

map_values_more = expand.grid(
  species = "chinstrap",
  ranking_function = list(rlang::sym("rank_more")),
  KEEP.OUT.ATTRS = FALSE,
  stringsAsFactors = FALSE
)
map_values_more$pipelines = "chinstrap_more"

map_values = base::rbind(
  map_values_basic,
  rbind(map_values_extra, map_values_more)
)

mapped_reports = tarchetypes::tar_map(
  values = map_values,
  names = pipelines,
  tar_target(
    fit_penguins,
    paste("fit", species, ranking_function)
  ),
  tar_target(
    report_penguins,
    paste("report", fit_penguins)
  )
)

list(mapped_reports)
