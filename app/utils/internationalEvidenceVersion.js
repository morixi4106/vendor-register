export function internationalEvidenceVersion(row) {
  return row
    ? `${Number(row.revision) || 0}:${row.updatedAt ? new Date(row.updatedAt).toISOString() : "unversioned"}`
    : "absent";
}
