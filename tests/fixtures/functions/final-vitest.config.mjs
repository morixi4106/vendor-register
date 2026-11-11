import fs from "node:fs";

const manifest = JSON.parse(
  fs.readFileSync(process.env.OJA_FUNCTION_LAB_MANIFEST),
);
export default {
  root: manifest.snapshot,
  cacheDir: `${manifest.home}/vite-cache`,
  test: {
    include: ["tests/default.test.js"],
    setupFiles: ["/inputs/final-vitest.setup.mjs"],
    reporters: ["json"],
    outputFile: `${manifest.home}/vitest-results.json`,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
};
