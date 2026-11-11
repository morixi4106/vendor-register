import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const policy = JSON.parse(
  fs.readFileSync(
    new URL("../../security/vendor-patches.json", import.meta.url),
    "utf8",
  ),
);
const digest = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function checkedFile(root, relative) {
  if (
    typeof relative !== "string" ||
    relative.includes("\\") ||
    relative.split("/").includes("..") ||
    path.isAbsolute(relative)
  )
    throw new Error("vendor_patch_path_invalid");
  const base = fs.realpathSync(root);
  const file = path.resolve(base, relative);
  const info = fs.lstatSync(file);
  const resolved = path.relative(base, fs.realpathSync(file));
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 2 * 1024 * 1024 ||
    resolved.startsWith("..") ||
    path.isAbsolute(resolved)
  )
    throw new Error("vendor_patch_file_invalid");
  return file;
}

export function verifyPatchedMergePackage(directory, metadata) {
  if (digest(checkedFile(directory, "package.json")) !== policy.packageSha256)
    throw new Error("vendor_patch_manifest_mismatch");
  if (
    metadata.name !== policy.packageName ||
    metadata.version !== policy.version ||
    metadata.main !== "index.cjs"
  )
    throw new Error("vendor_patch_identity_mismatch");
  if (digest(checkedFile(directory, "index.cjs")) !== policy.sourceSha256)
    throw new Error("vendor_patch_source_mismatch");
  const provenanceFile = checkedFile(directory, "provenance.json");
  if (digest(provenanceFile) !== policy.provenanceSha256)
    throw new Error("vendor_patch_provenance_mismatch");
  const provenance = JSON.parse(fs.readFileSync(provenanceFile, "utf8"));
  if (
    provenance.advisory !== policy.advisory ||
    provenance.commit !== policy.upstreamCommit ||
    provenance.status !== "locally-maintained-security-backport"
  )
    throw new Error("vendor_patch_provenance_mismatch");
  return {
    ok: true,
    advisory: policy.advisory,
    packageName: policy.packageName,
    sourceSha256: policy.sourceSha256,
  };
}

export function stageVendorPatches(root, stage) {
  verifyPatchedMergePackage(
    path.join(root, "vendor/deepmerge"),
    JSON.parse(
      fs.readFileSync(
        checkedFile(root, "vendor/deepmerge/package.json"),
        "utf8",
      ),
    ),
  );
  const file = checkedFile(root, policy.tarball);
  if (digest(file) !== policy.tarballSha256)
    throw new Error("vendor_patch_tarball_mismatch");
  const destination = path.resolve(stage, policy.tarball);
  if (
    !path
      .relative(fs.realpathSync(stage), destination)
      .startsWith(`vendor${path.sep}`)
  )
    throw new Error("vendor_patch_stage_invalid");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination);
}
