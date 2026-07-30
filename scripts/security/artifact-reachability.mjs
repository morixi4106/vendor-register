import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TOOLCHAIN_TARGETS = [
  "minimatch",
  "brace-expansion",
  "graphql-config",
  "ts-morph",
  "@ts-morph/common",
];

export const REQUIRED_SECURITY_ARTIFACTS = [
  "build/server/index.js",
  "extensions/marketplace-purchase-control/dist/function.js",
  "extensions/marketplace-purchase-control/dist/function.wasm",
  "extensions/account-home-entry/dist/account-home-entry.js",
  "extensions/account-home-entry/dist/account-home-entry.js.map",
  "extensions/account-home-entry/dist/account-home-entry.metafile.json",
  "extensions/account-home-page/dist/account-home-page.js",
  "extensions/account-home-page/dist/account-home-page.js.map",
  "extensions/account-home-page/dist/account-home-page.metafile.json",
];

export const SECURITY_SOURCE_DIRECTORIES = [
  "app",
  "extensions/account-home-entry/src",
  "extensions/account-home-page/src",
  "extensions/marketplace-purchase-control/src",
];

export const SECURITY_PACKAGE_FILES = [
  "package.json",
  "extensions/account-home-entry/package.json",
  "extensions/account-home-page/package.json",
  "extensions/marketplace-purchase-control/package.json",
];

export const DEFAULT_ARTIFACT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxFileBytes: 64 * 1024 * 1024,
  maxFiles: 10_000,
  maxSourceFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
});

export const REQUIRED_SHOPIFY_MODULES = [
  {
    handle: "account-home-entry",
    type: "ui_extension",
  },
  {
    handle: "account-home-page",
    type: "ui_extension",
  },
  {
    handle: "marketplace-purchase-control",
    type: "function",
  },
];

function artifactError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mergeArtifactLimits(overrides = {}) {
  const limits = { ...DEFAULT_ARTIFACT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw artifactError(
        "INVALID_ARTIFACT_LIMIT",
        `Artifact limit ${name} must be a positive safe integer.`,
      );
    }
  }
  return limits;
}

function walkFiles(directory, { limits, rootDirectory, state }) {
  if (!fs.existsSync(directory)) return [];

  const files = [];
  const queue = [{ depth: 0, directory }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth > limits.maxDepth) {
      throw artifactError(
        "ARTIFACT_DEPTH_LIMIT_EXCEEDED",
        `Artifact directory depth exceeded ${limits.maxDepth}.`,
      );
    }

    for (const entry of fs.readdirSync(current.directory, {
      withFileTypes: true,
    })) {
      const absolutePath = path.join(current.directory, entry.name);
      const relativePath = path
        .relative(rootDirectory, absolutePath)
        .replaceAll("\\", "/");
      if (
        relativePath.startsWith("../") ||
        path.isAbsolute(relativePath) ||
        relativePath.split("/").includes("..")
      ) {
        throw artifactError(
          "ARTIFACT_PATH_OUTSIDE_ROOT",
          `Artifact escaped the repository root: ${relativePath}`,
        );
      }
      if (entry.isSymbolicLink()) {
        throw artifactError(
          "ARTIFACT_SYMLINK_REJECTED",
          `Symbolic links are not permitted in audited trees: ${relativePath}`,
        );
      }
      if (entry.isDirectory()) {
        queue.push({
          depth: current.depth + 1,
          directory: absolutePath,
        });
      } else if (entry.isFile()) {
        state.fileCount += 1;
        if (state.fileCount > limits.maxFiles) {
          throw artifactError(
            "ARTIFACT_FILE_LIMIT_EXCEEDED",
            `Artifact file count exceeded ${limits.maxFiles}.`,
          );
        }
        files.push(absolutePath);
      }
    }
  }
  return files.sort();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function isSafeRelativePath(value) {
  const normalized = String(value || "")
    .replaceAll("\\", "/")
    .trim();
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.split("/").includes("..")
  );
}

function normalizedText(buffer) {
  return buffer.toString("latin1").replaceAll("\\", "/").toLowerCase();
}

