/**
 * purchase.mjs — Compra de saldo (BILLING-COMPRA-3)
 * ESPEC-COMPRA-DE-SALDO.md v3.1, §3.3 y §6 (pasos 1 a 3).
 *
 * POST /api/purchase/create
 *   Autenticación: token de sesión de Supabase del usuario (Authorization: Bearer <access_token>).
 *   Cuerpo: { package_code | amount_usd, currency?='ARS', origin_product?='agora', return_url? }
 *
 * Reglas:
 *   - Quién compra sale de la SESIÓN, nunca del cuerpo del pedido.
 *   - Todos los números los calcula la base (quote_purchase). Se ignora cualquier número que mande el navegador.
 *   - El dólar se consulta en el momento (Banco Central, divisa venta). Si no responde, se usa el último
 *     guardado y el pago queda marcado como «respaldo». Nunca se deja de vender.
 *   - Orden: cotización → cálculo → pago guardado con todo congelado → preferencia de Mercado Pago → se anota.
 *   - Acá NO se acredita nada. Acreditar es de credit_payment (fase 4).
 */

import { randomUUID } from 'crypto';

export const BCRA_USD_URL = 'https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones/USD';
const FX_SOURCE_BCRA      = 'bcra_divisa_venta';
const FX_TIMEOUT_MS       = 5000;
const PREFERENCE_TTL_MIN  = 60;
const ORIGINS             = ['agora', 'amono'];

// Mercado Pago pide fechas con zona horaria. Argentina: UTC-3, sin horario de verano.
export function toMpDate(d) {
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
}

// Respuesta del Banco Central: { results: [ { fecha, detalle: [ { codigoMoneda, tipoCotizacion } ] } ] }
export function parseBcraUsd(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : (payload?.results ? [payload.results] : []);
  let best = null;
  for (const r of results) {
    const det = Array.isArray(r?.detalle) ? r.detalle : [];
    const usd = det.find(x => x?.codigoMoneda === 'USD');
    const rate = Number(usd?.tipoCotizacion);
    if (!usd || !Number.isFinite(rate) || rate <= 0 || typeof r?.fecha !== 'string') continue;
    if (!best || r.fecha > best.date) best = { rate, date: r.fecha };
  }
  if (!best) throw new Error('respuesta del Banco Central sin cotización de USD');
  return best;
}

