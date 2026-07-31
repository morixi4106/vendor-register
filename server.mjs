import { statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import compression from "compression";
import express from "express";
import { createRequestHandler } from "@remix-run/express";
import { installGlobals } from "@remix-run/node";

import { createSafeRequestLogger } from "./app/utils/requestLog.server.js";

process.env.NODE_ENV ||= "production";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const buildPath = path.resolve("./build/server/index.js");
const buildUrl = pathToFileURL(buildPath);
buildUrl.searchParams.set("t", String(statSync(buildPath).mtimeMs));
const build = await import(buildUrl.href);

installGlobals({
  nativeFetch: build.future.v3_singleFetch,
});

const app = express();
app.disable("x-powered-by");
app.use(compression());
app.use(
  build.publicPath,
  express.static(build.assetsBuildDirectory, {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(express.static("public", { maxAge: "1h" }));
app.use(createSafeRequestLogger());
app.all(
  "*",
  createRequestHandler({
    build,
    mode: process.env.NODE_ENV,
  }),
);

const host = process.env.HOST;
const onListen = () => {
  const publicAddress =
    host ||
    Object.values(networkInterfaces())
      .flat()
      .find(
        (address) =>
          String(address?.family).includes("4") && !address?.internal,
      )?.address;
  const suffix = publicAddress
    ? ` (http://${publicAddress}:${port})`
    : "";
  console.log(`[vendor-register] http://localhost:${port}${suffix}`);
};
const server = host
  ? app.listen(port, host, onListen)
  : app.listen(port, onListen);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(console.error));
}
