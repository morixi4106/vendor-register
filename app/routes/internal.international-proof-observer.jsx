import { createInternationalRunnerInterface } from "../services/internationalRunnerInterface.server.js";
import { internationalJson } from "../services/internationalRunnerAuthentication.server.js";
const handle = createInternationalRunnerInterface();
export const action = ({ request }) => handle(request, "observer");
export const loader = () =>
  internationalJson({ ok: false, code: "method_not_allowed" }, 405, {
    Allow: "POST",
  });
