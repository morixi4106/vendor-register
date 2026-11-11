import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PRISMA_LAB_IMAGE =
  "postgres:17.11@sha256:996e9dc583ba9f0265a2c75547a9c95fb22c251e394749cab205a0a00e1856a1";
export const PRISMA_LAB_DATABASES = Object.freeze([
  Object.freeze({
    image: PRISMA_LAB_IMAGE,
    serverVersionNum: 170011,
    hbaFile: "/var/lib/postgresql/data/pg_hba.conf",
  }),
  Object.freeze({
    image:
      "postgres:18.6-bookworm@sha256:02fb3245e038f33536cf13bc6c4e59f21d07b0cea3c1fe1c07c6e8aa8f083bcc",
    serverVersionNum: 180006,
    hbaFile: "/var/lib/postgresql/18/docker/pg_hba.conf",
  }),
]);
const sha = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const ROOT = path.resolve(import.meta.dirname, "../..");

export function prismaTlsLabOptions(
  args,
  env = process.env,
  platform = process.platform,
) {
  if (
    platform !== "linux" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    args.length !== 2 ||
    args[0] !== "--container" ||
    !/^[a-f0-9]{64}$/.test(args[1])
  )
    throw new Error("prisma_tls_lab_arguments_invalid");
  return args[1];
}

export function readPrismaTlsLab(root) {
  const directory = path.join(root, ".audit/prisma-tls-lab");
  if (
    fs.realpathSync(directory) !== directory ||
    !fs.lstatSync(directory).isDirectory()
  )
    throw new Error("prisma_tls_lab_path_invalid");
  const manifestFile = path.join(directory, "manifest.json");
  const manifestStat = fs.lstatSync(manifestFile);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.nlink !== 1 ||
    manifestStat.size > 8192
  )
    throw new Error("prisma_tls_lab_evidence_invalid");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const files = {
    ca: "ca.crt",
    server: "server.crt",
    untrustedCa: "untrusted-ca.crt",
  };
  const database = PRISMA_LAB_DATABASES.find(
    (entry) => entry.image === manifest.image,
  );
  if (
    !database ||
    manifest.serverVersionNum !== database.serverVersionNum ||
    manifest.hostname !== "localhost" ||
    manifest.plaintextRejected !== true ||
    manifest.productionApproved !== false
  )
    throw new Error("prisma_tls_lab_evidence_invalid");
  const result = {
    image: manifest.image,
    serverVersionNum: manifest.serverVersionNum,
    hostname: manifest.hostname,
    plaintextRejected: true,
  };
  for (const [role, name] of Object.entries(files)) {
    const file = path.join(directory, name),
      stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 16384 ||
      sha(file) !== manifest[`${role}Sha256`]
    )
      throw new Error("prisma_tls_lab_certificate_invalid");
    const cert = new crypto.X509Certificate(fs.readFileSync(file));
    if (
      Date.parse(cert.validFrom) > Date.now() ||
      Date.parse(cert.validTo) < Date.now() ||
      (role === "server"
        ? cert.ca ||
          cert.checkHost("localhost") !== "localhost" ||
          cert.checkIP("127.0.0.1") !== undefined
        : !cert.ca)
    )
      throw new Error("prisma_tls_lab_certificate_invalid");
    result[`${role}File`] = file;
    result[`${role}Sha256`] = sha(file);
  }
  const cert = (role) =>
    new crypto.X509Certificate(fs.readFileSync(result[`${role}File`]));
  if (
    !cert("server").verify(cert("ca").publicKey) ||
    cert("server").verify(cert("untrustedCa").publicKey)
  )
    throw new Error("prisma_tls_lab_certificate_invalid");
  return result;
}

