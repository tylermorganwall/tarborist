f = function(x) {
	x + 1
}

f2 = \(x) x + 2

tarchetypes::tar_assign({
	alpha <- tar_target(1)

	beta <- f(alpha) |>
		tar_target()

	gamma <- f(alpha) |>
		tar_target(command = _)

	delta <- f2(gamma) |>
		(\(x) x + 3)() |>
		tar_target(command = _)
})
