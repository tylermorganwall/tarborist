library(targets)
library(tarchetypes)

tar_option_set(
	packages = c("tibble", "dplyr")
)

tar_source("helpers")
source("R/part.R")

mapped_reports = tar_map(
	values = list(
		species = c("adelie", "gentoo")
	),
	names = species,
	tar_target(
		fit_penguins,
		paste("fit", species),
		cue = tar_cue(mode = "never"),
		deployment = "main"
	),
	tar_target(
		report_penguins,
		paste("report for", fit_penguins)
	)
)

cycle_demo = list(
	tar_target(cycle_a, cycle_b + 1),
	tar_target(cycle_b, cycle_a + 1)
)

list(
	cycle_demo,
	part_targets,
	scoring_targets,
	mapped_reports,
	tar_target(
		pipeline_summary,
		tibble::tibble(
			raw_rows = nrow(raw_data),
			filtered_rows = nrow(filtered_data),
			score_rows = nrow(scored_data)
		)
	),
	tar_target(
		generated_report_lookup,
		tar_read_raw("report_penguins_adelie")
	),
	tar_target(
		downstream_demo,
		paste(report_summary, generated_report_lookup)
	)
)
