import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { downloadJavyInput } from "./test-javy-native.mjs";
import { PRISMA_RUNTIME_BASE } from "./prisma-runtime-compatibility.mjs";
import { assertNodeRuntime, evaluateNodeRuntime } from "./node-runtime.mjs";
import {
  checkedNativeDirectory,
  verifyRebuiltEsbuild,
} from "./rebuild-esbuild.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
export const OPTIMIZER_FLAGS = [
  "-Oz",
  "--enable-bulk-memory",
  "--enable-multimemory",
  "--enable-nontrapping-float-to-int",
  "--strip-debug",
];

export function postprocessOptions(
  args,
  env = process.env,
  platform = process.platform,
) {
  if (
    args.length ||
    platform !== "linux" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true"
  )
    throw new Error("function_postprocess_arguments_invalid");
}

export function validatePostprocessPolicy(p) {
  if (
    !p ||
    p.schemaVersion !== 1 ||
    p.optimizer?.version !== "133" ||
    p.optimizer.commit !== "fba5005a132d85d578be5bd010e0487ed8e2ce3e" ||
    p.optimizer.url !==
      "https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-node.tar.gz" ||
    p.optimizer.archiveSize !== 2300450 ||
    p.optimizer.archiveSha256 !==
      "3507aedecef25c46f2889530a7da304677e97122869274125f782b586cb508ab" ||
    p.optimizer.jsSha256 !==
      "31b57f29cc4fb1ffe06b027a5ba125dcc6717b85b0951b81830884a153bfe7ba" ||
    p.optimizer.wasmSha256 !==
      "0328adf330dc852245f8c7af1e05a410554b379ea848abd4f4c993e4b409587c" ||
    JSON.stringify(p.optimizer.includedFixes) !==
      '["4f52bff8c4075b5630422f902dd92a0af2c9f398","1251efbc1ea471c1311d2726b2bbe061ff2a291c"]' ||
    p.native?.run !== 42203451075 ||
    p.native.artifact !== 13497266437 ||
    p.native.head !== "e7781b4aeab5a934cebbdc020b8e18195ed35121" ||
    p.native.binarySha256 !==
      "f75a0ad1ad323a2e41215bf9f409abf50850303e8b0642a697567f0799e59911" ||
    p.native.receiptSha256 !==
      "869f276cffdfdc6c3426a0a4041163d822d975f97b75566302d4b7804da0fa90" ||
    p.sdkSha256 !==
      "6f9e114f199ed6075101f31b3ab47531d749910238b4f06b7386efca94168dab" ||
    JSON.stringify(
      p.candidates?.map((c) => [c.name, c.head, c.bundleSha256]),
    ) !==
      JSON.stringify([
        [
          "security",
          "e7781b4aeab5a934cebbdc020b8e18195ed35121",
          "5498f38a5d214242aaeb0a29d53fbac462d33144dedde0e9a0fed41cb2f552a9",
        ],
        [
          "international",
          "7731ab6e863580f6ed7ba6118a04a5234e8769df",
          "ced881b321772e1d8e446fd9ace702f44fd6c35c75092570f339faa6492d2195",
        ],
      ]) ||
    p.artifactStatus !== "NOT_VERIFIED" ||
    [
      p.wholeCompilerVerified,
      p.fullFunctionVerified,
      p.productionApproved,
    ].some((v) => v !== false)
  )
    throw new Error("function_postprocess_policy_invalid");
  return p;
}

