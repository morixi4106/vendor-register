import { proofError } from "../utils/internationalProofContract.js";

export function internationalProofBudget(
  github,
  graphQL,
  startedAt = Date.now(),
) {
  const deadline = +startedAt + 45000;
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const check = () => {
    if (signal.aborted || Date.now() >= deadline)
      throw proofError("international_deadline_exceeded", 503);
  };
  const read =
    (method) =>
    async (id, options = {}) => {
      check();
      const value = await github[method](id, {
        ...options,
        timeoutMs: Math.min(options.timeoutMs ?? 30000, deadline - Date.now()),
      });
      check();
      return value;
    };
  return {
    check,
    github: { json: read("json"), archive: read("archive") },
    graphQL: async (args) => {
      check();
      const value = await graphQL({
        ...args,
        signal: args.signal ? AbortSignal.any([args.signal, signal]) : signal,
      });
      check();
      return value;
    },
  };
}
