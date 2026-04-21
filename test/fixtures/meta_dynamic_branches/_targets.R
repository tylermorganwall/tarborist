list(
  tar_target(values, 1:2),
  tar_target(mapped, values + 1, pattern = map(values))
)
