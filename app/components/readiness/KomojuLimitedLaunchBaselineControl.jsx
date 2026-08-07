import { Form } from "@remix-run/react";

export function KomojuLimitedLaunchBaselineControl({
  actionResult,
  isSubmitting,
}) {
  return (
    <>
      <Form method="post">
        <input
          type="hidden"
          name="intent"
          value="prepare_komoju_limited_launch_baseline"
        />
        <button
          className="readiness-button"
          type="submit"
          disabled={isSubmitting}
          title="Shopifyの限定公開制御を恒久的なINACTIVE基準値へ同期し、読み戻して確認します"
        >
          {isSubmitting
            ? "INACTIVE基準値を確認中"
            : "INACTIVE基準値を同期・確認"}
        </button>
      </Form>
      <p className="readiness-tool__text">
        INACTIVE基準値は、限定公開を使っていない通常時のShopify側フェイルクローズ基準です。Functionの公開前と再導入時に同期・読み戻し確認を行います。
      </p>
      {actionResult ? (
        <div
          className={`readiness-result ${
            actionResult.ok ? "" : "readiness-result--error"
          }`}
        >
          {actionResult.ok
            ? "KOMOJU限定公開のINACTIVE基準値を同期し、Shopifyからの読み戻しを確認しました。"
            : `INACTIVE基準値を確認できませんでした: ${
                actionResult.reason || "unknown"
              }`}
        </div>
      ) : null}
    </>
  );
}
