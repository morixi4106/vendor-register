export const action = async ({ request }) => {
  const body = await request.text();
  console.log("🔥 webhook raw:", body);

  return new Response("OK", { status: 200 });
};