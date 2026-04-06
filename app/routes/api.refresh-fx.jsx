import { json } from "@remix-run/node";
import { upsertFxRate } from "../utils/fxRates.server";

const API_KEY = process.env.EXCHANGE_RATE_API_KEY;

export const action = async () => {
  try {
    if (!API_KEY) {
      return json(
        { ok: false, error: "EXCHANGE_RATE_API_KEY が設定されていません。" },
        { status: 500 }
      );
    }

    const response = await fetch(
      `https://v6.exchangerate-api.com/v6/${API_KEY}/latest/USD`,
      {
        method: "GET",
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return json(
        {
          ok: false,
          error: data?.["error-type"]
            ? `為替APIエラー: ${data["error-type"]}`
            : "為替APIの取得に失敗しました。",
        },
        { status: 500 }
      );
    }

    const rate = Number(data?.conversion_rates?.JPY);

    if (!Number.isFinite(rate) || rate <= 0) {
      return json(
        { ok: false, error: "USD/JPY レートの取得に失敗しました。" },
        { status: 500 }
      );
    }

    const saved = await upsertFxRate({
      base: "USD",
      quote: "JPY",
      rate,
    });

    return json({
      ok: true,
      message: `USD/JPY を ${saved.rate} に更新しました。`,
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