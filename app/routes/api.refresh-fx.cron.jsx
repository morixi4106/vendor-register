import { createRefreshFxCronHandler } from '../services/api.refresh-fx.server.js';
import {
  requireBearerToken,
  requirePostRequest,
} from '../utils/routeSecurity.server.js';

const handler = createRefreshFxCronHandler();

export const loader = () =>
  new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });

export const action = async (args) => {
  requirePostRequest(args.request);
  requireBearerToken(args.request, process.env.FX_REFRESH_WORKER_TOKEN, {
    missingConfiguration: "fx_refresh_worker_token_not_configured",
  });
  return handler(args);
};
