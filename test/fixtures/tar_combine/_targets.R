first <- tar_target(first, 1)
second <- tar_target(second, 2)
combined <- tarchetypes::tar_combine(name = combined, first, second)

list(
	first,
	second,
	combined
)
