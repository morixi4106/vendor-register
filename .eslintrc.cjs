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
