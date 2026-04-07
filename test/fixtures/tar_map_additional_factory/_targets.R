mapped_reports <- tarchetypes::tar_map(
  values = list(report_name = c("alpha", "beta")),
  names = report_name,
  tar_file(quarto_parameterized, "quarto_parameterized.qmd"),
  tar_target(rendered_report, paste(quarto_parameterized, report_name))
)

list(mapped_reports)
