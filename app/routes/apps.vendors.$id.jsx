export const loader = async ({ params, request }) => {
  if (params.id === "debug-tool") {
    return new Response(JSON.stringify({ ok: true, time: new Date().toISOString() }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response("not debug", { status: 200 });
};