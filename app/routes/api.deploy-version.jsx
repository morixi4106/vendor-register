import { json } from "@remix-run/node";

export const loader = async () => {
  const commit = process.env.RENDER_GIT_COMMIT || "";
  const branch = process.env.RENDER_GIT_BRANCH || "";
  const serviceId = process.env.RENDER_SERVICE_ID || "";
  const serviceName = process.env.RENDER_SERVICE_NAME || "";

  return json(
    {
      ok: true,
      platform: "render",
      commit,
      shortCommit: commit ? commit.slice(0, 7) : "",
      branch,
      serviceId,
      serviceName,
      checkedAt: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "Surrogate-Control": "no-store",
      },
    }
  );
};
