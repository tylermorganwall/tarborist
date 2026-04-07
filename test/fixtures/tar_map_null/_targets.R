list(
  tarchetypes::tar_map(
    values = list(species = c("adelie", "gentoo")),
    tar_target(fit_penguins, species),
    tar_target(report_penguins, tar_read(fit_penguins)),
    NULL
  )
)
