import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5173";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: { user }, error: userError } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (userError || !user) return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile, error: profileError } = await serviceClient.from("profiles").select("organization_id").eq("id", user.id).single();
    if (profileError || !profile?.organization_id) return new Response(JSON.stringify({ error: "Profile not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const body = await req.json();
    const { plan_id } = body;
    if (!plan_id) return new Response(JSON.stringify({ error: "plan_id is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: plan, error: planError } = await serviceClient.from("billing_plans").select("*").eq("id", plan_id).eq("active", true).single();
    if (planError || !plan) return new Response(JSON.stringify({ error: "Plan not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (!plan.price || Number(plan.price) === 0) return new Response(JSON.stringify({ error: "Free plan does not require payment" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const isHttps = APP_URL.startsWith("https://");
    const preference: Record<string, unknown> = {
      items: [{ title: `Plan ${plan.display_name}`, quantity: 1, currency_id: plan.currency ?? "ARS", unit_price: Number(plan.price) }],
      back_urls: { success: `${APP_URL}/payment/success`, failure: `${APP_URL}/payment/failure`, pending: `${APP_URL}/payment/pending` },
    };
    if (isHttps) preference.auto_return = "approved";

    const mpResponse = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(preference),
    });

    if (!mpResponse.ok) {
      const mpError = await mpResponse.text();
      console.error("MP API error:", mpResponse.status, mpError);
      return new Response(JSON.stringify({ error: "Payment gateway error", detail: mpError }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const mpData = await mpResponse.json();
    const { data: payment, error: paymentError } = await serviceClient.from("payments").insert({
      organization_id: profile.organization_id, plan_id: plan.id, amount: Number(plan.price),
      currency: plan.currency ?? "ARS", gateway: "mercadopago", gateway_preference_id: mpData.id,
      status: "pending", metadata: { preference: mpData },
    }).select("id").single();

    if (paymentError) {
      console.error("DB insert error:", paymentError);
      return new Response(JSON.stringify({ error: "Failed to create payment record" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ payment_id: payment.id, preference_id: mpData.id, init_point: mpData.init_point, sandbox_init_point: mpData.sandbox_init_point }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
