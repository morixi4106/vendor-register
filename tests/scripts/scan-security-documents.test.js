import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanSecurityDocuments } from "../../scripts/security/scan-security-documents.mjs";

function fixture(contentsByFile) {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "security-documents-"),
  );
  for (const [relativePath, contents] of Object.entries(contentsByFile)) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
  }
  return repositoryRoot;
}

test("accepts public advisory metadata without sensitive values", () => {
  const repositoryRoot = fixture({
    "docs/evidence.md":
      "GHSA-MH99-V99M-4GVG\nhttps://github.com/Shopify/example/issues/1\n",
  });
  try {
    const result = scanSecurityDocuments({
      files: ["docs/evidence.md"],
      repositoryRoot,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
  } finally {
    fs.rmSync(repositoryRoot, { force: true, recursive: true });
  }
});

test("reports sensitive categories without returning matched values", () => {
  const repositoryRoot = fixture({
    "docs/evidence.md": [
      "C:\\Users\\example\\repo",
      "owner@example.com",
      "https://service.onrender.com",
      "https://store.myshopify.com",
      "postgresql://user:password@host/database",
      "shpat_12345678901234567890",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ].join("\n"),
  });
  try {
    const result = scanSecurityDocuments({
      files: ["docs/evidence.md"],
      repositoryRoot,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.findings.map((item) => item.pattern).sort(), [
      "api-key-shape",
      "database-url",
      "email-address",
      "private-key",
      "render-url",
      "shopify-store-url",
      "windows-absolute-path",
    ]);
    assert.ok(
      result.findings.every(
        (finding) =>
          !JSON.stringify(finding).includes("password") &&
          !JSON.stringify(finding).includes("shpat_"),
      ),
    );
  } finally {
    fs.rmSync(repositoryRoot, { force: true, recursive: true });
  }
});

test("fails closed for missing and oversized documents", () => {
  const repositoryRoot = fixture({
    "docs/large.md": "x".repeat(2_000_001),
  });
  try {
    const result = scanSecurityDocuments({
      files: ["docs/missing.md", "docs/large.md"],
      repositoryRoot,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.findings.map((item) => item.pattern).sort(), [
      "missing-or-outside-scope",
      "unsafe-document-file",
    ]);
  } finally {
    fs.rmSync(repositoryRoot, { force: true, recursive: true });
  }
});
