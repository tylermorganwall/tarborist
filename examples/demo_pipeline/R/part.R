part_targets = list(
  tar_target(
    raw_data,
    tibble::tibble(
      species = c("adelie", "gentoo"),
      value = c(10, 20)
    )
  ),
  tar_target(
    selected_species,
    c("adelie", "gentoo")
  ),
  tar_target(
    filtered_data,
    dplyr::filter(raw_data, species %in% selected_species),
    pattern = map(selected_species)
  )
)
