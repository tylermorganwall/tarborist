map_values_basic = expand.grid(
	species = c("adelie", "gentoo"),
	ranking_function = list(rlang::sym("rank_basic")),
	KEEP.OUT.ATTRS = FALSE,
	stringsAsFactors = FALSE
)
map_values_basic$pipelines = c("adelie_basic", "gentoo_basic")

map_values_extra = base::expand.grid(
	species = "chinstrap",
	ranking_function = list(rlang::sym("rank_extra")),
	KEEP.OUT.ATTRS = FALSE,
	stringsAsFactors = FALSE
)
map_values_extra[["pipelines"]] = "chinstrap_extra"

map_values = dplyr::bind_rows(map_values_basic, map_values_extra)

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
