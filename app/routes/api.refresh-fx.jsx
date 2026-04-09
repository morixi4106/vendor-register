import { json } from "@remix-run/node";
import { upsertFxRate } from "../utils/fxRates.server";

const API_KEY = process.env.EXCHANGE_RATE_API_KEY;
const TARGET_CURRENCIES = ["USD", "EUR", "GBP", "CNY", "KRW"];

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

    const rates = data?.conversion_rates;

    if (!rates || typeof rates !== "object") {
      return json(
        { ok: false, error: "conversion_rates の取得に失敗しました。" },
        { status: 500 }
      );
    }

    const usdToJpy = Number(rates.JPY);

    if (!Number.isFinite(usdToJpy) || usdToJpy <= 0) {
      return json(
        { ok: false, error: "USD/JPY レートの取得に失敗しました。" },
        { status: 500 }
      );
    }

    const savedRates = [];

    for (const currency of TARGET_CURRENCIES) {
      let rateToJpy;

      if (currency === "USD") {
        rateToJpy = usdToJpy;
      } else if (currency === "JPY") {
        rateToJpy = 1;
      } else {
        const usdToCurrency = Number(rates[currency]);

        if (!Number.isFinite(usdToCurrency) || usdToCurrency <= 0) {
          return json(
            {
              ok: false,
              error: `USD/${currency} レートの取得に失敗しました。`,
            },
            { status: 500 }
          );
        }

        rateToJpy = usdToJpy / usdToCurrency;
      }

      if (!Number.isFinite(rateToJpy) || rateToJpy <= 0) {
        return json(
          {
            ok: false,
            error: `${currency}/JPY レートの計算に失敗しました。`,
          },
          { status: 500 }
        );
      }

      const saved = await upsertFxRate({
        base: currency,
        quote: "JPY",
        rate: rateToJpy,
      });

      savedRates.push(saved);
    }

    return json({
      ok: true,
      message: `${savedRates.length}件の為替レートを更新しました。`,
      fxRates: savedRates,
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