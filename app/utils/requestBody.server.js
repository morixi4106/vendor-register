export async function readBoundedRequestBody(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Response("Request too large", {
          status: 413,
          headers: { "Cache-Control": "no-store" },
        });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedFormData(request, maxBytes = 32000) {
  const bytes = await readBoundedRequestBody(request, maxBytes);
  return new Response(bytes, {
    headers: {
      "Content-Type":
        request.headers.get("content-type") ||
        "application/x-www-form-urlencoded",
    },
  }).formData();
}
