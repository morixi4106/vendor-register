import assert from "node:assert/strict";

export function validateFinalRunnerResult(output, inputBytes, wasmBytes) {
  assert.equal(output.success, true);
  for (const [value, maximum] of [
    [output.instructions, 11000000],
    [output.memory_usage, 10000],
    [wasmBytes, 262144],
  ]) {
    assert.ok(Number.isFinite(value) && value > 0 && value <= maximum);
  }
  assert.ok(
    Number.isInteger(inputBytes) && inputBytes > 0 && inputBytes <= 128000,
  );
  assert.ok(output.output && typeof output.output === "object");
  const jsonOutputBytes = Buffer.byteLength(JSON.stringify(output.output));
  assert.ok(jsonOutputBytes <= 20000);
  return {
    instructions: output.instructions,
    memoryUsageKiB: output.memory_usage,
    inputBytes,
    jsonOutputBytes,
  };
}

export function verifyFinalSuite(result, commands, expected) {
  assert.equal(result.success, true);
  assert.equal(result.numTotalTests, expected.testCount);
  assert.equal(result.numPassedTests, expected.testCount);
  assert.equal(result.numFailedTests, 0);
  assert.equal(result.numPendingTests, 0);
  const assertions = result.testResults.flatMap((r) => r.assertionResults);
  assert.equal(assertions.length, expected.testCount);
  assert.ok(assertions.every((a) => a.status === "passed"));
  assert.equal(commands.length, expected.runnerCalls);
  for (const c of commands) {
    assert.equal(c.status, 0);
    assert.equal(c.error, null);
    assert.equal(c.signal, null);
    assert.equal(c.validated, true);
    assert.equal(c.wasmSha256, expected.wasmSha256);
    assert.equal(c.binarySha256, expected.runnerSha256);
    for (const h of [c.inputSha256, c.stdoutSha256, c.stderrSha256])
      assert.match(h, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      c.metrics,
      validateFinalRunnerResult(
        {
          success: true,
          instructions: c.metrics.instructions,
          memory_usage: c.metrics.memoryUsageKiB,
          output: c.output,
        },
        c.inputBytes,
        expected.wasmBytes,
      ),
    );
  }
  return {
    testCount: expected.testCount,
    runnerCalls: commands.length,
    maxFuel: Math.max(...commands.map((c) => c.metrics.instructions)),
    maxMemoryKiB: Math.max(...commands.map((c) => c.metrics.memoryUsageKiB)),
    maxJsonInputBytes: Math.max(...commands.map((c) => c.inputBytes)),
    maxJsonOutputBytes: Math.max(
      ...commands.map((c) => c.metrics.jsonOutputBytes),
    ),
  };
}