export function optimizerCreateArguments(s) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(s.image) ||
    !/^[a-f0-9]{24}$/.test(s.nonce) ||
    ![s.uid, s.gid].every(
      (n) => Number.isInteger(n) && n > 0 && n < 2147483647,
    ) ||
    ![s.inputs, s.work, ...(s.modules === undefined ? [] : [s.modules])].every(
      (p) =>
        typeof p === "string" &&
        p.startsWith("/") &&
        p.length > 1 &&
        !/[\r\n,]/.test(p) &&
        !p.split("/").includes(".."),
    )
  )
    throw new Error("function_postprocess_container_invalid");
  return [
    "create",
    "--name",
    `oja-function-opt-${s.nonce}`,
    "--label",
    `oja.function-opt=${s.nonce}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--user",
    `${s.uid}:${s.gid}`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--env",
    "HOME=/work",
    "--mount",
    `type=bind,source=${s.inputs},target=/inputs,readonly`,
    "--mount",
    `type=bind,source=${s.work},target=/work`,
    ...(s.modules === undefined
      ? []
      : [
          "--mount",
          `type=bind,source=${s.modules},target=/inputs/node_modules,readonly`,
        ]),
    "--workdir",
    "/work",
    "--entrypoint",
    "/usr/local/bin/node",
    s.image,
    "/inputs/probe.mjs",
  ];
}

export function verifyOptimizerContainer(inspect, s, completed = true) {
  const a = inspect?.[0],
    h = a?.HostConfig;
  const mounts = [
    ["inputs", "/inputs", false],
    ["work", "/work", true],
    ...(s.modules === undefined
      ? []
      : [["modules", "/inputs/node_modules", false]]),
  ];
  if (
    inspect?.length !== 1 ||
    a.Id !== s.container ||
    a.Image !== s.image ||
    a.Name !== `/oja-function-opt-${s.nonce}` ||
    a.Config?.Labels?.["oja.function-opt"] !== s.nonce ||
    a.Config.User !== `${s.uid}:${s.gid}` ||
    h?.NetworkMode !== "none" ||
    h.ReadonlyRootfs !== true ||
    h.Privileged !== false ||
    JSON.stringify(h.CapDrop) !== '["ALL"]' ||
    !h.SecurityOpt?.includes("no-new-privileges") ||
    h.PidsLimit !== 128 ||
    h.Memory !== 1073741824 ||
    h.NanoCpus !== 2000000000 ||
    JSON.stringify(h.Tmpfs) !== '{"/tmp":"rw,noexec,nosuid,nodev,size=64m"}' ||
    JSON.stringify(a.Config.Entrypoint) !== '["/usr/local/bin/node"]' ||
    JSON.stringify(a.Config.Cmd) !== '["/inputs/probe.mjs"]' ||
    a.Config.WorkingDir !== "/work" ||
    a.Config.Env?.some(
      (e) => !/^(HOME|PATH|NODE_VERSION|YARN_VERSION)=/.test(e),
    ) ||
    a.Mounts?.length !== mounts.length ||
    !mounts.every(
      ([key, dest, rw]) =>
        a.Mounts.filter(
          (m) =>
            m.Type === "bind" &&
            m.Source === s[key] &&
            m.Destination === dest &&
            m.RW === rw,
        ).length === 1,
    ) ||
    (completed &&
      (a.State?.ExitCode !== 0 ||
        a.State.OOMKilled !== false ||
        a.State.Running !== false))
  )
    throw new Error("function_postprocess_isolation_invalid");
  return a;
}

export function observeFunctionWasm(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 8 ||
    bytes.length > 262144 ||
    !WebAssembly.validate(bytes)
  )
    throw new Error("function_postprocess_wasm_invalid");
  const m = new WebAssembly.Module(bytes),
    imports = WebAssembly.Module.imports(m),
    exports = WebAssembly.Module.exports(m);
  if (
    imports.length !== 3 ||
    !imports.every((i) => i.module === "shopify_functions_javy_v4") ||
    JSON.stringify(imports.map((i) => [i.name, i.kind]).sort()) !==
      JSON.stringify([
        ["cabi_realloc", "function"],
        ["invoke", "function"],
        ["memory", "memory"],
      ]) ||
    JSON.stringify(exports.map((e) => [e.name, e.kind]).sort()) !==
      JSON.stringify([
        ["_start", "function"],
        ["cart-validations-generate-run", "function"],
      ])
  )
    throw new Error("function_postprocess_interface_invalid");
  return {
    sha256: sha(bytes),
    size: bytes.length,
    imports,
    exports,
    requiresCliTrampoline: false,
  };
}

export async function downloadOptimizer(policy, file, request = fetch) {
  const p = validatePostprocessPolicy(policy).optimizer;
  if (fs.existsSync(file))
    throw new Error("function_optimizer_download_exists");
  let url = p.url,
    response;
  for (let i = 0; i < 4; i++) {
    response = await request(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(180000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = new URL(response.headers.get("location"), url);
    if (
      next.protocol !== "https:" ||
      next.username ||
      next.password ||
      next.port ||
      !["github.com", "release-assets.githubusercontent.com"].includes(
        next.hostname,
      )
    )
      throw new Error("function_optimizer_redirect_invalid");
    await response.body?.cancel();
    url = next.href;
  }
  if (!response.ok) throw new Error("function_optimizer_download_failed");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > p.archiveSize)
      throw new Error("function_optimizer_download_limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== p.archiveSize || sha(bytes) !== p.archiveSha256)
    throw new Error("function_optimizer_download_digest_mismatch");
  fs.writeFileSync(file, bytes, { flag: "wx" });
}

function regular(file, limit = 100_000_000) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > limit)
    throw new Error("function_postprocess_file_invalid");
  return fs.readFileSync(file);
}

export async function postprocessFunctions(root = ROOT) {
  postprocessOptions([]);
  assertNodeRuntime();
  const policyBytes = regular(
    path.join(root, "security/function-postprocess.json"),
  );
  const p = validatePostprocessPolicy(JSON.parse(policyBytes));
  const base = checkedNativeDirectory(root, ".audit/function-postprocess");
  const home = fs.mkdtempSync(path.join(base, "run-"));
  const inputs = path.join(home, "inputs"),
    work = path.join(home, "work");
  fs.mkdirSync(inputs);
  fs.mkdirSync(work);
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home };
  const commands = [];
  const execute = (name, binary, args, cwd = home, timeout = 60000) => {
    const r = spawnSync(binary, args, {
      cwd,
      env,
      timeout,
      shell: false,
      encoding: null,
      maxBuffer: 16_000_000,
    });
    fs.writeFileSync(path.join(home, `${name}.stdout.log`), r.stdout || "");
    fs.writeFileSync(path.join(home, `${name}.stderr.log`), r.stderr || "");
    const c = {
      name,
      command: binary,
      args,
      cwd,
      status: r.status,
      signal: r.signal,
      error: r.error?.code || null,
    };
    commands.push(c);
    fs.writeFileSync(
      path.join(home, `${name}.command.json`),
      JSON.stringify(c, null, 2) + "\n",
    );
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(c.error, null, name);
    return r.stdout;
  };
  const blob = (head, file, repository = root) =>
    execute(
      `blob-${commands.length}`,
      "git",
      ["-C", repository, "show", `${head}:${file}`],
      root,
    );
  const nativeRoot = path.join(root, ".audit/function-native-input");
  const nativeRuns = fs.readdirSync(path.join(nativeRoot, "native-javy"));
  assert.equal(nativeRuns.length, 1);
  const nativeReceipt = regular(
    path.join(nativeRoot, "native-javy", nativeRuns[0], "native-receipt.json"),
  );
  assert.equal(sha(nativeReceipt), p.native.receiptSha256);
  const compilerBytes = regular(
    path.join(nativeRoot, "javy-native-result/javy"),
  );
  assert.equal(sha(compilerBytes), p.native.binarySha256);
  const compiler = path.join(home, "javy");
  fs.writeFileSync(compiler, compilerBytes, { mode: 0o755, flag: "wx" });
  const sourcePolicy = regular(
    path.join(root, "security/javy-source-contracts.json"),
  );
  assert.equal(sha(sourcePolicy), JSON.parse(nativeReceipt).policySha256);
  const nativePolicy = JSON.parse(
    regular(path.join(root, "security/javy-native-contracts.json")),
  );
  const provider = path.join(home, "provider.wasm");
  await downloadJavyInput(
    nativePolicy.shopifyProvider.url,
    provider,
    nativePolicy.shopifyProvider.sha256,
    nativePolicy.shopifyProvider.size,
  );
  const archive = path.join(home, "binaryen.tar.gz");
  await downloadOptimizer(p, archive);
  assert.deepEqual(
    execute("optimizer-list", "tar", ["-tf", archive])
      .toString()
      .trim()
      .split(/\r?\n/),
    [
      "binaryen-version_133/",
      "binaryen-version_133/wasm-opt.js",
      "binaryen-version_133/wasm-opt.wasm",
    ],
  );
  for (const [name, destination, expected] of [
    ["wasm-opt.js", "wasm-opt.cjs", p.optimizer.jsSha256],
    ["wasm-opt.wasm", "wasm-opt.wasm", p.optimizer.wasmSha256],
  ]) {
    const bytes = execute(`extract-${name}`, "tar", [
      "-xOf",
      archive,
      `binaryen-version_133/${name}`,
    ]);
    assert.equal(sha(bytes), expected);
    fs.writeFileSync(path.join(inputs, destination), bytes, { flag: "wx" });
  }
  const esbuild = verifyRebuiltEsbuild(root);
  const esbuildEvidence = path.join(home, "esbuild-evidence");
  fs.mkdirSync(esbuildEvidence);
  for (const suffix of [
    "",
    ".receipt.json",
    ".buildinfo.json",
    ".cdx.json",
    ".sarif",
  ]) {
    const name = `esbuild-linux-x64${suffix}`;
    const b = regular(path.join(root, ".audit/native-esbuild", name));
    fs.writeFileSync(path.join(esbuildEvidence, name), b, { flag: "wx" });
  }
  const esbuildPath = path.join(
    root,
    "node_modules/@esbuild/linux-x64/bin/esbuild",
  );
  const sdk = path.join(root, "node_modules/@shopify/shopify_function/run.ts");
  assert.equal(sha(regular(sdk)), p.sdkSha256);
  const extension = "extensions/marketplace-purchase-control/";
  const candidates = [];
  for (const c of p.candidates) {
    const repository =
      c.name === "international"
        ? path.join(root, ".audit/function-international-source")
        : root;
    if (c.name === "international")
      assert.equal(
        execute("international-head", "git", [
          "-C",
          repository,
          "rev-parse",
          "HEAD",
        ])
          .toString()
          .trim(),
        c.head,
      );
    // Preserve the SDK comment's relative path used by the independently bound bundles.
    const snapshot = fs.mkdtempSync(
      path.join(root, `.audit/function-source-${c.name}-`),
    );
    const files = [
      "src/index.js",
      "src/cart_validations_generate_run.js",
      "src/cart_validations_generate_run.graphql",
      "schema.graphql",
      "shopify.extension.toml",
      "tests/default.test.js",
    ];
    if (c.name === "international")
      files.push("src/international_validation.js");
    const bindings = [];
    for (const file of files) {
      const b = blob(c.head, extension + file, repository);
      fs.mkdirSync(path.dirname(path.join(snapshot, file)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(snapshot, file), b, { flag: "wx" });
      bindings.push({ path: extension + file, sha256: sha(b) });
    }
    fs.writeFileSync(
      path.join(snapshot, "entry.js"),
      'import __runFunction from "@shopify/shopify_function/run";\nimport { cartValidationsGenerateRun as runCartValidationsGenerateRun } from "user-function";\nexport function cartValidationsGenerateRun() { return __runFunction(runCartValidationsGenerateRun); }\n',
    );
    const wit = path.join(snapshot, "function.wit");
    fs.writeFileSync(
      wit,
      "package function:impl;\n\nworld shopify-function {\n  export %cart-validations-generate-run: func();\n}\n",
    );
    const bundle = path.join(snapshot, "function.js");
    execute(
      `bundle-${c.name}`,
      esbuildPath,
      [
        path.join(snapshot, "entry.js"),
        "--bundle",
        "--format=esm",
        "--target=es2022",
        "--legal-comments=none",
        `--alias:user-function=${path.join(snapshot, "src/index.js")}`,
        `--alias:@shopify/shopify_function/run=${sdk}`,
        `--outfile=${bundle}`,
      ],
      snapshot,
    );
    assert.equal(sha(regular(bundle)), c.bundleSha256);
    const output = path.join(inputs, `${c.name}.wasm`);
    execute(`compile-${c.name}`, compiler, [
      "build",
      "-C",
      "dynamic",
      "-C",
      `plugin=${provider}`,
      "-C",
      `wit=${wit}`,
      "-C",
      "wit-world=shopify-function",
      "-o",
      output,
      bundle,
    ]);
    candidates.push({
      ...c,
      bindings,
      raw: observeFunctionWasm(regular(output)),
    });
    fs.cpSync(snapshot, path.join(home, c.name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  const probe = regular(
    path.join(root, "tests/fixtures/functions/postprocess-probe.mjs"),
  );
  fs.writeFileSync(path.join(inputs, "probe.mjs"), probe, { flag: "wx" });
  fs.writeFileSync(
    path.join(inputs, "manifest.json"),
    JSON.stringify({
      optimizer: p.optimizer,
      flags: OPTIMIZER_FLAGS,
      candidates,
      nodePolicy: JSON.parse(
        regular(path.join(root, "security/node-runtime.json")),
      ),
    }),
  );
  execute("image-pull", "docker", ["pull", PRISMA_RUNTIME_BASE], home, 180000);
  const image = JSON.parse(
    execute("image-inspect", "docker", [
      "image",
      "inspect",
      PRISMA_RUNTIME_BASE,
    ]),
  );
  assert.equal(image.length, 1);
  assert.equal(image[0].Os, "linux");
  assert.equal(image[0].Architecture, "amd64");
  assert.ok(
    image[0].RepoDigests?.includes(`node@${PRISMA_RUNTIME_BASE.split("@")[1]}`),
  );
  const settings = {
    image: image[0].Id,
    nonce: crypto.randomBytes(12).toString("hex"),
    uid: process.getuid(),
    gid: process.getgid(),
    inputs,
    work,
  };
  const container = execute(
    "container-create",
    "docker",
    optimizerCreateArguments(settings),
  )
    .toString()
    .trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  let report;
  try {
    const before = JSON.parse(
      execute("container-inspect-before", "docker", ["inspect", container]),
    );
    verifyOptimizerContainer(before, { ...settings, container }, false);
    execute(
      "optimize",
      "docker",
      ["start", "--attach", container],
      home,
      240000,
    );
    const after = JSON.parse(
      execute("container-inspect-after", "docker", ["inspect", container]),
    );
    verifyOptimizerContainer(after, { ...settings, container });
    report = JSON.parse(regular(path.join(work, "report.json")));
    assert.equal(report.success, true);
    assert.equal(report.uid, settings.uid);
    assert.equal(report.hostname, container.slice(0, 12));
    assert.equal(report.readonlyInputWriteDenied, true);
    assert.equal(report.readonlyRootWriteDenied, true);
    assert.match(report.version, /^wasm-opt version 133\b/);
    for (const flag of [
      "wholeCompilerVerified",
      "fullFunctionVerified",
      "productionApproved",
    ])
      assert.equal(report[flag], false);
    assert.deepEqual(
      report.commands.map((c) => c.name),
      [
        "version",
        "empty-valid",
        "invalid",
        "optimize-security",
        "truncated-security",
        "optimize-international",
        "truncated-international",
      ],
    );
    for (const command of report.commands) {
      assert.equal(command.error, null);
      assert.equal(command.signal, null);
      assert.equal(
        command.status,
        /^(invalid|truncated-)/.test(command.name) ? 1 : 0,
      );
    }
    assert.equal(
      evaluateNodeRuntime(
        report.node,
        JSON.parse(regular(path.join(root, "security/node-runtime.json"))),
      ).ok,
      true,
    );
    assert.equal(
      report.nodeSha256,
      "e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb",
    );
    assert.equal(report.candidates.length, 2);
    for (const c of candidates) {
      const actual = report.candidates.find((x) => x.name === c.name);
      assert.ok(actual);
      assert.deepEqual(actual.raw, c.raw);
      const final = observeFunctionWasm(
        regular(path.join(work, `${c.name}.wasm`)),
      );
      assert.deepEqual(actual.optimized, final);
      assert.deepEqual(
        observeFunctionWasm(regular(path.join(inputs, `${c.name}.wasm`))),
        c.raw,
      );
    }
  } finally {
    execute("container-remove", "docker", ["rm", "--force", container]);
  }
  assert.equal(sha(regular(compiler)), p.native.binarySha256);
  assert.equal(sha(regular(provider)), nativePolicy.shopifyProvider.sha256);
  assert.equal(sha(regular(esbuildPath)), esbuild.binarySha256);
  assert.equal(
    sha(regular(path.join(inputs, "wasm-opt.cjs"))),
    p.optimizer.jsSha256,
  );
  assert.equal(
    sha(regular(path.join(inputs, "wasm-opt.wasm"))),
    p.optimizer.wasmSha256,
  );
  const receipt = {
    observedAt: new Date().toISOString(),
    policy: p,
    policySha256: sha(policyBytes),
    nativeReceiptSha256: sha(nativeReceipt),
    esbuild,
    probeSha256: sha(probe),
    orchestratorSha256: sha(regular(new URL(import.meta.url))),
    workflowSha256: sha(
      regular(path.join(root, ".github/workflows/function-postprocess.yml")),
    ),
    candidates,
    image: settings.image,
    baseImage: PRISMA_RUNTIME_BASE,
    container,
    report,
    artifactStatus: "NOT_VERIFIED",
    wholeCompilerVerified: false,
    fullFunctionVerified: false,
    productionApproved: false,
    scope:
      "isolated patched optimizer and byte interfaces only; no final Function execution, provider-source or whole compiler approval",
  };
  fs.writeFileSync(
    path.join(home, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return {
    ok: true,
    home,
    candidates: report.candidates.map((c) => ({
      name: c.name,
      optimized: c.optimized,
    })),
    productionApproved: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    postprocessOptions(process.argv.slice(2));
    console.log(JSON.stringify(await postprocessFunctions()));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}
