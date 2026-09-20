// APAGADA el 2026-09-20 (BILLING-COMPRA-5.6).
// Era el receptor de avisos de Mercado Pago de junio: marcaba pagos como aprobados
// pisando sus datos y acreditaba documentos como si fueran dólares.
// Los avisos de la compra nueva van al gateway (notification_url de cada preferencia),
// que acredita con credit_payment.
// Esta versión NO toca la base: contesta 200 para que Mercado Pago no reintente
// y deja una línea en el log para saber si Mercado Pago todavía le manda avisos.
// Código original (v5): supabase/functions/_legacy/mp-webhook.v5.ts
// Desplegada con verify_jwt = false (igual que antes: Mercado Pago no manda token).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  let bodyType: unknown = null;
  let bodyDataId: unknown = null;
  if (req.method === "POST") {
    try {
      const body = JSON.parse(await req.text());
      bodyType = body?.type ?? body?.topic ?? null;
      bodyDataId = body?.data?.id ?? null;
    } catch {
      // cuerpo vacío o que no es JSON
    }
  }
  console.log("mp-webhook apagada: aviso recibido y descartado", JSON.stringify({
    method: req.method,
    type: url.searchParams.get("type") ?? url.searchParams.get("topic") ?? bodyType,
    data_id: url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? bodyDataId,
  }));
  return new Response("OK", { status: 200 });
});
