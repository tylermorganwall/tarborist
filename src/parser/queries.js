"use strict";

// Central list of call names that tarborist treats as pipeline-relevant.
const DIRECT_TARGET_CALLS = new Set([
  "tar_target",
  "targets::tar_target",
  "tar_file",
  "tarchetypes::tar_file",
  "tar_qs",
  "tarchetypes::tar_qs",
  "tar_skip",
  "tarchetypes::tar_skip"
]);

const DIRECT_TARGET_CALL_NAME_PATTERN = /^[A-Za-z.][A-Za-z0-9._]*(::[A-Za-z.][A-Za-z0-9._]*)?$/;

const MAP_CALLS = new Set([
  "tar_map",
  "tarchetypes::tar_map"
]);

const PLAN_CALLS = new Set([
  "tar_plan",
  "tarchetypes::tar_plan"
]);

const ASSIGN_CALLS = new Set([
  "tar_assign",
  "tarchetypes::tar_assign"
]);

const SELECT_TARGETS_CALLS = new Set([
  "tar_select_targets",
  "tarchetypes::tar_select_targets"
]);

const QUARTO_CALLS = new Set([
  "tar_quarto",
  "tarchetypes::tar_quarto"
]);

const COMBINE_CALLS = new Set([
  "tar_combine",
  "tarchetypes::tar_combine"
]);

const SOURCE_CALLS = new Set([
  "source",
  "base::source"
]);

const TAR_SOURCE_CALLS = new Set([
  "tar_source",
  "targets::tar_source"
]);

const IMPORT_CALLS = new Set([
  ...SOURCE_CALLS,
  ...TAR_SOURCE_CALLS
]);

const TARGET_READ_CALLS = new Set([
  "tar_read",
  "targets::tar_read"
]);

const TARGET_LOAD_CALLS = new Set([
  "tar_load",
  "targets::tar_load"
]);

const TARGET_READ_RAW_CALLS = new Set([
  "tar_read_raw",
  "targets::tar_read_raw"
]);

const TARGET_LOAD_RAW_CALLS = new Set([
  "tar_load_raw",
  "targets::tar_load_raw"
]);

const TAR_MAP_CONTROL_ARGUMENTS = new Set([
  "names",
  "descriptions",
  "unlist",
  "delimiter"
]);

function createDirectTargetCalls(additionalCallNames = []) {
  const names = new Set(DIRECT_TARGET_CALLS);

  for (const value of additionalCallNames || []) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed || !DIRECT_TARGET_CALL_NAME_PATTERN.test(trimmed)) {
      continue;
    }

    names.add(trimmed);
  }

  return names;
}

module.exports = {
  ASSIGN_CALLS,
  COMBINE_CALLS,
  createDirectTargetCalls,
  DIRECT_TARGET_CALLS,
  IMPORT_CALLS,
  MAP_CALLS,
  PLAN_CALLS,
  QUARTO_CALLS,
  SELECT_TARGETS_CALLS,
  SOURCE_CALLS,
  TAR_MAP_CONTROL_ARGUMENTS,
  TAR_SOURCE_CALLS,
  TARGET_LOAD_CALLS,
  TARGET_LOAD_RAW_CALLS,
  TARGET_READ_CALLS,
  TARGET_READ_RAW_CALLS
};
