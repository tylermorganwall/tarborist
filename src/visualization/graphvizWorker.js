"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { instance } = require("@viz-js/viz");
const { renderGraphLayout } = require("../../media/pipelineGraphModel");

instance().then((viz) => {
  parentPort.postMessage(renderGraphLayout(viz, workerData.dot, workerData.graphWidth));
}).catch((error) => {
  parentPort.postMessage({ error: error.message || String(error) });
});
