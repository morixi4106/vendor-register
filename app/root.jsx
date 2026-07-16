import { json } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "@remix-run/react";
import { resolveWithdrawalLocale } from "./utils/withdrawalLocale.js";

const FALLBACK_FAVICON_VERSION = "local";

export const loader = async ({ request }) => {
  const commit =
    process.env.RENDER_GIT_COMMIT ||
    process.env.COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    "";

  return json({
    faviconVersion: commit ? commit.slice(0, 12) : FALLBACK_FAVICON_VERSION,
    documentLocale: resolveWithdrawalLocale({
      urlLocale: new URL(request.url).searchParams.get("lang"),
      acceptLanguage: request.headers.get("accept-language"),
    }).locale,
  });
};

export default function App() {
  const { faviconVersion = FALLBACK_FAVICON_VERSION, documentLocale = "ja-JP" } =
    useLoaderData() || {};
  const faviconCacheKey = `?v=${encodeURIComponent(faviconVersion)}`;

  return (
    <html lang={documentLocale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href={`/favicon-32.png${faviconCacheKey}`}
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href={`/favicon-16.png${faviconCacheKey}`}
        />
        <link rel="shortcut icon" href={`/favicon.ico${faviconCacheKey}`} />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href={`/apple-touch-icon.png${faviconCacheKey}`}
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
