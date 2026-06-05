/**
 * gateway.mjs — Input Gateway: POST /api/enqueue
 * Data Laundering V2.0 — TASK-37
 *
 * Punto de entrada único al pipeline. Cualquier origen (frontend, Drive, FTP,
 * API directa) llama a este endpoint para encolar un job en BullMQ.
 *
 * Puerto: GATEWAY_PORT (default: 3001)
 * Auth:   Authorization: Bearer <GATEWAY_API_KEY>
 *
 * TASK-70: Agrega GET /api/auth/google/callback — OAuth 2.0 para Google Drive.
 *          Esta ruta está EXENTA de auth (Google no envía nuestro API key).
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';

const GATEWAY_PORT       = Number(process.env.GATEWAY_PORT ?? 3001);
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_KEY;
const GATEWAY_API_KEY    = process.env.GATEWAY_API_KEY;
const MP_ACCESS_TOKEN    = process.env.MP_ACCESS_TOKEN;
const FRONTEND_URL       = process.env.FRONTEND_URL ?? 'http://localhost:5173';

// ── TASK-70: Google OAuth ────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI
  ?? 'http://localhost:3001/api/auth/google/callback';

const VALID_FILE_TYPES = ['zip', 'rar', 'pdf', 'jpg', 'jpeg', 'png'];
const VALID_SOURCES    = ['frontend_upload', 'integration_drive', 'integration_remote', 'api_direct'];
const UUID_RE          = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUID(v) { return UUID_RE.test(v); }

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type, Authorization',
  });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ─── TASK-70: Google OAuth helpers ──────────────────────────────────────────

/**
 * Crea la subcarpeta /procesados/ dentro de folderId si no existe.
 */
async function createProcessadosFolder(accessToken, folderId) {
  // Verificar si ya existe
  const q = encodeURIComponent(
    `'${folderId}' in parents and name = 'procesados' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (searchRes.ok) {
    const { files } = await searchRes.json();
    if (files && files.length > 0) return; // ya existe
  }
  // Crear carpeta
  await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name:     'procesados',
      mimeType: 'application/vnd.google-apps.folder',
      parents:  [folderId],
    }),
  });
}

/**
 * GET /api/auth/google/callback
 * Recibe el code de Google, hace exchange, guarda refresh_token en Supabase.
 * State: base64url({ orgId, integrationId, folderId })
 */
async function handleGoogleOAuthCallback(req, log) {
  const url      = new URL(req.url, 'http://localhost');
  const code     = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const oauthErr = url.searchParams.get('error');

  const errRedirect = (msg) =>
    `${FRONTEND_URL}/integrations?google_error=${encodeURIComponent(msg)}`;

  if (oauthErr) {
    log('warn', 'google_oauth.user_denied', { error: oauthErr });
    return errRedirect(oauthErr);
  }
  if (!code || !stateRaw) return errRedirect('missing_params');

  let state;
  try {
    state = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf-8'));
  } catch {
    return errRedirect('invalid_state');
  }

  const { orgId, integrationId, folderId } = state;
  if (!orgId || !integrationId) return errRedirect('invalid_state');

  // 1. Exchange code → tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  GOOGLE_REDIRECT_URI,
      grant_type:    'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    log('error', 'google_oauth.token_exchange_failed', { integrationId, status: tokenRes.status, error: err });
    return errRedirect('token_exchange_failed');
  }

  const tokens = await tokenRes.json();

  if (!tokens.refresh_token) {
    // Ocurre si el usuario ya autorizó antes y prompt=consent no forzó nueva emisión
    log('warn', 'google_oauth.no_refresh_token', { integrationId });
    return errRedirect('no_refresh_token');
  }

  // 2. Obtener credenciales actuales para merge
  const getRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tenant_integrations?id=eq.${integrationId}&organization_id=eq.${orgId}&select=credentials`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!getRes.ok) {
    log('error', 'google_oauth.get_integration_failed', { integrationId, status: getRes.status });
    return errRedirect('db_error');
  }
  const rows = await getRes.json();
  if (!rows.length) {
    log('error', 'google_oauth.integration_not_found', { integrationId });
    return errRedirect('integration_not_found');
  }
  const [row] = rows;

  // Merge: preservar folder_id, remover service_account_json si existía
  const creds = { ...(row.credentials ?? {}) };
  delete creds.service_account_json;
  creds.oauth_refresh_token = tokens.refresh_token;

  // 3. Guardar en Supabase
  const patchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tenant_integrations?id=eq.${integrationId}&organization_id=eq.${orgId}`,
    {
      method:  'PATCH',
      headers: {
        apikey:          SUPABASE_KEY,
        Authorization:  `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ credentials: creds }),
    }
  );

  if (!patchRes.ok) {
    const err = await patchRes.text();
    log('error', 'google_oauth.save_token_failed', { integrationId, error: err });
    return errRedirect('save_failed');
  }

  // 4. Crear subcarpeta /procesados/ (no bloqueante)
  if (folderId && tokens.access_token) {
    try {
      await createProcessadosFolder(tokens.access_token, folderId);
      log('info', 'google_oauth.procesados_created', { integrationId, folderId });
    } catch (err) {
      log('warn', 'google_oauth.procesados_failed', { integrationId, error: err.message });
    }
  }

  log('info', 'google_oauth.connected', { integrationId, orgId });
  return `${FRONTEND_URL}/integrations?google_connected=true`;
}

