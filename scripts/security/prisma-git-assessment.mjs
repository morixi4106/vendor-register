import crypto from "node:crypto";
import toml from "toml";

const GIT = [
  [
    "barrel",
    "0.6.6-alpha.0",
    "prisma/barrel",
    "4e84cf3d5013b4c92eb81d7ba90cd1c1c01c6805",
  ],
  [
    "graphql-parser",
    "0.3.0",
    "prisma/graphql-parser",
    "6a3f58bd879065588e710cb02b5bd30c1ce182c3",
  ],
  [
    "tiberius",
    "0.13.0",
    "prisma/tiberius",
    "35605c90adb38cc107d35c3432fd2643d9d6e1e6",
  ],
  [
    "tiberius-macros",
    "0.1.0",
    "prisma/tiberius",
    "35605c90adb38cc107d35c3432fd2643d9d6e1e6",
  ],
];
const ROOTS = ["query-engine-node-api", "schema-engine-cli"];
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const idPattern =
  /^(RUSTSEC-\d{4}-\d{4}|GHSA-[a-z0-9-]+|CVE-\d{4}-\d+|OSV-\d{4}-\d+)$/;
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function prismaGitIdentities(policy, lockBytes, metadata) {
  if (sha(lockBytes) !== policy.lockfile.sha256)
    throw new Error("prisma_git_lock_unbound");
  const lock = toml.parse(lockBytes.toString("utf8"));
  const git = lock.package.filter((p) => p.source?.startsWith("git+"));
  if (git.length !== GIT.length)
    throw new Error("prisma_git_inventory_changed");
  const identities = GIT.map(([name, version, repository, commit]) => {
    const matches = git.filter((p) => p.name === name);
    const source = matches[0]?.source;
    if (
      matches.length !== 1 ||
      matches[0].version !== version ||
      !new RegExp(
        `^git\\+https://github\\.com/${repository}(?:\\.git)?(?:\\?branch=[a-zA-Z0-9_-]+)?#${commit}$`,
      ).test(source)
    )
      throw new Error("prisma_git_inventory_changed");
    return {
      name,
      version,
      upstreamVersion: version,
      repository,
      commit,
      source,
    };
  });
  for (const [entry, packages] of [
    [policy.mysqlSources[0], [policy.mysqlSources[0]]],
    [policy.cuidSource, policy.cuidSource.packages],
    [policy.postgresSource, policy.postgresSource.packages],
  ]) {
    const origin = entry.gitSource || entry;
    for (const pkg of packages)
      identities.push({
        name: pkg.name,
        version: pkg.version,
        upstreamVersion: pkg.upstreamVersion,
        repository: origin.repository,
        commit: origin.commit,
        archiveSha256: entry.sha256,
        patchSha256: entry.patch.sha256,
        source: null,
      });
  }
  if (
    identities.length !== 13 ||
    new Set(identities.map((p) => p.name)).size !== 13 ||
    identities.some(
      (p) => !/^[a-f0-9]{40}$/.test(p.commit) || !p.upstreamVersion,
    )
  )
    throw new Error("prisma_git_inventory_changed");
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  if (
    packages.size !== metadata.packages.length ||
    nodes.size !== metadata.resolve.nodes.length ||
    metadata.packages.filter((p) => p.source?.startsWith("git+")).length !== 4
  )
    throw new Error("prisma_git_metadata_invalid");
  for (const node of nodes.values()) {
    if (
      !packages.has(node.id) ||
      !Array.isArray(node.deps) ||
      !Array.isArray(node.features)
    )
      throw new Error("prisma_git_metadata_invalid");
    for (const edge of node.deps) {
      if (
        !nodes.has(edge.pkg) ||
        !Array.isArray(edge.dep_kinds) ||
        !edge.dep_kinds.length ||
        edge.dep_kinds.some(
          (kind) => ![null, "dev", "build"].includes(kind.kind),
        )
      )
        throw new Error("prisma_git_metadata_invalid");
    }
  }
  const roots = ROOTS.map((name) => {
    const matches = metadata.packages.filter(
      (p) => p.name === name && !p.source,
    );
    if (matches.length !== 1 || !nodes.has(matches[0].id))
      throw new Error("prisma_git_metadata_invalid");
    return matches[0];
  });
  function route(root, target) {
    const queue = [[root.id]],
      visited = new Set([root.id]);
    for (const trail of queue) {
      const id = trail.at(-1);
      if (id === target) return trail.map((key) => packages.get(key).name);
      for (const dep of nodes.get(id).deps) {
        if (
          !visited.has(dep.pkg) &&
          dep.dep_kinds.some((kind) => kind.kind !== "dev")
        ) {
          visited.add(dep.pkg);
          queue.push([...trail, dep.pkg]);
        }
      }
    }
    return null;
  }
  return identities.map((entry) => {
    const matches = metadata.packages.filter((p) => p.name === entry.name);
    const pkg = matches[0];
    if (
      matches.length !== 1 ||
      pkg.version !== entry.version ||
      (pkg.source || null) !== entry.source ||
      !nodes.has(pkg.id)
    )
      throw new Error("prisma_git_metadata_unbound");
    return {
      ...entry,
      reviewStatus: "UNREVIEWED",
      features: [...nodes.get(pkg.id).features].sort(),
      directConsumers: [...nodes.values()]
        .filter((n) => n.deps.some((d) => d.pkg === pkg.id))
        .map((n) => packages.get(n.id).name)
        .sort(),
      pathsFromReleaseRoots: Object.fromEntries(
        roots.map((r) => [r.name, route(r, pkg.id)]),
      ),
    };
  });
}

