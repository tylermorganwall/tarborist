list(
  tar_target(a, 1),
  tar_target(b, a + 1),
  tar_target(c, b + 1),
  tar_target(d, c + 1)
)