// ─── Handlers existentes ─────────────────────────────────────────────────────

/**
 * Crea el registro en pdf_jobs y encola en BullMQ.
 * Idempotente: si se llama dos veces con los mismos datos, BullMQ no duplica.
 */
async function handleEnqueue(body, queue, log) {
  const {
    organization_id, file_url, file_type, original_filename,
    client_cuit = null, client_name = null, input_source,
    job_id: provided_job_id = null,
  } = body;

  // ── Validaciones ─────────────────────────────────────────────────────────
  if (!organization_id || !file_url || !file_type || !original_filename || !input_source) {
    return { status: 400, body: { error: 'Campos requeridos: organization_id, file_url, file_type, original_filename, input_source' } };
  }
  if (!isUUID(organization_id)) {
    return { status: 400, body: { error: 'organization_id debe ser un UUID válido' } };
  }
  if (!VALID_FILE_TYPES.includes(file_type)) {
    return { status: 400, body: { error: `file_type inválido. Valores aceptados: ${VALID_FILE_TYPES.join(', ')}` } };
  }
  if (!VALID_SOURCES.includes(input_source)) {
    return { status: 400, body: { error: `input_source inválido. Valores aceptados: ${VALID_SOURCES.join(', ')}` } };
  }
  if (!file_url.startsWith('https://')) {
    return { status: 400, body: { error: 'file_url debe ser una URL HTTPS' } };
  }

  // ── Verificar saldo de créditos (TASK-15) ────────────────────────────────
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const credRes = await fetch(
        `${SUPABASE_URL}/rest/v1/organization_credits?organization_id=eq.${encodeURIComponent(organization_id)}&select=balance`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      if (credRes.ok) {
        const credData = await credRes.json();
        const balance = credData?.[0]?.balance ?? 0;
        if (balance < 1) {
          log('warn', 'gateway.insufficient_credits', { organization_id });
          return { status: 402, body: { error: 'INSUFFICIENT_CREDITS', message: 'Saldo insuficiente para procesar este job.' } };
        }
      }
    } catch (err) {
      log('warn', 'gateway.credits_check_failed', { organization_id, error: err.message });
    }
  }

  // ── Encolar en BullMQ ─────────────────────────────────────────────────────
  const job_id = (provided_job_id && isUUID(provided_job_id)) ? provided_job_id : randomUUID();
  const payload = {
    job_id,
    organization_id,
    file_url,
    file_type,
    file_hash: 'pending',
    original_filename,
    file_size_bytes: 0,
    client_cuit,
    client_name,
    oc_entries: [],
    priority: 5,
    metadata: {
      source: input_source,
      worker_version: process.env.WORKER_VERSION ?? 'unknown',
    },
  };

  await queue.add('process-pdf', payload, {
    jobId: job_id,
    priority: 5,
  });

  log('info', 'gateway.enqueued', { job_id, organization_id, file_type, input_source });

  return { status: 200, body: { job_id, queued: true } };
}

/**
 * POST /api/mp/create-preference — crea preferencia de pago en MercadoPago.
 */
