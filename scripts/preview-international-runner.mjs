import { createServer } from "vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const route = "app/routes/app.international-shipping.jsx";
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createMemoryRouter,RouterProvider} from 'react-router';
import {AppProvider} from '@shopify/polaris';
import translations from '/node_modules/@shopify/polaris/locales/ja.json';
import '/node_modules/@shopify/polaris/build/esm/styles.css';
import Page from 'virtual:international-page';
import {internationalRunnerPageFixture} from '/tests/fixtures/internationalRunnerPage.js';
window.shopify={idToken:async()=> 'fixture.header.token'};
const params=new URLSearchParams(location.search);
const data=internationalRunnerPageFixture(params.get('role')||'admin',params.get('phase')||'PASSED');
const router=createMemoryRouter([{path:'/',loader:()=>data,element:React.createElement(AppProvider,{i18n:translations},React.createElement(Page))}]);
createRoot(document.getElementById('root')).render(React.createElement(RouterProvider,{router}));`;
function pageSource() {
  const source = ts.createSourceFile(
    route,
    readFileSync(path.join(root, route), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX,
  );
  const statements = source.statements.filter((node) => {
    if (ts.isImportDeclaration(node)) {
      const name = node.moduleSpecifier.text;
      return (
        !name.endsWith(".server.js") &&
        !name.includes("db.server") &&
        !name.includes("marketplaceOperator")
      );
    }
    return (
      !ts.isVariableStatement(node) ||
      !node.declarationList.declarations.some((d) =>
        ["loader", "action"].includes(d.name.getText(source)),
      )
    );
  });
  let result = ts
    .createPrinter()
    .printFile(ts.factory.updateSourceFile(source, statements));
  result = result.replaceAll('"../', '"/app/');
  return ts.transpileModule(result, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}
const server = await createServer({
  root,
  configFile: false,
  appType: "custom",
  esbuild: { jsx: "automatic" },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.INTERNATIONAL_PREVIEW_PORT || 4179),
  },
  plugins: [
    {
      name: "international-fixture-only",
      resolveId(id) {
        if (id === "virtual:international-page")
          return "\0international-page.jsx";
        if (id === "/preview-entry.jsx")
          return "\0international-preview-entry.js";
      },
      load(id) {
        if (id === "\0international-page.jsx") return pageSource();
        if (id === "\0international-preview-entry.js") return entry;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (
            req.method === "POST" &&
            req.url === "/app/international-shipping-commands"
          ) {
            let body = "";
            for await (const bytes of req) {
              body += bytes;
              if (body.length > 32000) break;
            }
            const form = new URLSearchParams(body);
            const valid =
              req.headers.authorization === "Bearer fixture.header.token" &&
              !body.includes("fixture.header.token");
            res.writeHead(valid ? 202 : 401, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            });
            res.end(
              JSON.stringify({
                ok: valid,
                pending: valid,
                intent: form.get("intent"),
                fixture: true,
              }),
            );
            return;
          }
          if (req.method !== "GET" || !/^\/(?:\?.*)?$/.test(req.url))
            return next();
          const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>International runner fixture preview</title></head><body><div id="root"></div><script type="module" src="/preview-entry.jsx"></script></body></html>`;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(await vite.transformIndexHtml(req.url, html));
        });
      },
    },
  ],
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "react-router",
      "@shopify/polaris",
      "@shopify/app-bridge-react",
      "@shopify/polaris-icons",
    ],
  },
});
await server.listen();
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await server.close();
    process.exit();
  });
