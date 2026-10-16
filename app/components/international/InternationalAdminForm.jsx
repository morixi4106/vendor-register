import { createContext, useContext, useState, useEffect, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useRevalidator } from "react-router";
import { Banner } from "@shopify/polaris";

const ActionContext = createContext(null);
export const useInternationalActionResult = () =>
  useContext(ActionContext)?.result;
export function InternationalActionProvider({ children, pending = false }) {
  const bridge = useAppBridge();
  const revalidator = useRevalidator();
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const pollStartedAt = useRef(0);
  useEffect(() => {
    if (!pending) {
      pollStartedAt.current = 0;
      return;
    }
    pollStartedAt.current ||= Date.now();
    const timer = setInterval(() => {
      if (
        Date.now() - pollStartedAt.current < 120000 &&
        document.visibilityState === "visible" &&
        revalidator.state === "idle"
      )
        revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [pending, revalidator]);
  async function submit(formData) {
    setError("");
    try {
      const token = await bridge.idToken();
      const response = await fetch("/app/international-shipping-commands", {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}` },
        body: new URLSearchParams([...formData.entries()]),
        signal: AbortSignal.timeout(60000),
      });
      if (!response.headers.get("content-type")?.includes("application/json"))
        throw new Error();
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        setError(
          data.code === "international_verification_not_implemented"
            ? "購入・決済の検証機能が未完成のため、承認できません。"
            : response.status === 409
              ? "更新が競合しました。最新の状態を確認してください。"
              : response.status === 401 || response.status === 403
                ? "操作権限またはログイン状態を確認してください。"
                : "処理できませんでした。証拠・設定・現在の状態を確認してください。",
        );
        setResult(null);
      } else setResult(data);
    } catch {
      setError(
        "応答を確認できませんでした。現在の状態を確認してから、同じ操作を再送してください。",
      );
    }
    revalidator.revalidate();
  }
  return (
    <ActionContext.Provider value={{ submit, result }}>
      {error ? (
        <Banner tone="critical">
          <p>{error}</p>
        </Banner>
      ) : null}
      {result?.ok ? (
        <Banner tone="success">
          <p>
            {result.pending
              ? "要求を受け付けました。反映・保護確認は未完了です。"
              : "処理結果を記録しました。販売開始の承認ではありません。"}
          </p>
        </Banner>
      ) : null}
      {children}
    </ActionContext.Provider>
  );
}
export function InternationalAdminForm({
  children,
  confirmation,
  idempotent = false,
  ...props
}) {
  const context = useContext(ActionContext);
  const [busy, setBusy] = useState(false);
  const requestKey = useRef(null);
  return (
    <form
      {...props}
      method="post"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || (confirmation && !window.confirm(confirmation))) return;
        const form = new FormData(event.currentTarget);
        if (
          form.get("intent") === "previewInternationalAuthorization" &&
          form.get("expiresAt")
        ) {
          const expiry = new Date(form.get("expiresAt"));
          if (Number.isFinite(expiry.getTime()))
            form.set("expiresAt", expiry.toISOString());
        }
        if (idempotent) {
          requestKey.current ||= crypto.randomUUID();
          form.set("requestKey", requestKey.current);
        }
        setBusy(true);
        try {
          await context.submit(form);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset
        disabled={busy}
        aria-busy={busy}
        style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0 }}
      >
        {children}
      </fieldset>
    </form>
  );
}