async function handleCreateMpPreference(body, log) {
  const { plan_id, user_id } = body ?? {};

  if (!plan_id || !user_id) {
    return { status: 400, body: { error: 'Campos requeridos: plan_id, user_id' } };
  }
  if (!isUUID(plan_id) || !isUUID(user_id)) {
    return { status: 400, body: { error: 'plan_id y user_id deben ser UUIDs válidos' } };
  }
  if (!MP_ACCESS_TOKEN) {
    return { status: 500, body: { error: 'MP_ACCESS_TOKEN no configurado en el servidor' } };
  }

  // ── 0. Resolver organization_id desde user_id ─────────────────────────────
  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user_id)}&select=organization_id&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!profileRes.ok) {
    log('error', 'mp.profile_fetch_error', { user_id, status: profileRes.status });
    return { status: 502, body: { error: 'Error consultando profiles en Supabase' } };
  }
  const profiles = await profileRes.json();
  if (!profiles.length || !profiles[0].organization_id) {
    return { status: 404, body: { error: 'Perfil de usuario no encontrado o sin organización asociada' } };
  }
  const organization_id = profiles[0].organization_id;

  // ── 1. Consultar plan en Supabase ─────────────────────────────────────────
  const planRes = await fetch(
    `${SUPABASE_URL}/rest/v1/billing_plans?id=eq.${encodeURIComponent(plan_id)}&active=eq.true&select=id,display_name,price,currency&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!planRes.ok) {
    log('error', 'mp.plan_fetch_error', { plan_id, status: planRes.status });
    return { status: 502, body: { error: 'Error consultando billing_plans en Supabase' } };
  }
  const plans = await planRes.json();
  if (!plans.length) {
    return { status: 404, body: { error: 'Plan no encontrado o inactivo' } };
  }
  const plan = plans[0];

  // ── 2. Crear preferencia en MercadoPago ───────────────────────────────────
  const mpBody = {
    items: [{
      title:      plan.display_name,
      quantity:   1,
      unit_price: Number(plan.price),
      currency_id: plan.currency,
    }],
    back_urls: {
      success: `${FRONTEND_URL}/payment/success`,
      failure: `${FRONTEND_URL}/payment/failure`,
      pending: `${FRONTEND_URL}/payment/pending`,
    },
    ...(FRONTEND_URL.startsWith('https://') ? { auto_return: 'approved' } : {}),
    external_reference: organization_id,
  };

  const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(mpBody),
  });

  if (!mpRes.ok) {
    const mpErr = await mpRes.text();
    log('error', 'mp.preference_error', { plan_id, organization_id, status: mpRes.status, error: mpErr });
    return { status: 502, body: { error: 'Error creando preferencia en MercadoPago', detail: mpErr } };
  }
  const mpData = await mpRes.json();

  // ── 3. Insertar en tabla payments ─────────────────────────────────────────
  const paymentPayload = {
    organization_id,
    plan_id,
    amount:               Number(plan.price),
    currency:             plan.currency,
    gateway:              'mercadopago',
    gateway_preference_id: mpData.id,
    status:               'pending',
  };

  const payRes = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
    method:  'POST',
    headers: {
      'apikey':          SUPABASE_KEY,
      'Authorization':  `Bearer ${SUPABASE_KEY}`,
      'Content-Type':   'application/json',
      'Prefer':         'return=representation',
    },
    body: JSON.stringify(paymentPayload),
  });

  if (!payRes.ok) {
    const payErr = await payRes.text();
    log('error', 'mp.payment_insert_error', { organization_id, plan_id, status: payRes.status, error: payErr });
    return { status: 502, body: { error: 'Error insertando payment en Supabase', detail: payErr } };
  }
  const [payment] = await payRes.json();

  log('info', 'mp.preference_created', {
    payment_id:    payment.id,
    preference_id: mpData.id,
    organization_id,
    user_id,
    plan_id,
  });

  return {
    status: 200,
    body: {
      payment_id:         payment.id,
      preference_id:      mpData.id,
      init_point:         mpData.init_point,
      sandbox_init_point: mpData.sandbox_init_point,
    },
  };
}

/**
 * Inicia el servidor HTTP del Input Gateway.
 */
export function startGateway(queue, log) {
  const server = createServer(async (req, res) => {

    // ── Preflight CORS ─────────────────────────────────────────────────────
    if (req.method === 'OPTIONS') {
      return json(res, 204, {});
    }

    // ── TASK-70: OAuth callback — EXENTO de auth (Google no envía API key) ─
    if (req.method === 'GET' && req.url?.startsWith('/api/auth/google/callback')) {
      try {
        const redirectUrl = await handleGoogleOAuthCallback(req, log);
        return redirect(res, redirectUrl);
      } catch (err) {
        log('error', 'google_oauth.callback_error', { error: err.message });
        return redirect(res, `${FRONTEND_URL}/integrations?google_error=server_error`);
      }
    }

    // ── Autenticación ──────────────────────────────────────────────────────
    if (GATEWAY_API_KEY) {
      const auth = req.headers['authorization'] ?? '';
      if (auth !== `Bearer ${GATEWAY_API_KEY}`) {
        return json(res, 401, { error: 'Unauthorized' });
      }
    }

    // ── Rutas ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, {
        status: 'ok',
        gateway: true,
        worker_version: process.env.WORKER_VERSION,
        google_oauth: !!GOOGLE_CLIENT_ID,
      });
    }

    if (req.method === 'POST' && req.url === '/api/enqueue') {
      try {
        const body = await readBody(req);
        const result = await handleEnqueue(body, queue, log);
        return json(res, result.status, result.body);
      } catch (err) {
        log('error', 'gateway.request_error', { error: err.message });
        return json(res, 400, { error: err.message });
      }
    }

    if (req.method === 'POST' && req.url === '/api/mp/create-preference') {
      try {
        const body = await readBody(req);
        const result = await handleCreateMpPreference(body, log);
        return json(res, result.status, result.body);
      } catch (err) {
        log('error', 'mp.request_error', { error: err.message });
        return json(res, 500, { error: err.message });
      }
    }

    json(res, 404, {
      error:     'Not Found',
      endpoints: ['POST /api/enqueue', 'POST /api/mp/create-preference', 'GET /api/auth/google/callback', 'GET /health'],
    });
  });

  server.listen(GATEWAY_PORT, () => {
    log('info', 'gateway.started', {
      port:      GATEWAY_PORT,
      auth:      GATEWAY_API_KEY ? 'Bearer token' : 'NONE (staging)',
      endpoints: ['POST /api/enqueue', 'POST /api/mp/create-preference', 'GET /api/auth/google/callback', 'GET /health'],
    });
  });

  server.on('error', (err) => {
    log('error', 'gateway.server_error', { message: err.message });
  });

  return server;
}
