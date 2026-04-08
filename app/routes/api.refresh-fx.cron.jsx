import { json } from "@remix-run/node";

export const loader = async () => {
  try {
    const res = await fetch(
      `${process.env.APP_URL}/api/refresh-fx`,
      {
        method: "POST",
      }
    );

    const data = await res.json();

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