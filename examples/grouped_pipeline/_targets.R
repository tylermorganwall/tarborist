library(targets)

targets_inputs = list(
  tar_target(observations, read.csv("observations.csv")),
  tar_target(configuration, list(seed = 101, proportion = 0.8)),
  NULL
)

targets_prepare = list(
  tar_target(clean_data, observations[complete.cases(observations), ]),
  tar_target(training_rows, {
    set.seed(configuration$seed)
    sample(seq_len(nrow(clean_data)), floor(nrow(clean_data) * configuration$proportion))
  }),
  tar_target(training_data, clean_data[training_rows, ]),
  tar_target(test_data, clean_data[-training_rows, ]),
  NULL
)

targets_models = list(
  tar_target(linear_model, lm(response ~ predictor, data = training_data)),
  tar_target(predictions, predict(linear_model, newdata = test_data)),
  tar_target(model_error, mean((test_data$response - predictions)^2)),
  NULL
)

targets_reports = list(
  tar_target(summary_table, data.frame(mse = model_error, n = nrow(test_data))),
  tar_target(diagnostic_plot, plot(test_data$response, predictions)),
  NULL
)

list(
  targets_inputs,
  targets_prepare,
  targets_models,
  targets_reports,
  NULL
)
