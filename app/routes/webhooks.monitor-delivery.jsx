import { handleMonitorDeliveryWebhook } from "../services/monitorDeliveryWebhook.server.js";

export const loader = ({ request }) => handleMonitorDeliveryWebhook(request);
export const action = ({ request }) => handleMonitorDeliveryWebhook(request);
