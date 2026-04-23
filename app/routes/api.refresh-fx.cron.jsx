import { json } from "@remix-run/node";

export const loader = async () => {
  try {
    const res = await fetch(
      `${process.env.APP_URL}/api/refresh-fx?autoApplyPrices=1`,
      {
        method: "POST",
      }
    );

    const data = await res.json();

    if (!res.ok || !data?.ok) {
      return json(
        {
          ok: false,
          error: data?.error || "FX refresh cron failed",
          result: data,
        },
        { status: res.status || 500 }
      );
    }

    return json({
      ok: true,
      result: data,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "不明なエラー",
      },
      { status: 500 }
    );
  }
};
