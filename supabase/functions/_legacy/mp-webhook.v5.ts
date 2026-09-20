import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req: Request) => {
  // MP sends GET to verify the URL on setup — acknowledge it
  if (req.method === "GET") {
    return new Response("OK", { status: 200 });
  }

  if (req.method !== "POST") {
    return new Response("OK", { status: 200 });
  }

  try {
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const dataId = url.searchParams.get("data.id");

    const rawBody = await req.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(rawBody);
    } catch {
      // ignore parse errors
    }

    console.log("MP webhook received:", JSON.stringify({ type, dataId, body }));

    // Normalize: MP sends type + data.id as query params (IPN) or in body
    const paymentId = dataId || (body?.data as Record<string, unknown>)?.id as string;
    const notificationType = type || (body?.type as string);

    // Acknowledge non-payment notifications immediately
    if (notificationType !== "payment" || !paymentId) {
      console.log(`Non-payment notification type=${notificationType}, ignoring.`);
      return new Response("OK", { status: 200 });
    }

    // Fetch payment details from MP API
    const mpResponse = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        },
      }
    );

    if (!mpResponse.ok) {
      const errText = await mpResponse.text();
      console.error(`Failed to fetch MP payment ${paymentId}:`, mpResponse.status, errText);
      if (mpResponse.status === 401 || mpResponse.status === 403) {
        return new Response("OK", { status: 200 });
      }
      return new Response("Error", { status: 500 });
    }

    const mpPayment = await mpResponse.json();
    const status = mpPayment.status as string;
    const preferenceId = mpPayment.preference_id as string;

    console.log(`Payment ${paymentId}: status=${status}, preference=${preferenceId}`);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Upsert payment record — idempotent via gateway_payment_id unique index
    const { data: updated, error: updateError } = await supabase
      .from("payments")
      .update({
        gateway_payment_id: String(paymentId),
        status,
        metadata: { mp_payment: mpPayment },
        updated_at: new Date().toISOString(),
      })
      .eq("gateway_preference_id", preferenceId)
      .is("gateway_payment_id", null)
      .select("id");

    if (updateError) {
      console.error("DB update error (first attempt):", updateError);
    }

    if (!updated || updated.length === 0) {
      const { error: retryError } = await supabase
        .from("payments")
        .update({
          status,
          metadata: { mp_payment: mpPayment },
          updated_at: new Date().toISOString(),
        })
        .eq("gateway_payment_id", String(paymentId));

      if (retryError) {
        console.error("DB update error (retry):", retryError);
        return new Response("Error", { status: 500 });
      }
    }

    // Acreditación automática de créditos
    if (status === "approved") {
      const { data: payment, error: paymentFetchError } = await supabase
        .from("payments")
        .select("id, organization_id, plan_id, credits_accrued, metadata")
        .eq("gateway_payment_id", String(paymentId))
        .single();

      if (paymentFetchError || !payment) {
        console.error("Could not fetch payment record for credit accrual:", paymentFetchError);
        return new Response("OK", { status: 200 });
      }

      if (payment.credits_accrued) {
        console.log(`Credits already accrued for payment ${paymentId} — skipping (idempotent).`);
        return new Response("OK", { status: 200 });
      }

      let creditAmount: number;
      let planLabel: string;
      let planId: string | null;

      if (!payment.plan_id) {
        // Compra de créditos personalizada — el monto está en metadata.custom_credits
        const meta = payment.metadata as Record<string, unknown> | null;
        const customCredits = meta?.custom_credits;
        if (typeof customCredits !== "number" || customCredits < 1) {
          console.error("No plan_id and no valid custom_credits in metadata", meta);
          return new Response("OK", { status: 200 });
        }
        creditAmount = customCredits;
        planLabel = `${customCredits} créditos personalizados`;
        planId = null;
      } else {
        // Compra de plan estándar
        const { data: plan, error: planError } = await supabase
          .from("billing_plans")
          .select("docs_included, display_name")
          .eq("id", payment.plan_id)
          .single();

        if (planError || !plan) {
          console.error("Could not fetch billing plan for credit accrual:", planError);
          return new Response("OK", { status: 200 });
        }
        creditAmount = plan.docs_included;
        planLabel = plan.display_name;
        planId = payment.plan_id;
      }

      // Acreditar créditos via función DB (atómica)
      const { error: addError } = await supabase.rpc("add_credits", {
        p_organization_id: payment.organization_id,
        p_amount: creditAmount,
        p_plan_id: planId,
        p_description: `Compra ${planLabel} — pago MP ${paymentId}`,
        p_gateway_payment_id: String(paymentId),
      });

      if (addError) {
        console.error("Error acreditando créditos:", addError);
        return new Response("Error", { status: 500 });
      }

      // Marcar como acreditado (flag de idempotencia)
      const { error: flagError } = await supabase
        .from("payments")
        .update({ credits_accrued: true, updated_at: new Date().toISOString() })
        .eq("id", payment.id);

      if (flagError) {
        console.error("Error seteando credits_accrued:", flagError);
      }

      console.log(`Credits accrued: org=${payment.organization_id}, amount=${creditAmount}, label=${planLabel}, payment=${paymentId}`);
    }

    console.log(`Payment ${paymentId} processed successfully. status=${status}`);
    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("Unexpected webhook error:", err);
    return new Response("OK", { status: 200 });
  }
});
