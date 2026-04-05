list(
	tarchetypes::tar_qs(a, 1),
	tarchetypes::tar_parquet(b, a + 1),
	tarchetypes::tar_assign({
		c <- tar_qs(a + b)
		d <- tar_parquet(command = c + 1)
	})
)
