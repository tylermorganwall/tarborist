mapped_reports <- tar_map(
  values = list(
    species = c("adelie", "gentoo")
  ),
  names = species,
  tar_target(
    fit_penguins,
    paste("fit", species)
  )
)

list(
  mapped_reports[["fit_penguins_adelie"]],
  tar_target(summary_fit, fit_penguins_adelie)
)
