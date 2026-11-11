import assert from "node:assert/strict";
import test from "node:test";
import {
  readNodePolicy,
  evaluateNodeRuntime,
  assertNodeRuntime,
} from "../../scripts/security/node-runtime.mjs";

const policy = readNodePolicy();
const observed = {
  version: policy.version,
  platform: "linux",
  arch: "x64",
  sha256: policy.artifacts["linux-x64"].executableSha256,
};

test("both signed Node release binaries are approved by version and digest", () => {
  for (const platform of ["linux", "win32"])
    assert.equal(
      evaluateNodeRuntime({
        ...observed,
        platform,
        sha256: policy.artifacts[`${platform}-x64`].executableSha256,
      }).ok,
      true,
    );
});

test("old, unknown, prerelease and different major Nodes are not approved", () => {
  for (const version of [
    "24.13.1",
    "24.22.0",
    "24.22.2",
    "24.22.1-rc.1",
    "26.12.1",
    "v24.22.1",
    null,
  ])
    assert.equal(evaluateNodeRuntime({ ...observed, version }).ok, false);
});

test("a version string or caller flag cannot authorize a different executable", () => {
  for (const sha256 of ["0".repeat(64), "", null, "x".repeat(64)])
    assert.equal(evaluateNodeRuntime({ ...observed, sha256 }).ok, false);
  assert.equal(evaluateNodeRuntime({ ...observed, skip: true }).ok, false);
  for (const platform of ["darwin", "__proto__", "linux-x64"])
    assert.equal(evaluateNodeRuntime({ ...observed, platform }).ok, false);
  assert.equal(evaluateNodeRuntime({ ...observed, arch: "arm64" }).ok, false);
});

test("malformed runtime policy is not accepted", () => {
  for (const value of [
    null,
    [],
    {},
    { ...policy, allowUnknown: true },
    { ...policy, version: "26.1.0" },
  ])
    assert.equal(evaluateNodeRuntime(observed, value).ok, false);
  const broken = structuredClone(policy);
  broken.artifacts["linux-x64"].executableSha256 = "not-a-digest";
  assert.equal(evaluateNodeRuntime(observed, broken).ok, false);
});

test("the current verified executable passes and its observation is immutable", () => {
  const result = assertNodeRuntime();
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(assertNodeRuntime(), result);
});
