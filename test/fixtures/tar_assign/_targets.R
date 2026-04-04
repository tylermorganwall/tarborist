tarchetypes::tar_assign({
	alpha <- tar_target(command = 1)
	beta <- tar_target(command = alpha + 1)
})

list(
	tarchetypes::tar_assign({
		alpha <- tar_target(command = 1)
		beta <- tar_target(command = alpha + 1)
	}),
	tar_target(
		gamma,
		alpha + beta
	)
)
