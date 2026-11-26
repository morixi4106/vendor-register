import base from "./vitest.config.js";

export default {
  ...base,
  test: {
    ...base.test,
    include: ["tests/default.test.js"],
    setupFiles: ["tests/prebuilt.setup.js"],
    reporters: ["json"],
    outputFile: "../../.audit/international-prebuilt-results.json",
  },
};
