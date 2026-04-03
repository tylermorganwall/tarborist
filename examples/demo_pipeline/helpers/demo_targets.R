helper_multiplier = function(x) {
  x * 2
}

cue_on_global = function(value) {
  tar_cue(mode = if (identical(value, "yes")) "always" else "thorough")
}

scored_target = tar_target(
  scored_data,
  dplyr::mutate(filtered_data, score = helper_multiplier(value)),
  cue = cue_on_global("yes"),
  priority = 10
)

scoring_targets = list(
  scored_target,
  tar_target(
    report_summary,
    paste("rows", nrow(scored_data))
  )
)
