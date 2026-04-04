list(
	tar_target(unused, 0),
	tar_target(data, 1),
	tar_target(other, 2),
	tarchetypes::tar_quarto(report, path = "report.qmd")
)
