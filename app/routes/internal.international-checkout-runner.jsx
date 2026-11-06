import { createInternationalCheckoutRunner } from "../services/internationalCheckoutRunner.server.js";

const handle = createInternationalCheckoutRunner();
export const action = ({ request }) => handle(request);
export const loader = () =>
  new Response(null, {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "private, no-store" },
  });
