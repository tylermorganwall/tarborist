list(
  tarchetypes::tar_map(
    values = list(species = c("adelie", "gentoo")),
    targets::tar_target(fit_penguins, species),
    targets::tar_target(report_penguins, tar_read(fit_penguins))
  )
)
