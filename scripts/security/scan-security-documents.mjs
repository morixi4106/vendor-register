import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");

export const DEFAULT_SECURITY_DOCUMENTS = [
  "docs/security-advisories.md",
  "docs/security-toolchain-evidence-2026-07-28.md",
  "docs/shopify-toolchain-security-report.md",
  "security/risk-decisions/GHSA-mh99-v99m-4gvg.json",
  "security/risk-decisions/GHSA-mh99-v99m-4gvg.approved-paths.txt",
];

const SENSITIVE_PATTERNS = [
  ["windows-absolute-path", /[A-Za-z]:\\(?:Users|ProgramData|Windows)\\/i],
  ["unix-home-path", /\/(?:home|Users)\/[^/\s]+(?:\/|$)/],
  ["email-address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["render-url", /https?:\/\/[^\s"'`<>]*\.onrender\.com\b/i],
  ["shopify-store-url", /https?:\/\/[^\s"'`<>]*\.myshopify\.com\b/i],
  ["database-url", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//i],
  [
    "api-key-shape",
    /\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_|shpat_|shpca_|sk_live_|rk_live_|re_)[A-Za-z0-9_-]{12,}/,
  ],
  ["private-key", /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/],
  ["ssh-public-key", /\bssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/=]{20,}/],
];

export function scanSecurityDocuments({
  files = DEFAULT_SECURITY_DOCUMENTS,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const findings = [];
  for (const relativePath of files) {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    const relative = path.relative(repositoryRoot, absolutePath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !fs.existsSync(absolutePath)
    ) {
      findings.push({
        file: relativePath,
        pattern: "missing-or-outside-scope",
      });
      continue;
    }
    const stats = fs.lstatSync(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2_000_000) {
      findings.push({
        file: relativePath,
        pattern: "unsafe-document-file",
      });
      continue;
    }
    const source = fs.readFileSync(absolutePath, "utf8");
    for (const [pattern, expression] of SENSITIVE_PATTERNS) {
      if (expression.test(source)) {
        findings.push({
          file: relativePath,
          pattern,
        });
      }
    }
  }
  return {
    findings,
    ok: findings.length === 0,
    scannedFileCount: files.length,
  };
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
/* node:coverage disable */
if (isMainModule) {
  const result = scanSecurityDocuments();
  if (!result.ok) {
    console.error(
      `Security document scan failed with ${result.findings.length} finding(s).`,
    );
    for (const finding of result.findings) {
      console.error(`- ${finding.file}: ${finding.pattern}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Security document scan passed (${result.scannedFileCount} files).`,
    );
  }
}
/* node:coverage enable */