async function jsonResponse(response, limit) {
  if (!response.ok) throw new Error("prisma_git_advisory_unavailable");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("prisma_git_advisory_limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function assessPrismaGitIdentities(
  policy,
  lockBytes,
  metadata,
  { fetchImpl = fetch } = {},
) {
  const identities = prismaGitIdentities(policy, lockBytes, metadata);
  const commits = [...new Set(identities.map((p) => p.commit))];
  const queries = [
    ...identities.map((p) => ({
      package: { ecosystem: "crates.io", name: p.name },
      version: p.upstreamVersion,
    })),
    ...commits.map((commit) => ({ commit })),
  ];
  const result = await jsonResponse(
    await fetchImpl("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ queries }),
    }),
    2 * 1024 * 1024,
  );
  if (
    !object(result) ||
    Object.keys(result).some((key) => key !== "results") ||
    !Array.isArray(result.results) ||
    result.results.length !== queries.length
  )
    throw new Error("prisma_git_advisory_incomplete");
  const expected = new Map();
  const lookups = result.results.map((entry, i) => {
    if (
      !object(entry) ||
      Object.keys(entry).some(
        (key) => !["vulns", "next_page_token"].includes(key),
      ) ||
      entry.next_page_token ||
      (entry.vulns !== undefined && !Array.isArray(entry.vulns))
    )
      throw new Error("prisma_git_advisory_incomplete");
    const matches = (entry.vulns || []).map((v) => {
      if (
        !object(v) ||
        !idPattern.test(v.id) ||
        !Number.isFinite(Date.parse(v.modified))
      )
        throw new Error("prisma_git_advisory_invalid");
      if (
        expected.has(v.id) &&
        Date.parse(expected.get(v.id)) !== Date.parse(v.modified)
      )
        throw new Error("prisma_git_advisory_changed");
      expected.set(v.id, v.modified);
      return { id: v.id, modified: v.modified };
    });
    if (new Set(matches.map((m) => m.id)).size !== matches.length)
      throw new Error("prisma_git_advisory_invalid");
    return { query: queries[i], matches };
  });
  const advisories = [];
  for (const [id, modified] of [...expected].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const advisory = await jsonResponse(
      await fetchImpl(`https://api.osv.dev/v1/vulns/${id}`, {
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      }),
      2 * 1024 * 1024,
    );
    // OSV batch timestamps truncate sub-millisecond precision; preserve both originals.
    if (
      !object(advisory) ||
      advisory.id !== id ||
      Date.parse(advisory.modified) !== Date.parse(modified) ||
      !Array.isArray(advisory.affected) ||
      !advisory.affected.length ||
      !Array.isArray(advisory.references) ||
      !advisory.references.length ||
      typeof advisory.details !== "string" ||
      !advisory.details.trim()
    )
      throw new Error("prisma_git_advisory_payload_invalid");
    advisories.push({
      id,
      sha256: sha(canonicalJson(advisory)),
      payload: advisory,
    });
  }
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    scope:
      "Original declared registry versions plus exact Git commits. Empty searches are not fork equivalence, source review, or proof of absence. Graph paths exclude dev-only edges but include build dependencies and unioned Cargo features; not executable reachability.",
    advisorySource: "https://api.osv.dev",
    artifactStatus: "NOT_VERIFIED",
    sourceReviewed: false,
    sourceAuditOk: false,
    wholeEngineVerified: false,
    productionApproved: false,
    lockfileSha256: sha(lockBytes),
    metadataSha256: sha(JSON.stringify(metadata)),
    identities,
    lookups,
    advisories,
    packagesWithVersionMatches: lookups
      .slice(0, identities.length)
      .filter((q) => q.matches.length).length,
    commitsWithMatches: lookups
      .slice(identities.length)
      .filter((q) => q.matches.length).length,
  };
}
