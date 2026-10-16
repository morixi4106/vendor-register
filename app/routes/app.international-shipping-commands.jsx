import { internationalShippingAction } from "../services/internationalShippingAction.server.js";
import {
  internationalErrorResponse,
  internationalJson,
} from "../services/internationalRunnerAuthentication.server.js";
export const action = async ({ request }) => {
  try {
    const result = await internationalShippingAction({ request });
    if (
      result.status === 302 &&
      result.headers.get("Location") === "/app/international-shipping"
    )
      return internationalJson({ ok: true });
    return result;
  } catch (error) {
    return internationalErrorResponse(error);
  }
};
export const loader = () =>
  internationalJson({ ok: false, code: "method_not_allowed" }, 405, {
    Allow: "POST",
  });
