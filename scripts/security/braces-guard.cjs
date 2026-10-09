"use strict";

const MAX_LENGTH = 1024;
const MAX_DEPTH = 32;
const MAX_AST_DEPTH = 64;
const MAX_NODES = 2048;

function reject() {
  const error = new Error("unsafe_build_pattern");
  error.code = "UNSAFE_BUILD_PATTERN";
  throw error;
}

function validatePattern(input) {
  if (typeof input !== "string" || input.length > MAX_LENGTH) reject();
  let depth = 0;
  for (const character of input) {
    if (character === "{" && ++depth > MAX_DEPTH) reject();
    if (character === "}") depth = Math.max(0, depth - 1);
  }
}

function validateAst(input) {
  const stack = [[input, 0]];
  const seen = new Set();
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      seen.has(node) ||
      depth > MAX_AST_DEPTH ||
      seen.size >= MAX_NODES
    )
      reject();
    seen.add(node);
    if (
      node.value !== undefined &&
      (typeof node.value !== "string" || node.value.length > MAX_LENGTH)
    )
      reject();
    if (node.nodes !== undefined) {
      if (!Array.isArray(node.nodes) || node.nodes.length > MAX_NODES) reject();
      for (const child of node.nodes) stack.push([child, depth + 1]);
      if (stack.length > MAX_NODES) reject();
    }
  }
}

function validateInput(input, kind) {
  if (kind === "index" && Array.isArray(input)) {
    if (input.length > 64) reject();
    input.forEach(validatePattern);
  } else if (typeof input === "string") validatePattern(input);
  else validateAst(input);
}

exports.validatePattern = validatePattern;
exports.validateAst = validateAst;
exports.wrap = function wrap(original, kind) {
  if (typeof original !== "function") reject();
  const guarded = function (input, options, ...rest) {
    validateInput(input, kind);
    return original.call(this, input, options, ...rest);
  };
  if (kind === "index") {
    for (const [name, value] of Object.entries(original)) {
      guarded[name] =
        typeof value === "function" ? exports.wrap(value, name) : value;
    }
  }
  return guarded;
};
