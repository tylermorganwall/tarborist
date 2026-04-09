"use strict";

// Keep target-navigation destinations in one place so hover and console links
// open the same definition for both normal and generated targets.
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