function stripJavaScriptComments(text) {
  let output = "";
  let index = 0;
  let state = "code";
  let quote = null;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (state === "line-comment") {
      if (char === "\n") {
        state = "code";
        output += char;
      } else {
        output += " ";
      }
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 2;
        state = "code";
      } else {
        output += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (state === "string") {
      output += char;
      if (char === "\\") {
        output += next || "";
        index += 2;
        continue;
      }
      if (char === quote) {
        state = "code";
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      output += "  ";
      index += 2;
      state = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      state = "block-comment";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      state = "string";
      quote = char;
    }
    output += char;
    index += 1;
  }

  return output;
}

function targetMarkers(target) {
  const normalized = target.toLowerCase();
  return [
    `/node_modules/${normalized}/`,
    `node_modules/${normalized}/`,
    `"${normalized}"`,
    `'${normalized}'`,
  ];
}

function targetFromSpecifier(specifier, targets) {
  return targets.find(
    (target) =>
      specifier === target ||
      specifier.startsWith(`${target}/`) ||
      specifier.includes(`/node_modules/${target}/`),
  );
}

function extractExternalImports(text, targets) {
  const matches = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      const target = targetFromSpecifier(specifier, targets);
      if (target) {
        matches.push({
          specifier,
          target,
        });
      }
    }
  }

  const staticCallPattern =
    /(?:\bimport|\brequire|\.\s*require)\s*\(\s*((?:["'`][^"'`\\]*["'`]\s*(?:\+\s*)?)+)\s*\)/g;
  for (const match of text.matchAll(staticCallPattern)) {
    const expression = match[1];
    const pieces = [...expression.matchAll(/(["'`])([^"'`\\]*)\1/g)].map(
      (piece) => piece[2],
    );
    const remainder = expression.replace(/(["'`])([^"'`\\]*)\1/g, "");
    if (pieces.length === 0 || !/^(?:\s*\+\s*)*$/.test(remainder)) continue;
    const specifier = pieces.join("");
    const target = targetFromSpecifier(specifier, targets);
    if (target) {
      matches.push({
        specifier,
        target,
      });
    }
  }

  return matches;
}

function packageDependencyMatches(packageJson, targets) {
  const matches = [];
  for (const property of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [dependencyName, requested] of Object.entries(
      packageJson?.[property] || {},
    )) {
      const directTarget = targetFromSpecifier(dependencyName, targets);
      const aliasTarget = targets.find((target) =>
        new RegExp(`^npm:${target.replace("/", "\\/")}@`, "i").test(
          String(requested),
        ),
      );
      const target = directTarget || aliasTarget;
      if (target) {
        matches.push({
          evidence: `package-dependency:${property}:${dependencyName}`,
          target,
        });
      }
    }
  }
  return matches;
}

function inspectWasm(buffer, relativePath, targets) {
  let module;
  try {
    module = new WebAssembly.Module(buffer);
  } catch {
    return {
      error: `${relativePath}:invalid_wasm`,
      matches: [],
    };
  }

  const matches = [];
  for (const imported of WebAssembly.Module.imports(module)) {
    const target = targetFromSpecifier(imported.module, targets);
    if (target) {
      matches.push({
        artifact: relativePath,
        evidence: `wasm-import:${imported.module}:${imported.name}`,
        target,
      });
    }
  }

  return {
    error: null,
    exports: WebAssembly.Module.exports(module).length,
    imports: WebAssembly.Module.imports(module).length,
    matches,
  };
}

function readBoundedFile(
  absolutePath,
  relativePath,
  { invalidArtifacts, limits, state, source = false },
) {
  const stats = fs.lstatSync(absolutePath);
  if (stats.isSymbolicLink()) {
    invalidArtifacts.push(`${relativePath}:symlink_rejected`);
    return null;
  }
  if (!stats.isFile()) {
    invalidArtifacts.push(`${relativePath}:not_a_file`);
    return null;
  }
  if (stats.size === 0) {
    invalidArtifacts.push(`${relativePath}:empty_file`);
    return null;
  }

  const maximum = source ? limits.maxSourceFileBytes : limits.maxFileBytes;
  if (stats.size > maximum) {
    invalidArtifacts.push(`${relativePath}:file_size_limit_exceeded`);
    return null;
  }
  state.totalBytes += stats.size;
  if (state.totalBytes > limits.maxTotalBytes) {
    throw artifactError(
      "ARTIFACT_TOTAL_SIZE_LIMIT_EXCEEDED",
      `Artifact bytes exceeded ${limits.maxTotalBytes}.`,
    );
  }
  return fs.readFileSync(absolutePath);
}

function addShopifyDeployBundleArtifacts({
  invalidArtifacts,
  limits,
  missingArtifacts,
  relativeFiles,
  requireShopifyDeployBundle,
  requiredShopifyModules,
  rootDirectory,
  state,
}) {
  const bundleDirectory = path.join(rootDirectory, ".shopify", "deploy-bundle");
  const manifestRelativePath = ".shopify/deploy-bundle/manifest.json";
  const manifestPath = path.join(rootDirectory, manifestRelativePath);

  if (!fs.existsSync(manifestPath)) {
    if (requireShopifyDeployBundle) {
      missingArtifacts.push(manifestRelativePath);
    }
    return;
  }

  let bundleFiles = [];
  try {
    bundleFiles = walkFiles(bundleDirectory, {
      limits,
      rootDirectory,
      state,
    });
  } catch (error) {
    invalidArtifacts.push(
      `${manifestRelativePath}:${error.code || "walk_failed"}`,
    );
    return;
  }
  relativeFiles.push(
    ...bundleFiles.map((filePath) =>
      path.relative(rootDirectory, filePath).replaceAll("\\", "/"),
    ),
  );

  let manifest;
  const manifestBuffer = readBoundedFile(manifestPath, manifestRelativePath, {
    invalidArtifacts,
    limits,
    state,
  });
  if (!manifestBuffer) return;
  try {
    manifest = JSON.parse(manifestBuffer.toString("utf8"));
  } catch {
    invalidArtifacts.push(`${manifestRelativePath}:invalid_json`);
    return;
  }

  if (!Array.isArray(manifest.modules)) {
    invalidArtifacts.push(`${manifestRelativePath}:missing_modules`);
    return;
  }

  for (const expected of requiredShopifyModules) {
    const module = manifest.modules.find(
      (candidate) =>
        candidate?.handle === expected.handle &&
        candidate?.type === expected.type,
    );
    if (!module) {
      invalidArtifacts.push(
        `${manifestRelativePath}:missing_module:${expected.handle}`,
      );
      continue;
    }

    const assetRoot = String(module.assets || "").trim();
    if (!isSafeRelativePath(assetRoot)) {
      invalidArtifacts.push(
        `${manifestRelativePath}:missing_assets:${expected.handle}`,
      );
      continue;
    }

    if (expected.type === "function") {
      const functionArtifact = path.posix.join(
        ".shopify/deploy-bundle",
        assetRoot,
        "dist/index.wasm",
      );
      if (!fs.existsSync(path.join(rootDirectory, functionArtifact))) {
        missingArtifacts.push(functionArtifact);
      }
      continue;
    }

    const extensionPoints = module.config?.extension_points;
    const mainFile = Array.isArray(extensionPoints)
      ? extensionPoints[0]?.build_manifest?.assets?.main?.filepath
      : null;
    if (!isSafeRelativePath(mainFile)) {
      invalidArtifacts.push(
        `${manifestRelativePath}:missing_main_asset:${expected.handle}`,
      );
      continue;
    }

    const uiArtifact = path.posix.join(
      ".shopify/deploy-bundle",
      assetRoot,
      mainFile,
    );
    if (!fs.existsSync(path.join(rootDirectory, uiArtifact))) {
      missingArtifacts.push(uiArtifact);
    }
  }
}

export function verifyBuildArtifacts({
  limits: limitOverrides,
  packageFiles = SECURITY_PACKAGE_FILES,
  requiredArtifacts = REQUIRED_SECURITY_ARTIFACTS,
  requireShopifyDeployBundle = false,
  requiredShopifyModules = REQUIRED_SHOPIFY_MODULES,
  rootDirectory,
  sourceDirectories = SECURITY_SOURCE_DIRECTORIES,
  targets = TOOLCHAIN_TARGETS,
}) {
  const limits = mergeArtifactLimits(limitOverrides);
  const state = {
    fileCount: 0,
    totalBytes: 0,
  };
  const missingArtifacts = [];
  const invalidArtifacts = [];
  const targetMatches = [];
  const artifacts = [];

  const relativeFiles = [...requiredArtifacts];
  const serverDirectory = path.join(rootDirectory, "build", "server");
  let serverTreeFiles = [];
  try {
    serverTreeFiles = walkFiles(serverDirectory, {
      limits,
      rootDirectory,
      state,
    });
  } catch (error) {
    invalidArtifacts.push(`build/server:${error.code || "walk_failed"}`);
  }
  const serverFiles = serverTreeFiles
    .filter((filePath) => /\.(?:cjs|js|mjs)$/i.test(filePath))
    .map((filePath) =>
      path.relative(rootDirectory, filePath).replaceAll("\\", "/"),
    );

  if (serverFiles.length === 0) {
    missingArtifacts.push("build/server/**/*.js");
  }
  if (!serverFiles.some((file) => file.startsWith("build/server/assets/"))) {
    missingArtifacts.push("build/server/assets/**/*.js");
  }
  relativeFiles.push(...serverFiles);

  const clientDirectory = path.join(rootDirectory, "build", "client");
  let clientTreeFiles = [];
  try {
    clientTreeFiles = walkFiles(clientDirectory, {
      limits,
      rootDirectory,
      state,
    });
  } catch (error) {
    invalidArtifacts.push(`build/client:${error.code || "walk_failed"}`);
  }
  const clientFiles = clientTreeFiles
    .filter((filePath) => /\.(?:css|js|mjs)$/i.test(filePath))
    .map((filePath) =>
      path.relative(rootDirectory, filePath).replaceAll("\\", "/"),
    );
  if (clientFiles.length === 0) {
    missingArtifacts.push("build/client/**/*.{css,js}");
  }
  relativeFiles.push(...clientFiles);

  addShopifyDeployBundleArtifacts({
    invalidArtifacts,
    limits,
    missingArtifacts,
    relativeFiles,
    requireShopifyDeployBundle,
    requiredShopifyModules,
    rootDirectory,
    state,
  });

  for (const sourceDirectory of sourceDirectories) {
    const absoluteDirectory = path.join(rootDirectory, sourceDirectory);
    let sourceFiles = [];
    try {
      sourceFiles = walkFiles(absoluteDirectory, {
        limits,
        rootDirectory,
        state,
      });
    } catch (error) {
      invalidArtifacts.push(
        `${sourceDirectory}:${error.code || "walk_failed"}`,
      );
    }
    for (const absolutePath of sourceFiles.filter((filePath) =>
      /\.(?:cjs|js|jsx|mjs|ts|tsx)$/i.test(filePath),
    )) {
      const relativePath = path
        .relative(rootDirectory, absolutePath)
        .replaceAll("\\", "/");
      const buffer = readBoundedFile(absolutePath, relativePath, {
        invalidArtifacts,
        limits,
        source: true,
        state,
      });
      if (!buffer) continue;
      const text = stripJavaScriptComments(buffer.toString("utf8"));
      const normalizedSource = text.toLowerCase();
      for (const target of targets) {
        if (
          targetMarkers(target).some((marker) =>
            normalizedSource.includes(marker),
          )
        ) {
          targetMatches.push({
            artifact: relativePath,
            evidence: "source-target-string",
            target,
          });
        }
      }
      for (const externalImport of extractExternalImports(text, targets)) {
        targetMatches.push({
          artifact: relativePath,
          evidence: `source-import:${externalImport.specifier}`,
          target: externalImport.target,
        });
      }
    }
  }

  for (const relativePath of packageFiles) {
    const absolutePath = path.join(rootDirectory, relativePath);
    if (!fs.existsSync(absolutePath)) {
      missingArtifacts.push(relativePath);
      continue;
    }
    const buffer = readBoundedFile(absolutePath, relativePath, {
      invalidArtifacts,
      limits,
      source: true,
      state,
    });
    if (!buffer) continue;

    let packageJson;
    try {
      packageJson = JSON.parse(buffer.toString("utf8"));
    } catch {
      invalidArtifacts.push(`${relativePath}:invalid_json`);
      continue;
    }
    for (const match of packageDependencyMatches(packageJson, targets)) {
      targetMatches.push({
        artifact: relativePath,
        ...match,
      });
    }
  }

  for (const relativePath of [...new Set(relativeFiles)].sort()) {
    const absolutePath = path.join(rootDirectory, relativePath);
    if (!fs.existsSync(absolutePath)) {
      missingArtifacts.push(relativePath);
      continue;
    }

    if (/\.(?:zip|tar|tgz|gz)$/i.test(relativePath)) {
      invalidArtifacts.push(`${relativePath}:archive_not_supported`);
      continue;
    }
    const buffer = readBoundedFile(absolutePath, relativePath, {
      invalidArtifacts,
      limits,
      state,
    });
    if (!buffer) continue;
    const text = normalizedText(buffer);
    artifacts.push({
      path: relativePath,
      sha256: sha256(buffer),
      size: buffer.length,
    });

    for (const target of targets) {
      if (
        targetMarkers(target).some((marker) => text.includes(marker)) ||
        text.includes(`/${target.toLowerCase()}/package.json`)
      ) {
        targetMatches.push({
          artifact: relativePath,
          evidence: "content",
          target,
        });
      }
    }

    if (/\.(?:cjs|js|mjs)$/i.test(relativePath)) {
      for (const externalImport of extractExternalImports(text, targets)) {
        targetMatches.push({
          artifact: relativePath,
          evidence: `external-import:${externalImport.specifier}`,
          target: externalImport.target,
        });
      }
    }

    if (/\.wasm$/i.test(relativePath)) {
      const wasm = inspectWasm(buffer, relativePath, targets);
      if (wasm.error) {
        invalidArtifacts.push(wasm.error);
      }
      targetMatches.push(...wasm.matches);
    }

    if (relativePath.endsWith(".metafile.json")) {
      let metafile;
      try {
        metafile = JSON.parse(buffer.toString("utf8"));
      } catch {
        invalidArtifacts.push(`${relativePath}:invalid_json`);
        continue;
      }
      if (!metafile.inputs || typeof metafile.inputs !== "object") {
        invalidArtifacts.push(`${relativePath}:missing_inputs`);
        continue;
      }

      for (const input of Object.keys(metafile.inputs)) {
        const normalizedInput = input.replaceAll("\\", "/").toLowerCase();
        for (const target of targets) {
          const packagePath = `node_modules/${target.toLowerCase()}/`;
          if (
            normalizedInput.startsWith(packagePath) ||
            normalizedInput.includes(`/${packagePath}`)
          ) {
            targetMatches.push({
              artifact: relativePath,
              evidence: `metafile-input:${input}`,
              target,
            });
          }
        }
      }
    }
  }

  const dedupedMatches = [
    ...new Map(
      targetMatches.map((match) => [
        `${match.artifact}:${match.target}:${match.evidence}`,
        match,
      ]),
    ).values(),
  ];
  const sortedArtifacts = artifacts.sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const artifactSetSha256 = sha256(
    Buffer.from(
      sortedArtifacts
        .map(
          (artifact) => `${artifact.path}:${artifact.size}:${artifact.sha256}`,
        )
        .join("\n"),
      "utf8",
    ),
  );
  const artifactClasses = [
    {
      actualCount: sortedArtifacts.filter(
        (artifact) => artifact.path === "build/server/index.js",
      ).length,
      binary: false,
      expectedMinimumCount: 1,
      id: "remix-server-entry",
      missingCode: "build/server/index.js",
      scanner: "bounded-text-and-import-scan",
    },
    {
      actualCount: sortedArtifacts.filter((artifact) =>
        artifact.path.startsWith("build/server/assets/"),
      ).length,
      binary: false,
      expectedMinimumCount: 1,
      id: "remix-server-chunks",
      missingCode: "build/server/assets/**/*.js",
      scanner: "bounded-text-and-import-scan",
    },
    {
      actualCount: sortedArtifacts.filter((artifact) =>
        /^build\/client\/assets\/entry\.client-[^/]+\.js$/i.test(
          artifact.path,
        ),
      ).length,
      binary: false,
      expectedMinimumCount: 1,
      id: "remix-client-entry",
      missingCode: "build/client/assets/entry.client-*.js",
      scanner: "bounded-text-and-import-scan",
    },
    {
      actualCount: sortedArtifacts.filter((artifact) =>
        /^build\/client\/assets\/manifest-[^/]+\.js$/i.test(artifact.path),
      ).length,
      binary: false,
      expectedMinimumCount: 1,
      id: "remix-client-runtime-manifest",
      missingCode: "build/client/assets/manifest-*.js",
      scanner: "bounded-text-and-import-scan",
    },
    {
      actualCount: sortedArtifacts.filter(
        (artifact) =>
          /^build\/client\/assets\/.+\.js$/i.test(artifact.path) &&
          !/^build\/client\/assets\/(?:entry\.client|manifest)-/i.test(
            artifact.path,
          ),
      ).length,
      binary: false,
      expectedMinimumCount: 1,
      id: "remix-client-route-bundles",
      missingCode: "build/client/assets/*.js",
      scanner: "bounded-text-and-import-scan",
    },
    {
      actualCount: sortedArtifacts.filter((artifact) =>
        /^build\/client\/assets\/.+\.css$/i.test(artifact.path),
      ).length,
      binary: false,
      expectedMinimumCount: 1,
      id: "remix-client-styles",
      missingCode: "build/client/assets/*.css",
      scanner: "bounded-text-scan",
    },
    {
      actualCount: sortedArtifacts.filter((artifact) =>
        artifact.path.endsWith("/dist/function.js"),
      ).length,
      binary: false,
      expectedMinimumCount: 1,
      id: "shopify-function-javascript",
      missingCode: "extensions/marketplace-purchase-control/dist/function.js",
      scanner: "bounded-text-and-import-scan",
    },
    {
      actualCount: sortedArtifacts.filter((artifact) =>
        artifact.path.endsWith(".wasm"),
      ).length,
      binary: true,
      expectedMinimumCount:
        requiredArtifacts.filter((artifact) => artifact.endsWith(".wasm"))
          .length +
        (requireShopifyDeployBundle
          ? requiredShopifyModules.filter(
              (module) => module.type === "function",
            ).length
          : 0),
      id: "shopify-function-wasm",
      missingCode: "extensions/marketplace-purchase-control/dist/function.wasm",
      scanner: "webassembly-module-import-export-scan",
    },
    {
      actualCount: sortedArtifacts.filter(
        (artifact) =>
          /\/account-home-entry\/dist\/[^/]+\.js$/i.test(artifact.path) &&
          !artifact.path.endsWith(".js.map"),
      ).length,
      binary: false,
      expectedMinimumCount: requiredArtifacts.filter(
        (artifact) =>
          /\/account-home-entry\/dist\/[^/]+\.js$/i.test(artifact) &&
          !artifact.endsWith(".js.map"),
      ).length,
      id: "ui-extension-entry-bundles",
      missingCode: "extensions/account-home-entry/dist/*.js",
      scanner: "bounded-text-and-import-scan",
    },
    {
      actualCount: sortedArtifacts.filter(
        (artifact) =>
          /\/account-home-page\/dist\/[^/]+\.js$/i.test(artifact.path) &&
          !artifact.path.endsWith(".js.map"),
      ).length,
      binary: false,
      expectedMinimumCount: requiredArtifacts.filter(
        (artifact) =>
          /\/account-home-page\/dist\/[^/]+\.js$/i.test(artifact) &&
          !artifact.endsWith(".js.map"),
      ).length,
      id: "ui-extension-page-bundles",
      missingCode: "extensions/account-home-page/dist/*.js",
      scanner: "bounded-text-and-import-scan",
    },
    {
      actualCount: sortedArtifacts.filter((artifact) =>
        artifact.path.endsWith(".metafile.json"),
      ).length,
      binary: false,
      expectedMinimumCount: requiredArtifacts.filter((artifact) =>
        artifact.endsWith(".metafile.json"),
      ).length,
      id: "ui-extension-metafiles",
      missingCode: "extensions/*/dist/*.metafile.json",
      scanner: "bounded-json-metafile-input-scan",
    },
    {
      actualCount: sortedArtifacts.filter((artifact) =>
        artifact.path.endsWith(".map"),
      ).length,
      binary: false,
      expectedMinimumCount: requiredArtifacts.filter((artifact) =>
        artifact.endsWith(".map"),
      ).length,
      id: "source-maps",
      missingCode: "extensions/*/dist/*.map",
      scanner: "bounded-text-scan",
    },
    {
      actualCount: sortedArtifacts.filter((artifact) =>
        artifact.path.startsWith(".shopify/deploy-bundle/"),
      ).length,
      binary: false,
      expectedMinimumCount: requireShopifyDeployBundle
        ? requiredShopifyModules.length + 1
        : 0,
      id: "shopify-deploy-bundle",
      missingCode: ".shopify/deploy-bundle/manifest.json",
      scanner: requireShopifyDeployBundle
        ? "required-bounded-tree-and-manifest-scan"
        : "optional-bounded-tree-and-manifest-scan",
    },
  ];
  for (const artifactClass of artifactClasses) {
    if (artifactClass.actualCount < artifactClass.expectedMinimumCount) {
      invalidArtifacts.push(
        `artifact_class_missing:${artifactClass.id}:${artifactClass.missingCode}`,
      );
    }
  }

  return {
    artifactClasses,
    artifacts: sortedArtifacts,
    artifactSetSha256,
    invalidArtifacts: [...new Set(invalidArtifacts)].sort(),
    missingArtifacts: [...new Set(missingArtifacts)].sort(),
    ok:
      missingArtifacts.length === 0 &&
      invalidArtifacts.length === 0 &&
      dedupedMatches.length === 0,
    scannedBytes: state.totalBytes,
    scannedFileCount: state.fileCount,
    targetMatches: dedupedMatches,
  };
}
