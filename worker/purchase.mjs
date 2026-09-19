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
 *
 * Fase 4 (BILLING-COMPRA-4): además exporta
 *   - parseMpNotification: entiende los avisos de Mercado Pago en sus dos formatos (cuerpo JSON o datos en la dirección).
 *   - readRawBody: lee el cuerpo sin exigir JSON (el aviso viejo llega vacío).
 *   - createNewPaymentCreditor: acredita un pago del flujo nuevo con credit_payment, después de comprobar
 *     que lo cobrado por Mercado Pago coincide exactamente con lo congelado.
 *
 * Fase 5.1 (BILLING-COMPRA-5): createPaymentReconciler — revisión automática de compras pendientes.
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

      // 5b) Validar lo pedido ANTES de consultar el dólar (fase 4): un pedido inválido no suma cotizaciones.
      //     La autoridad sigue siendo quote_purchase; si esta lectura falla, no se bloquea.
      if (amountUsd !== null) {
        if (Number(amountUsd.toFixed(2)) !== amountUsd) return { status: 400, body: { error: 'El monto admite hasta 2 decimales' } };
        const st = await rest('pricing_settings?id=eq.1&select=min_free_usd,max_free_usd&limit=1');
        const lim = st.ok && Array.isArray(st.data) ? st.data[0] : null;
        if (lim && (amountUsd < Number(lim.min_free_usd) || amountUsd > Number(lim.max_free_usd))) {
          return { status: 400, body: { error: `El monto tiene que estar entre US$ ${Number(lim.min_free_usd)} y US$ ${Number(lim.max_free_usd)}` } };
        }
      } else {
        const pk = await rest(`pricing_packages?code=eq.${encodeURIComponent(packageCode)}&active=eq.true&select=code&limit=1`);
        if (pk.ok && Array.isArray(pk.data) && pk.data.length === 0) return { status: 400, body: { error: 'Paquete no disponible' } };
      }

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

// ─── Fase 4 (BILLING-COMPRA-4): aviso de Mercado Pago ─────────────────────────

const MP_ID_RE = /^\d{1,30}$/;