export async function preparePrismaTlsLab(root, container, run) {
  prismaTlsLabOptions(["--container", container]);
  const execute =
    run ||
    ((command, args) => {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        timeout: 60000,
        windowsHide: true,
      });
      if (result.error || result.status !== 0)
        throw new Error(
          `prisma_tls_lab_command_failed: ${command}: ${result.stderr || result.error?.message}`,
        );
      return result.stdout.trim();
    });
  const docker = (args) => execute("docker", args);
  const inspect = JSON.parse(docker(["inspect", container]));
  const service = inspect[0];
  const database = PRISMA_LAB_DATABASES.find(
    (entry) => entry.image === service?.Config?.Image,
  );
  if (
    inspect.length !== 1 ||
    service.Id !== container ||
    !database ||
    !service.State?.Running ||
    ![
      "POSTGRES_USER=oja_probe",
      "POSTGRES_DB=oja_probe",
      "POSTGRES_PASSWORD=oja-ephemeral-test-only",
      "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
    ].every((v) => service.Config.Env.includes(v))
  )
    throw new Error("prisma_tls_lab_container_invalid");
  const directory = path.join(root, ".audit/prisma-tls-lab");
  fs.mkdirSync(path.join(root, ".audit"), { recursive: true });
  if (fs.realpathSync(path.join(root, ".audit")) !== path.join(root, ".audit"))
    throw new Error("prisma_tls_lab_path_invalid");
  fs.mkdirSync(directory, { mode: 0o700 });
  const openssl = (args) => execute("openssl", args);
  for (const prefix of ["ca", "untrusted-ca"])
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "2",
      "-subj",
      `/CN=Oja ephemeral ${prefix}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      path.join(directory, `${prefix}.key`),
      "-out",
      path.join(directory, `${prefix}.crt`),
    ]);
  openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-keyout",
    path.join(directory, "server.key"),
    "-out",
    path.join(directory, "server.csr"),
  ]);
  fs.writeFileSync(
    path.join(directory, "server.ext"),
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n",
    { flag: "wx" },
  );
  openssl([
    "x509",
    "-req",
    "-in",
    path.join(directory, "server.csr"),
    "-CA",
    path.join(directory, "ca.crt"),
    "-CAkey",
    path.join(directory, "ca.key"),
    "-CAcreateserial",
    "-days",
    "2",
    "-sha256",
    "-extfile",
    path.join(directory, "server.ext"),
    "-out",
    path.join(directory, "server.crt"),
  ]);
  const sql = (query) =>
    docker([
      "exec",
      container,
      "psql",
      "-U",
      "oja_probe",
      "-d",
      "oja_probe",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      query,
    ]);
  if (sql("SHOW server_version_num") !== String(database.serverVersionNum))
    throw new Error("prisma_tls_lab_server_version_invalid");
  const remote = "/tmp/oja-prisma-tls-lab";
  docker(["exec", container, "mkdir", "-m", "700", remote]);
  for (const name of ["server.crt", "server.key"])
    docker([
      "cp",
      path.join(directory, name),
      `${container}:${remote}/${name}`,
    ]);
  docker(["exec", container, "chown", "-R", "postgres:postgres", remote]);
  docker(["exec", container, "chmod", "600", `${remote}/server.key`]);
  for (const [key, value] of [
    ["ssl_cert_file", `${remote}/server.crt`],
    ["ssl_key_file", `${remote}/server.key`],
    ["ssl_min_protocol_version", "TLSv1.2"],
    ["ssl", "on"],
  ])
    sql(`ALTER SYSTEM SET ${key} = '${value}'`);
  const hba = sql("SHOW hba_file");
  if (hba !== database.hbaFile)
    throw new Error("prisma_tls_lab_hba_path_invalid");
  fs.writeFileSync(
    path.join(directory, "pg_hba.conf"),
    "local all all trust\nhostnossl all all all reject\nhostssl all all all scram-sha-256\n",
    { flag: "wx" },
  );
  docker(["cp", path.join(directory, "pg_hba.conf"), `${container}:${hba}`]);
  docker(["exec", container, "chown", "postgres:postgres", hba]);
  if (sql("SELECT pg_reload_conf()") !== "t")
    throw new Error("prisma_tls_lab_reload_failed");
  for (let attempt = 0; sql("SHOW ssl") !== "on"; attempt++) {
    if (attempt >= 20) throw new Error("prisma_tls_lab_ssl_unavailable");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (
    sql("SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL") !==
    "0"
  )
    throw new Error("prisma_tls_lab_hba_invalid");
  const manifest = {
    image: database.image,
    serverVersionNum: database.serverVersionNum,
    hostname: "localhost",
    plaintextRejected: true,
    caSha256: sha(path.join(directory, "ca.crt")),
    serverSha256: sha(path.join(directory, "server.crt")),
    untrustedCaSha256: sha(path.join(directory, "untrusted-ca.crt")),
    productionApproved: false,
  };
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest),
    { flag: "wx" },
  );
  readPrismaTlsLab(root);
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        await preparePrismaTlsLab(
          ROOT,
          prismaTlsLabOptions(process.argv.slice(2)),
        ),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
