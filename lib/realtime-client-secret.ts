type ClientSecretPayload = {
  value?: unknown;
  expires_at?: unknown;
};

export async function createClientSecretResponse(upstream: Response) {
  const payloadText = await upstream.text();
  if (!upstream.ok) {
    return new Response(payloadText, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      },
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText) as unknown;
  } catch {
    return Response.json(
      { error: "OpenAI returned an invalid client secret response." },
      { status: 502 },
    );
  }

  if (!payload || typeof payload !== "object" || !("value" in payload)) {
    return Response.json(
      { error: "OpenAI did not return a client secret." },
      { status: 502 },
    );
  }

  const secret = payload as ClientSecretPayload;
  if (typeof secret.value !== "string") {
    return Response.json(
      { error: "OpenAI did not return a client secret." },
      { status: 502 },
    );
  }

  return Response.json({
    value: secret.value,
    ...(typeof secret.expires_at === "number"
      ? { expires_at: secret.expires_at }
      : {}),
  });
}
