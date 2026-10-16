import { vi } from "vitest";

Object.defineProperty(globalThis, "__INTERNATIONAL_PROOF_PREBUILT__", {
  value: true,
  writable: false,
});
vi.mock("@shopify/shopify-function-test-helpers", async (importOriginal) => ({
  ...(await importOriginal()),
  buildFunction: () => {
    throw new Error("prebuilt_rebuild_forbidden");
  },
}));
