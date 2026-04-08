"use strict";

// Keep all target-navigation destinations in one place so hover links, terminal
// links, and tarborist_make manifests cannot drift.
function getTargetDestination(target) {
  if (!target) {
    return null;
  }

  if (target.generated && target.generator) {
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
  getTargetDestination
};
