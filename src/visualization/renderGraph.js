"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

// Graphviz layout is synchronous and can be expensive. Run it outside the
// extension host so navigation and editing stay responsive during layout.
function renderGraphLayout(dot, graphWidth = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "graphvizWorker.js"), {
      workerData: { dot, graphWidth }
    });
    worker.once("message", (result) => {
      if (result.error) {
        reject(new Error(result.error));
      } else {
        resolve(result);
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Graphviz layout worker exited with code ${code}.`));
      }
    });
  });
}

function renderGraphSvg(dot, graphWidth = null) {
  return renderGraphLayout(dot, graphWidth).then((result) => result.svg);
}

module.exports = { renderGraphLayout, renderGraphSvg };
