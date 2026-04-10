"use strict";

// Keep navigation destinations consistent across definition, hover, and symbol
// providers, especially for generated tar_map() targets.
function getTargetLocation(target) {
  if (target && target.generated && target.generator) {
    return {
      file: target.generator.file,
      range: target.generator.range
    };
  }

  return {
    file: target.file,
    range: target.nameRange
  };
}

module.exports = {
  getTargetLocation
};
