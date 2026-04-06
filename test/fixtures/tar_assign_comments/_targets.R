tarchetypes::tar_assign({
  alpha <- tar_target(1)

  # this comment should not trigger a warning

  beta <- tar_target(alpha + 1)
})
