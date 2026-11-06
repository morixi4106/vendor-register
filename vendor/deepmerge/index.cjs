// MIT upstream: TehShrike/deepmerge@5b87756a5671635679001cbac72aa42f23472c81.
// Local security changes are documented in provenance.json; do not relabel as upstream.
var defaultIsMergeableObject = require("is-mergeable-object");

function emptyTarget(val) {
  return Array.isArray(val) ? [] : {};
}

function cloneUnlessOtherwiseSpecified(value, options) {
  return options.clone !== false && options.isMergeableObject(value)
    ? deepmerge(emptyTarget(value), value, options)
    : value;
}

function defaultArrayMerge(target, source, options) {
  return target.concat(source).map(function (element) {
    return cloneUnlessOtherwiseSpecified(element, options);
  });
}

function getMergeFunction(key, options) {
  if (!options.customMerge) return deepmerge;
  var customMerge = options.customMerge(key);
  return typeof customMerge === "function" ? customMerge : deepmerge;
}

function getEnumerableOwnPropertySymbols(target) {
  return Object.getOwnPropertySymbols
    ? Object.getOwnPropertySymbols(target).filter(function (symbol) {
        return Object.prototype.propertyIsEnumerable.call(target, symbol);
      })
    : [];
}

function getKeys(target) {
  return Object.keys(target).concat(getEnumerableOwnPropertySymbols(target));
}

function propertyIsOnObject(object, property) {
  if (
    object === null ||
    (typeof object !== "object" && typeof object !== "function")
  )
    return false;
  try {
    return property in object;
  } catch (_) {
    return true;
  }
}

function keyIsForbidden(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function propertyIsUnsafe(target, key) {
  return (
    keyIsForbidden(key) ||
    (propertyIsOnObject(target, key) &&
      !(
        Object.prototype.hasOwnProperty.call(target, key) &&
        Object.prototype.propertyIsEnumerable.call(target, key)
      ))
  );
}

function setValue(destination, key, value) {
  Object.defineProperty(destination, key, {
    value: value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function mergeObject(target, source, options) {
  var destination = {};
  if (options.isMergeableObject(target)) {
    getKeys(target).forEach(function (key) {
      if (keyIsForbidden(key)) return;
      setValue(
        destination,
        key,
        cloneUnlessOtherwiseSpecified(target[key], options),
      );
    });
  }
  getKeys(source).forEach(function (key) {
    if (propertyIsUnsafe(target, key)) return;
    if (
      propertyIsOnObject(target, key) &&
      options.isMergeableObject(source[key])
    ) {
      setValue(
        destination,
        key,
        getMergeFunction(key, options)(target[key], source[key], options),
      );
    } else {
      setValue(
        destination,
        key,
        cloneUnlessOtherwiseSpecified(source[key], options),
      );
    }
  });
  return destination;
}

function deepmerge(target, source, options) {
  options = options || {};
  options.arrayMerge = options.arrayMerge || defaultArrayMerge;
  options.isMergeableObject =
    options.isMergeableObject || defaultIsMergeableObject;
  options.cloneUnlessOtherwiseSpecified = cloneUnlessOtherwiseSpecified;
  var sourceIsArray = Array.isArray(source);
  var targetIsArray = Array.isArray(target);
  if (sourceIsArray !== targetIsArray)
    return cloneUnlessOtherwiseSpecified(source, options);
  if (sourceIsArray) return options.arrayMerge(target, source, options);
  return mergeObject(target, source, options);
}

deepmerge.all = function deepmergeAll(array, options) {
  if (!Array.isArray(array))
    throw new Error("first argument should be an array");
  return array.reduce(function (prev, next) {
    return deepmerge(prev, next, options);
  }, {});
};

module.exports = deepmerge;
