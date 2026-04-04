part <- list(
	tar_target(alpha, 1),
	tar_target(beta, 2),
	tar_target(gamma, alpha + beta),
	tar_target(lambda, 3)
)

part2 = list(
	tarchetypes::tar_select_targets(
		part,
		!starts_with("b") & (starts_with("a") | starts_with("g"))
	)
)

list(
	part2
)