export function createPurchaseHandler({
  supabaseUrl, serviceKey, mpAccessToken, gatewayUrl, frontendUrl,
  returnOrigins = [], fetchImpl = fetch, now = () => new Date(), uuid = randomUUID,
}) {
  const svcHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const allowedOrigins = new Set();
  for (const o of [frontendUrl, ...returnOrigins]) {
    try { if (o) allowedOrigins.add(new URL(o).origin); } catch { /* se ignora un origen mal escrito */ }
  }

  async function rest(path, { method = 'GET', body, prefer } = {}) {
    const headers = { ...svcHeaders, ...(prefer ? { Prefer: prefer } : {}) };
    const res = await fetchImpl(`${supabaseUrl}/rest/v1/${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  }

  async function userFromToken(token) {
    const res = await fetchImpl(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceKey, Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const u = await res.json();
    return u?.id ? { id: u.id, email: u.email ?? null } : null;
  }

  async function fetchBcraUsd() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FX_TIMEOUT_MS);
    try {
      const res = await fetchImpl(BCRA_USD_URL, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Banco Central respondió ${res.status}`);
      return parseBcraUsd(await res.json());
    } finally {
      clearTimeout(t);
    }
  }

  return async function handlePurchaseCreate(authHeader, body, log) {
    try {
      // 1) Quién compra: la sesión
      const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? '');
      if (!m) return { status: 401, body: { error: 'Falta la sesión' } };
      const user = await userFromToken(m[1].trim());
      if (!user) return { status: 401, body: { error: 'Sesión inválida' } };

      const prof = await rest(`profiles?id=eq.${encodeURIComponent(user.id)}&select=organization_id&limit=1`);
      const organization_id = prof.ok && Array.isArray(prof.data) ? prof.data[0]?.organization_id : null;
      if (!organization_id) return { status: 403, body: { error: 'Usuario sin organización' } };

      // 2) Qué compra (sólo se leen estos campos; cualquier otro número del cuerpo se ignora)
      const packageCode = typeof body?.package_code === 'string' && body.package_code.trim() ? body.package_code.trim() : null;
      const amountRaw   = body?.amount_usd;
      const amountUsd   = amountRaw === undefined || amountRaw === null || amountRaw === '' ? null : Number(amountRaw);
      if ((packageCode === null) === (amountUsd === null)) {
        return { status: 400, body: { error: 'Indicar un paquete o un monto (uno solo)' } };
      }
      if (amountUsd !== null && !Number.isFinite(amountUsd)) return { status: 400, body: { error: 'Monto inválido' } };
      const currency = typeof body?.currency === 'string' && body.currency.trim() ? body.currency.trim().toUpperCase() : 'ARS';
      const origin   = typeof body?.origin_product === 'string' ? body.origin_product : 'agora';
      if (!ORIGINS.includes(origin)) return { status: 400, body: { error: 'Producto de origen inválido' } };

      // 3) A dónde vuelve: sólo a un origen de la lista permitida
      let backUrls;
      if (body?.return_url) {
        let u;
        try { u = new URL(String(body.return_url)); } catch { return { status: 400, body: { error: 'URL de vuelta inválida' } }; }
        if (!allowedOrigins.has(u.origin)) return { status: 400, body: { error: 'URL de vuelta no permitida' } };
        backUrls = { success: u.toString(), failure: u.toString(), pending: u.toString() };
      } else {
        backUrls = { success: `${frontendUrl}/payment/success`, failure: `${frontendUrl}/payment/failure`, pending: `${frontendUrl}/payment/pending` };
      }

      // 4) Sin dirección de aviso o sin credencial no se crea nada
      if (!gatewayUrl) { log('error', 'purchase.no_gateway_url', {}); return { status: 500, body: { error: 'Pagos no disponibles (configuración)' } }; }
      if (!mpAccessToken) { log('error', 'purchase.no_mp_token', {}); return { status: 500, body: { error: 'Pagos no disponibles (configuración)' } }; }

      // 5) Moneda y pasarela
      const cur = await rest(`pricing_currencies?currency=eq.${encodeURIComponent(currency)}&select=currency,gateway,fx_source,enabled&limit=1`);
      const curRow = cur.ok && Array.isArray(cur.data) ? cur.data[0] : null;
      if (!curRow || !curRow.enabled) return { status: 400, body: { error: `Moneda no disponible (${currency})` } };
      if (curRow.gateway !== 'mercadopago') return { status: 400, body: { error: `Pasarela no integrada (${curRow.gateway})` } };

      // 6) El dólar, en el momento. Si no responde: el último guardado (respaldo).
      let fxFallback = false;
      if (currency !== 'USD') {
        if (curRow.fx_source !== FX_SOURCE_BCRA) {
          fxFallback = true;
          log('error', 'purchase.fx_source_unknown', { currency, fx_source: curRow.fx_source });
        } else {
          try {
            const fx = await fetchBcraUsd();
            const ins = await rest('fx_rates', { method: 'POST', prefer: 'return=minimal',
              body: { currency, rate_per_usd: fx.rate, source: FX_SOURCE_BCRA, rate_date: fx.date } });
            if (!ins.ok) throw new Error(`no se pudo guardar la cotización (${ins.status})`);
            log('info', 'purchase.fx_fetched', { currency, rate: fx.rate, rate_date: fx.date });
          } catch (err) {
            fxFallback = true;
            log('warn', 'purchase.fx_fallback', { currency, error: err.message });
          }
        }
      }

      // 7) El cálculo lo hace la base
      const q = await rest('rpc/quote_purchase', { method: 'POST',
        body: { p_currency: currency, p_package_code: packageCode, p_amount_usd: amountUsd } });
      if (!q.ok) {
        const msg = String(q.data?.message ?? '').replace(/^quote_purchase:\s*/, '');
        if (/cotizaci/i.test(msg)) {
          log('error', 'purchase.no_fx_rate', { currency, message: msg });
          return { status: 503, body: { error: 'No hay cotización disponible por el momento' } };
        }
        return { status: 400, body: { error: msg || 'No se pudo cotizar' } };
      }
      const quote = q.data;

      // 8) El pago, con todo congelado, ANTES de hablar con Mercado Pago
      const paymentId = uuid();
      const t0        = now();
      const expiresAt = new Date(t0.getTime() + PREFERENCE_TTL_MIN * 60 * 1000);
      const fxSource  = quote.fx_source ? `${quote.fx_source}${fxFallback ? ':respaldo' : ''}` : null;
      const ins = await rest('payments', { method: 'POST', prefer: 'return=minimal', body: {
        id: paymentId, organization_id, plan_id: null,
        amount: quote.charged, currency: quote.currency, gateway: 'mercadopago', status: 'pending',
        base_usd: quote.base_usd, bonus_usd: quote.bonus_usd, credited_usd: quote.credited_usd,
        package_code: quote.package_code ?? null,
        fx_rate: quote.currency === 'USD' ? null : quote.fx_rate,
        fx_source: fxSource, fx_fetched_at: quote.fx_fetched_at ?? null,
        expires_at: expiresAt.toISOString(), origin_product: origin,
        metadata: { flow: 'compra_v3', user_id: user.id, fx_fallback: fxFallback, fx_rate_id: quote.fx_rate_id ?? null, bonus_pct: quote.bonus_pct },
      } });
      if (!ins.ok) {
        log('error', 'purchase.payment_insert_failed', { organization_id, status: ins.status, error: ins.data });
        return { status: 502, body: { error: 'No se pudo registrar el pago' } };
      }

      // 9) La preferencia de Mercado Pago, por el monto ya fijado, en la moneda de la pasarela
      const usd = n => Number(n).toFixed(2).replace('.', ',');
      const title = Number(quote.bonus_usd) > 0
        ? `Saldo Ágora: US$ ${usd(quote.credited_usd)} (incluye bono de US$ ${usd(quote.bonus_usd)})`
        : `Saldo Ágora: US$ ${usd(quote.credited_usd)}`;
      const mpRes = await fetchImpl('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: { Authorization: `Bearer ${mpAccessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ id: quote.package_code ?? 'monto_libre', title, quantity: 1, unit_price: Number(quote.charged), currency_id: quote.currency }],
          external_reference: paymentId,
          notification_url: `${gatewayUrl}/api/mp/webhook`,
          back_urls: backUrls,
          ...(backUrls.success.startsWith('https://') ? { auto_return: 'approved' } : {}),
          expires: true,
          expiration_date_from: toMpDate(t0),
          expiration_date_to: toMpDate(expiresAt),
          binary_mode: true,
          metadata: { payment_id: paymentId },
        }),
      });
      if (!mpRes.ok) {
        const mpErr = await mpRes.text();
        log('error', 'purchase.mp_preference_failed', { payment_id: paymentId, status: mpRes.status, error: mpErr });
        await rest(`payments?id=eq.${paymentId}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'failed', updated_at: new Date().toISOString() } });
        return { status: 502, body: { error: 'No se pudo crear el cobro en Mercado Pago' } };
      }
      const mp = await mpRes.json();

      const upd = await rest(`payments?id=eq.${paymentId}`, { method: 'PATCH', prefer: 'return=minimal',
        body: { gateway_preference_id: mp.id, updated_at: new Date().toISOString() } });
      if (!upd.ok) log('error', 'purchase.preference_id_not_saved', { payment_id: paymentId, preference_id: mp.id, status: upd.status });

      log('info', 'purchase.created', {
        payment_id: paymentId, preference_id: mp.id, organization_id, origin_product: origin,
        package_code: quote.package_code ?? null, base_usd: quote.base_usd, bonus_usd: quote.bonus_usd,
        credited_usd: quote.credited_usd, charged: quote.charged, currency: quote.currency,
        fx_rate: quote.fx_rate, fx_fallback: fxFallback,
      });

      return { status: 200, body: {
        payment_id: paymentId, preference_id: mp.id, init_point: mp.init_point,
        base_usd: quote.base_usd, bonus_usd: quote.bonus_usd, credited_usd: quote.credited_usd,
        charged: quote.charged, currency: quote.currency,
        fx_rate: quote.currency === 'USD' ? null : quote.fx_rate, fx_fallback: fxFallback,
        expires_at: expiresAt.toISOString(),
      } };
    } catch (err) {
      log('error', 'purchase.unexpected_error', { error: err.message });
      return { status: 500, body: { error: 'Error interno' } };
    }
  };
}