// Lee el cuerpo como texto, sin exigir JSON (el aviso viejo de Mercado Pago llega con el cuerpo vacío).
export function readRawBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > limit) { reject(new Error('cuerpo demasiado grande')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Entiende los formatos de aviso de Mercado Pago:
//   - Webhook:      cuerpo {"type":"payment","data":{"id":"123"}}  (y/o ?type=payment&data.id=123)
//   - IPN (viejo):  ?topic=payment&id=123, cuerpo vacío; o cuerpo {"topic":"payment","resource":".../123"}
// Devuelve { type, id } con id sólo si es numérico (va dentro de una dirección de la API).
export function parseMpNotification(rawBody, reqUrl) {
  let body = null;
  if (typeof rawBody === 'string' && rawBody.trim()) {
    try { body = JSON.parse(rawBody); } catch { body = null; }
  }
  let q;
  try { q = new URL(reqUrl ?? '/', 'http://localhost').searchParams; } catch { q = new URLSearchParams(); }

  const type = (body && (body.type ?? body.topic)) ?? q.get('type') ?? q.get('topic') ?? null;

  let id = body?.data?.id ?? q.get('data.id') ?? q.get('id') ?? null;
  if ((id === null || id === undefined) && typeof body?.resource === 'string') {
    id = body.resource.split('/').filter(Boolean).pop() ?? null;
  }
  id = id === null || id === undefined ? null : String(id).trim();
  if (id !== null && !MP_ID_RE.test(id)) id = null;

  return { type: type === null ? null : String(type), id, format: body ? 'json' : 'query' };
}

// Acredita un pago del flujo nuevo (tiene base_usd). Nunca le cree al aviso: `payment` es lo que devolvió
// la API de Mercado Pago, y se compara con lo que congelamos al crear el pago.
// Devuelve { status, body } para responderle a Mercado Pago: 500 = «reintentá», 200 = no reintentar.
export function createNewPaymentCreditor({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  return async function creditNewPayment({ localPayment, payment, paymentId, log, source = 'webhook' }) {
    const ctx = { paymentId, localId: localPayment.id, source };

    if (localPayment.status === 'review') {
      log('warn', 'mp.webhook.in_review', ctx);
      return { status: 200, body: { ok: false, reason: 'in_review' } };
    }

    const mpAmount   = Number(payment?.transaction_amount);
    const ourAmount  = Number(localPayment.amount);
    const sameAmount = Number.isFinite(mpAmount) && Number.isFinite(ourAmount) && Math.abs(mpAmount - ourAmount) < 0.005;
    const sameCur    = String(payment?.currency_id ?? '') === String(localPayment.currency ?? '');
    const sameRef    = !payment?.external_reference || String(payment.external_reference) === String(localPayment.id);

    if (!sameAmount || !sameCur || !sameRef) {
      log('error', 'mp.webhook.amount_mismatch', { ...ctx,
        mp_amount: payment?.transaction_amount, mp_currency: payment?.currency_id, mp_external_reference: payment?.external_reference,
        our_amount: localPayment.amount, our_currency: localPayment.currency });
      // Queda en «review»: credit_payment no acredita ese estado. Lo mira una persona.
      const meta = { ...(localPayment.metadata ?? {}), review: {
        reason: !sameAmount ? 'monto' : (!sameCur ? 'moneda' : 'referencia'),
        mp_payment_id: String(paymentId), mp_amount: payment?.transaction_amount ?? null, mp_currency: payment?.currency_id ?? null,
        at: new Date().toISOString() } };
      const r = await fetchImpl(`${supabaseUrl}/rest/v1/payments?id=eq.${encodeURIComponent(localPayment.id)}`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'review', metadata: meta, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) {
        log('error', 'mp.webhook.review_mark_failed', { ...ctx, status: r.status });
        return { status: 500, body: { ok: false } };
      }
      return { status: 200, body: { ok: false, reason: 'mismatch' } };
    }

    let res, text;
    try {
      res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/credit_payment`, {
        method: 'POST', headers,
        body: JSON.stringify({ p_payment_id: localPayment.id, p_gateway_payment_id: String(paymentId) }),
      });
      text = await res.text();
    } catch (err) {
      log('error', 'mp.webhook.credit_failed', { ...ctx, error: err.message });
      return { status: 500, body: { ok: false } };
    }

    if (!res.ok) {
      // El mismo número de pago de Mercado Pago ya está en OTRO pago: reintentar no lo arregla.
      if (/duplicate key|23505/i.test(text)) {
        log('error', 'mp.webhook.gateway_id_conflict', { ...ctx, error: text.slice(0, 300) });
        return { status: 200, body: { ok: false, reason: 'conflict' } };
      }
      log('error', 'mp.webhook.credit_failed', { ...ctx, status: res.status, error: text.slice(0, 300) });
      return { status: 500, body: { ok: false } };
    }

    let out = null;
    try { out = JSON.parse(text); } catch { out = null; }
    if (out?.status === 'already_credited') {
      log('info', 'mp.webhook.already_credited', ctx);
    } else {
      log('info', 'mp.webhook.credited', { ...ctx, organization_id: out?.organization_id, credited_usd: out?.credited_usd,
        balance_before: out?.balance_before, balance_after: out?.balance_after });
    }
    return { status: 200, body: { ok: true, result: out?.status === 'already_credited' ? 'already_credited' : 'credited' } };
  };
}

// ─── Fase 5.1 (BILLING-COMPRA-5): revisión automática de compras pendientes ───
// Red de seguridad por si el aviso de Mercado Pago no llega. Cada tanto:
//   compras nuevas (base_usd) todavía pendientes y recientes → se busca en Mercado Pago por su referencia.
//   Si alguna está APROBADA, se acredita con la misma lógica del aviso (compara montos → credit_payment,
//   que no carga dos veces) y el pago queda marcado metadata.credited_by = 'reconcile'
//   (la vigilancia horaria lo ve: quiere decir que el aviso falló).
// Sólo lee de Mercado Pago; nunca crea ni modifica nada allá.
export function createPaymentReconciler({
  supabaseUrl, serviceKey, mpAccessToken, creditNewPayment,
  fetchImpl = fetch, now = () => new Date(), lookbackHours = 72, maxPerRun = 50,
}) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  let running = false;

  return async function reconcileOnce(log) {
    if (running) return { skipped: true };
    running = true;
    const summary = { checked: 0, credited: 0, errors: 0 };
    try {
      if (!mpAccessToken) { log('error', 'mp.reconcile.no_token', {}); summary.errors++; return summary; }
      const since = new Date(now().getTime() - lookbackHours * 3600 * 1000).toISOString();
      const res = await fetchImpl(`${supabaseUrl}/rest/v1/payments?base_usd=not.is.null&status=eq.pending&credits_accrued=eq.false`
        + `&created_at=gte.${encodeURIComponent(since)}`
        + `&select=id,organization_id,plan_id,amount,currency,status,gateway_payment_id,metadata,base_usd`
        + `&order=created_at.asc&limit=${maxPerRun}`, { headers });
      if (!res.ok) { summary.errors++; log('error', 'mp.reconcile.db_failed', { status: res.status }); return summary; }
      const rows = await res.json();

      for (const row of Array.isArray(rows) ? rows : []) {
        summary.checked++;
        let found;
        try {
          const r = await fetchImpl(`https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(row.id)}`
            + `&sort=date_created&criteria=desc&limit=10`, { headers: { Authorization: `Bearer ${mpAccessToken}` } });
          if (!r.ok) { summary.errors++; log('warn', 'mp.reconcile.search_failed', { localId: row.id, status: r.status }); continue; }
          found = await r.json();
        } catch (err) {
          summary.errors++; log('warn', 'mp.reconcile.search_failed', { localId: row.id, error: err.message }); continue;
        }
        const approved = (Array.isArray(found?.results) ? found.results : [])
          .find(p => p?.status === 'approved' && String(p?.external_reference ?? '') === String(row.id));
        if (!approved) continue;

        const out = await creditNewPayment({ localPayment: row, payment: approved, paymentId: approved.id, log, source: 'reconcile' });
        if (out?.body?.result === 'credited') {
          summary.credited++;
          log('warn', 'mp.reconcile.credited', { localId: row.id, paymentId: approved.id });
          const meta = { ...(row.metadata ?? {}), credited_by: 'reconcile', reconciled_at: now().toISOString() };
          const p = await fetchImpl(`${supabaseUrl}/rest/v1/payments?id=eq.${encodeURIComponent(row.id)}`, {
            method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ metadata: meta }),
          });
          if (!p.ok) log('error', 'mp.reconcile.mark_failed', { localId: row.id, status: p.status });
        } else if ((out?.status ?? 500) >= 500) {
          summary.errors++;
        }
      }
      if (summary.checked) log('info', 'mp.reconcile.done', summary);
      return summary;
    } catch (err) {
      summary.errors++; log('error', 'mp.reconcile.error', { error: err.message }); return summary;
    } finally {
      running = false;
    }
  };
}
