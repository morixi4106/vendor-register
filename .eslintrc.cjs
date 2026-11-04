/** @type {import('@types/eslint').Linter.BaseConfig} */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: ["eslint:recommended", "prettier"],
  parserOptions: {
    ecmaVersion: "latest",
    ecmaFeatures: { jsx: true },
    sourceType: "module",
  },
  plugins: ["react-hooks"],
  globals: {
    shopify: "readonly",
  },
  overrides: [
    {
      files: [
        "vendor/minimatch/dist/commonjs/index.js",
        "vendor/minimatch/dist/commonjs/unescape.js",
        "vendor/minimatch/dist/esm/index.js",
        "vendor/minimatch/dist/esm/unescape.js",
      ],
      // Preserve hash-bound upstream regex bytes; all other lint rules remain.
      rules: { "no-useless-escape": "off" },
    },
  ],
  rules: {
    ...require("eslint-plugin-react-hooks").configs.recommended.rules,
    "no-constant-condition": ["error", { checkLoops: false }],
    "no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      },
    ],
  },
};
