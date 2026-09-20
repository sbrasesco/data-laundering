// APAGADA el 2026-09-20 (BILLING-COMPRA-5.6).
// Era la puerta de cobro de junio: cobraba los precios en pesos de billing_plans
// y la podía llamar cualquier usuario logueado. Ninguna pantalla la usa.
// La compra de saldo se hace por el gateway: POST https://api.agoradigital.io/api/purchase/create
// Código original (v13): supabase/functions/_legacy/create-payment-preference.v13.ts
// Desplegada con verify_jwt = true (igual que antes).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  console.log("create-payment-preference apagada: pedido rechazado", JSON.stringify({ method: req.method }));
  return new Response(
    JSON.stringify({ error: "Fuera de servicio. La compra de saldo se hace desde la app, en Recargar saldo." }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
