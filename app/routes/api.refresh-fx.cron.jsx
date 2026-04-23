import { createRefreshFxCronHandler } from '../services/api.refresh-fx.server.js';

const handler = createRefreshFxCronHandler();

export const loader = handler;
export const action = handler;
