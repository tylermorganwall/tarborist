list(
	tar_target(unused, 0),
	tar_target(data, 1),
	tar_target(other, 2),
	tar_target(raw_data, 3),
	tar_target(raw_loaded, 4),
	tarchetypes::tar_quarto(report, path = "report.qmd")
)
