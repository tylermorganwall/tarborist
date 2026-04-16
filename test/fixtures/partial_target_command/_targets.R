list(
  tar_target(plot, command = {
    ggplot(data) + geom_point() +
  }),
  tar_target(other, 1),
  tar_target(third, other + 1)
)
