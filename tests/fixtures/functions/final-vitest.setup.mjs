import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { vi } from "vitest";
import { validateFinalRunnerResult } from "./final-contracts.mjs";

Object.defineProperty(globalThis, "__INTERNATIONAL_PROOF_PREBUILT__", {
  value: true,
  writable: false,
});
vi.mock("@shopify/shopify-function-test-helpers", async (importOriginal) => {
  const actual = await importOriginal();
  const manifest = JSON.parse(
    fs.readFileSync(process.env.OJA_FUNCTION_LAB_MANIFEST),
  );
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const verify = () => {
    assert.equal(sha(fs.readFileSync(manifest.wasmPath)), manifest.wasmSha256);
    assert.equal(
      sha(fs.readFileSync("/inputs/function-runner")),
      manifest.runnerSha256,
    );
    assert.equal(
      sha(fs.readFileSync(manifest.schemaPath)),
      manifest.schemaSha256,
    );
    assert.equal(
      sha(fs.readFileSync(manifest.queryPath)),
      manifest.querySha256,
    );
  };
  let index = 0;
  return {
    ...actual,
    buildFunction: async (directory) => {
      assert.equal(path.resolve(directory), manifest.snapshot);
      verify();
    },
    getFunctionInfo: async (directory) => {
      assert.equal(path.resolve(directory), manifest.snapshot);
      verify();
      return {
        schemaPath: manifest.schemaPath,
        functionRunnerPath: "/inputs/function-runner",
        wasmPath: manifest.wasmPath,
        targeting: {
          "cart.validations.generate.run": {
            inputQueryPath: manifest.queryPath,
          },
        },
      };
    },
    runFunction: async (fixture, binary, wasm, query, schema) => {
      verify();
      assert.equal(binary, "/inputs/function-runner");
      assert.equal(wasm, manifest.wasmPath);
      assert.equal(query, manifest.queryPath);
      assert.equal(schema, manifest.schemaPath);
      assert.equal(fixture.export, "cart-validations-generate-run");
      const input = JSON.stringify(fixture.input);
      assert.ok(Buffer.byteLength(input) <= 128000);
      const args = [
        "-f",
        wasm,
        "--export",
        fixture.export,
        "--query-path",
        query,
        "--schema-path",
        schema,
        "--json",
      ];
      const env = {
        HOME: manifest.home,
        TMPDIR: "/tmp",
        PATH: "/usr/local/bin:/usr/bin:/bin",
      };
      const r = spawnSync(binary, args, {
        cwd: manifest.home,
        env,
        input,
        encoding: "utf8",
        shell: false,
        timeout: 15000,
        maxBuffer: 4000000,
      });
      const name = `run-${String(index++).padStart(3, "0")}`;
      fs.writeFileSync(`${manifest.home}/${name}.stdout.log`, r.stdout || "");
      fs.writeFileSync(`${manifest.home}/${name}.stderr.log`, r.stderr || "");
      const command = {
        args,
        binarySha256: manifest.runnerSha256,
        wasmSha256: manifest.wasmSha256,
        inputBytes: Buffer.byteLength(input),
        inputSha256: sha(input),
        status: r.status,
        signal: r.signal,
        error: r.error?.code || null,
        stdoutSha256: sha(r.stdout || ""),
        stderrSha256: sha(r.stderr || ""),
        validated: false,
      };
      const commandFile = `${manifest.home}/${name}.command.json`;
      fs.writeFileSync(commandFile, JSON.stringify(command, null, 2) + "\n");
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.equal(r.error, undefined);
      assert.equal(r.signal, null);
      const output = JSON.parse(r.stdout);
      command.metrics = validateFinalRunnerResult(
        output,
        command.inputBytes,
        manifest.wasmBytes,
      );
      command.output = output.output;
      command.validated = true;
      fs.writeFileSync(commandFile, JSON.stringify(command, null, 2) + "\n");
      verify();
      return {
        error: null,
        result: { output: output.output },
        metadata: {
          instructionCount: output.instructions,
          memoryUsageKiB: output.memory_usage,
          moduleSizeKiB: output.size,
        },
      };
    },
  };
});
