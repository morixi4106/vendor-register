import { json } from "@remix-run/node";
import { upsertFxRate } from "../utils/fxRates.server";

export const action = async ({ request }) => {
  try {
    const formData = await request.formData();

    const base = String(formData.get("base") || "").trim().toUpperCase();
    const quote = String(formData.get("quote") || "JPY").trim().toUpperCase();
    const rateRaw = String(formData.get("rate") || "").trim();

    if (!base) {
      return json(
        { ok: false, error: "base が必要です。" },
        { status: 400 }
      );
    }

    if (!quote) {
      return json(
        { ok: false, error: "quote が必要です。" },
        { status: 400 }
      );
    }

    const rate = Number(rateRaw);

    if (!Number.isFinite(rate) || rate <= 0) {
      return json(
        { ok: false, error: "為替レートを正しく入力してください。" },
        { status: 400 }
      );
    }

    const saved = await upsertFxRate({
      base,
      quote,
      rate,
    });

    return json({
      ok: true,
      message: `${saved.base}/${saved.quote} の為替レートを ${saved.rate} に更新しました。`,
      fxRate: saved,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "不明なエラーです。",
      },
      { status: 500 }
    );
  }
};