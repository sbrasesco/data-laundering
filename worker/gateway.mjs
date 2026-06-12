/**
 * gateway.mjs — Input Gateway
 * Data Laundering V2.0 — TASK-37 / TASK-67 / TASK-70 / TASK-78
 *
 * Rutas:
 *   POST /api/enqueue                       — encolar job (auth requerida)
 *   POST /api/mp/create-preference          — crear preferencia MP (auth requerida)
 *   GET  /api/auth/google/callback          — OAuth callback (sin auth, Google llama acá)
 *   GET  /api/drive/folders                 — listar carpetas de Drive (auth requerida)
 *   POST /api/drive/set-folder              — guardar folder_id + crear /procesados/ (auth requerida)
 *   GET  /health
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { depositSingleApprovedRow } from './output-depositor.mjs';

const GATEWAY_PORT       = Number(process.env.GATEWAY_PORT ?? 3001);
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_KEY;
const GATEWAY_API_KEY    = process.env.GATEWAY_API_KEY;
const MP_ACCESS_TOKEN    = process.env.MP_ACCESS_TOKEN;
const FRONTEND_URL       = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI
  ?? 'http://localhost:3001/api/auth/google/callback';

const VALID_FILE_TYPES = ['zip', 'rar', 'pdf', 'jpg', 'jpeg', 'png'];
const VALID_SOURCES    = ['frontend_upload', 'integration_drive', 'integration_remote', 'api_direct'];
const UUID_RE          = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(v) { return UUID_RE.test(v); }

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────

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

// ─── Supabase RPC helper ──────────────────────────────────────────────────────

async function callSupabaseRpc(rpcName, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
    method:  'POST',
    headers: {
      apikey:          SUPABASE_KEY,
      Authorization:  `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${rpcName} failed (${res.status}): ${text}`);
  }
  // Void RPCs return 204 with no body
  const ct = res.headers.get('content-type') ?? '';
  if (res.status === 204 || !ct.includes('application/json')) return null;
  return res.json();
}

// ─── Google helpers ───────────────────────────────────────────────────────────

async function getAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${err}`);
  }
  const { access_token } = await res.json();
  return access_token;
}

function sanitizeFolderName(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim();
}

async function ensureDriveFolder(accessToken, parentFolderId, folderName) {
  const q = encodeURIComponent(
    `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (searchRes.ok) {
    const { files } = await searchRes.json();
    if (files && files.length > 0) return files[0].id;
  }
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name:     folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents:  [parentFolderId],
    }),
  });
  if (createRes.ok) {
    const data = await createRes.json();
    return data.id;
  }
  return null;
}

async function createIntegrationFolders(accessToken, parentFolderId, orgId) {
  // Carpetas raíz (compatibilidad con archivos legados)
  await ensureDriveFolder(accessToken, parentFolderId, 'procesados');
  await ensureDriveFolder(accessToken, parentFolderId, 'extracciones');

  // Carpetas por cliente — requiere orgId
  if (!orgId) return;
  let clients;
  try {
    clients = await callSupabaseRpc('admin_get_org_clients', { p_organization_id: orgId });
  } catch (err) {
    // best-effort: no bloquear si falla
    return;
  }
  if (!Array.isArray(clients)) return;

  for (const client of clients) {
    if (!client.tax_id) continue; // clientes sin CUIT no tienen carpeta
    const folderName = sanitizeFolderName(`${client.name} — ${client.tax_id}`);
    const clientFolderId = await ensureDriveFolder(accessToken, parentFolderId, folderName);
    if (clientFolderId) {
      await ensureDriveFolder(accessToken, clientFolderId, 'procesados');
      await ensureDriveFolder(accessToken, clientFolderId, 'extracciones');
    }
  }
}

// ─── Handler: OAuth callback ──────────────────────────────────────────────────

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

  const { orgId, integrationId } = state;
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
    log('warn', 'google_oauth.no_refresh_token', { integrationId });
    return errRedirect('no_refresh_token');
  }

  // 2. Guardar refresh_token via RPC (maneja encriptación en DB)
  try {
    await callSupabaseRpc('admin_update_integration_credentials', {
      p_integration_id:    integrationId,
      p_org_id:            orgId,
      p_merge_credentials: { oauth_refresh_token: tokens.refresh_token },
    });
  } catch (err) {
    log('error', 'google_oauth.save_token_failed', { integrationId, error: err.message });
    return errRedirect('save_failed');
  }

  log('info', 'google_oauth.connected', { integrationId, orgId });
  return `${FRONTEND_URL}/integrations?google_connected=true&integration_id=${integrationId}`;
}

// ─── Handler: listar carpetas de Drive ───────────────────────────────────────

async function handleListDriveFolders(req, log) {
  const url           = new URL(req.url, 'http://localhost');
  const integrationId = url.searchParams.get('integration_id');
  const orgId         = url.searchParams.get('org_id');

  if (!integrationId || !orgId) {
    return { status: 400, body: { error: 'integration_id y org_id requeridos' } };
  }

  // Obtener credenciales via RPC
  let credentials;
  try {
    credentials = await callSupabaseRpc('admin_get_integration_credentials', {
      p_integration_id: integrationId,
      p_org_id:         orgId,
    });
  } catch (err) {
    log('error', 'drive_folders.credentials_error', { integrationId, error: err.message });
    return { status: 502, body: { error: 'Error obteniendo credenciales' } };
  }

  const refreshToken = credentials?.oauth_refresh_token;
  if (!refreshToken) {
    return { status: 400, body: { error: 'Integración no conectada a Google Drive' } };
  }

  // Obtener access token
  let accessToken;
  try {
    accessToken = await getAccessToken(refreshToken);
  } catch (err) {
    log('error', 'drive_folders.token_refresh_failed', { integrationId, error: err.message });
    return { status: 502, body: { error: 'Error renovando access token' } };
  }

  // Listar carpetas de Drive
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and trashed=false");
  const foldersRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=name&pageSize=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!foldersRes.ok) {
    const err = await foldersRes.text();
    log('error', 'drive_folders.list_failed', { integrationId, error: err });
    return { status: 502, body: { error: 'Error listando carpetas de Drive' } };
  }

  const { files } = await foldersRes.json();
  log('info', 'drive_folders.listed', { integrationId, count: (files || []).length });
  return { status: 200, body: { folders: (files || []).map(f => ({ id: f.id, name: f.name })) } };
}

// ─── Handler: guardar folder_id ───────────────────────────────────────────────

async function handleSetDriveFolder(body, log) {
  const { integration_id, org_id, folder_id, folder_name } = body ?? {};

  if (!integration_id || !org_id || !folder_id) {
    return { status: 400, body: { error: 'integration_id, org_id, folder_id requeridos' } };
  }

  // Obtener credenciales para acceder al refresh_token
  let credentials;
  try {
    credentials = await callSupabaseRpc('admin_get_integration_credentials', {
      p_integration_id: integration_id,
      p_org_id:         org_id,
    });
  } catch (err) {
    log('error', 'drive_set_folder.credentials_error', { integration_id, error: err.message });
    return { status: 502, body: { error: 'Error obteniendo credenciales' } };
  }

  const refreshToken = credentials?.oauth_refresh_token;
  if (!refreshToken) {
    return { status: 400, body: { error: 'Integración no conectada' } };
  }

  // Guardar folder_id en credentials (merge)
  try {
    await callSupabaseRpc('admin_update_integration_credentials', {
      p_integration_id:    integration_id,
      p_org_id:            org_id,
      p_merge_credentials: { folder_id },
    });
  } catch (err) {
    log('error', 'drive_set_folder.save_failed', { integration_id, error: err.message });
    return { status: 502, body: { error: 'Error guardando folder_id' } };
  }

  // Actualizar folder_path con el nombre de la carpeta (display)
  if (folder_name) {
    await fetch(
      `${SUPABASE_URL}/rest/v1/tenant_integrations?id=eq.${integration_id}&organization_id=eq.${org_id}`,
      {
        method:  'PATCH',
        headers: {
          apikey:          SUPABASE_KEY,
          Authorization:  `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ folder_path: folder_name }),
      }
    );
  }

  // Crear carpetas raíz + carpetas por cliente (no bloqueante)
  try {
    const accessToken = await getAccessToken(refreshToken);
    await createIntegrationFolders(accessToken, folder_id, org_id);
    log('info', 'drive_set_folder.folders_created', { integration_id, org_id, folder_id });
  } catch (err) {
    log('warn', 'drive_set_folder.folders_failed', { integration_id, error: err.message });
  }

  log('info', 'drive_set_folder.done', { integration_id, org_id, folder_id, folder_name });
  return { status: 200, body: { ok: true } };
}

// ─── Handler: depositar fila aprobada (TASK-80) ──────────────────────────────

async function handleDepositRow(body, log) {
  const { row_id, job_id, org_id } = body ?? {};
  if (!row_id || !job_id || !org_id) {
    return { status: 400, body: { error: 'row_id, job_id, org_id requeridos' } };
  }
  try {
    await depositSingleApprovedRow(row_id, job_id, org_id, log);
    log('info', 'gateway.deposit_row.done', { row_id, job_id, org_id });
    return { status: 200, body: { ok: true } };
  } catch (err) {
    log('warn', 'gateway.deposit_row.failed', { row_id, error: err.message });
    return { status: 500, body: { error: err.message } };
  }
}

// ─── Handler: enqueue ─────────────────────────────────────────────────────────

async function handleEnqueue(body, queue, log) {
  const {
    organization_id, file_url, file_type, original_filename,
    client_cuit = null, client_name = null, client_id = null, input_source,
    job_id: provided_job_id = null,
  } = body;

  if (!organization_id || !file_url || !file_type || !original_filename || !input_source) {
    return { status: 400, body: { error: 'Campos requeridos: organization_id, file_url, file_type, original_filename, input_source' } };
  }
  if (!isUUID(organization_id)) return { status: 400, body: { error: 'organization_id debe ser un UUID válido' } };
  if (!VALID_FILE_TYPES.includes(file_type)) return { status: 400, body: { error: `file_type inválido. Valores aceptados: ${VALID_FILE_TYPES.join(', ')}` } };
  if (!VALID_SOURCES.includes(input_source)) return { status: 400, body: { error: `input_source inválido.` } };
  if (!file_url.startsWith('https://')) return { status: 400, body: { error: 'file_url debe ser una URL HTTPS' } };

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
          return { status: 402, body: { error: 'INSUFFICIENT_CREDITS', message: 'Saldo insuficiente.' } };
        }
      }
    } catch (err) {
      log('warn', 'gateway.credits_check_failed', { organization_id, error: err.message });
    }
  }

  const job_id = (provided_job_id && isUUID(provided_job_id)) ? provided_job_id : randomUUID();
  const payload = {
    job_id, organization_id, file_url, file_type,
    file_hash: 'pending', original_filename, file_size_bytes: 0,
    client_cuit, client_name, client_id, oc_entries: [], priority: 5,
    metadata: { source: input_source, worker_version: process.env.WORKER_VERSION ?? 'unknown' },
  };

  // Crear pdf_jobs si no existe (integration sources). Para frontend_upload el frontend
  // ya lo crea antes de llamar al gateway — on_conflict=ignore-duplicates evita pisarlo.
  if (SUPABASE_URL && SUPABASE_KEY && input_source !== 'frontend_upload') {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/pdf_jobs?on_conflict=id`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal,resolution=ignore-duplicates',
        },
        body: JSON.stringify({ id: job_id, organization_id, status: 'processing', client_id: client_id || null, input_source }),
      });
    } catch (_) {}
  }

  await queue.add('process-pdf', payload, { jobId: job_id, priority: 5 });
  log('info', 'gateway.enqueued', { job_id, organization_id, file_type, input_source });
  return { status: 200, body: { job_id, queued: true } };
}

// ─── Handler: MercadoPago ─────────────────────────────────────────────────────

const CUSTOM_CREDIT_MIN = 20;

async function getCreditTierPrice(creditsNum) {
  const url = `${SUPABASE_URL}/rest/v1/credit_price_tiers?active=eq.true&min_credits=lte.${creditsNum}&or=(max_credits.gte.${creditsNum},max_credits.is.null)&order=min_credits.desc&limit=1`;
  const res = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) return null;
  const tiers = await res.json();
  return tiers.length ? Number(tiers[0].price_per_credit) : null;
}

async function handleCreateCustomMpPreference(body, log) {
  const { credits, user_id } = body ?? {};
  if (!user_id || credits === undefined) return { status: 400, body: { error: 'Campos requeridos: credits, user_id' } };
  if (!isUUID(user_id)) return { status: 400, body: { error: 'user_id debe ser un UUID válido' } };
  const creditsNum = parseInt(credits, 10);
  if (!Number.isInteger(creditsNum) || creditsNum < CUSTOM_CREDIT_MIN) {
    return { status: 400, body: { error: `El mínimo de créditos es ${CUSTOM_CREDIT_MIN}` } };
  }
  if (!MP_ACCESS_TOKEN) return { status: 500, body: { error: 'MP_ACCESS_TOKEN no configurado' } };

  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user_id)}&select=organization_id&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!profileRes.ok) return { status: 502, body: { error: 'Error consultando profiles' } };
  const profiles = await profileRes.json();
  if (!profiles.length || !profiles[0].organization_id) return { status: 404, body: { error: 'Perfil sin organización' } };
  const organization_id = profiles[0].organization_id;

  const pricePerCredit = await getCreditTierPrice(creditsNum);
  if (pricePerCredit === null) return { status: 500, body: { error: 'No se pudo determinar el precio del crédito' } };
  const totalPrice = creditsNum * pricePerCredit;

  const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ title: `${creditsNum} créditos DataLand`, quantity: 1, unit_price: totalPrice, currency_id: 'USD' }],
      back_urls: {
        success: `${FRONTEND_URL}/payment/success`,
        failure: `${FRONTEND_URL}/payment/failure`,
        pending: `${FRONTEND_URL}/payment/pending`,
      },
      ...(FRONTEND_URL.startsWith('https://') ? { auto_return: 'approved' } : {}),
      external_reference: organization_id,
    }),
  });
  if (!mpRes.ok) {
    const mpErr = await mpRes.text();
    log('error', 'mp.custom_preference_error', { credits: creditsNum, status: mpRes.status, error: mpErr });
    return { status: 502, body: { error: 'Error creando preferencia MP', detail: mpErr } };
  }
  const mpData = await mpRes.json();

  const payRes = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
    method:  'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      organization_id,
      plan_id: null,
      amount: totalPrice,
      currency: 'USD',
      gateway: 'mercadopago',
      gateway_preference_id: mpData.id,
      status: 'pending',
      metadata: { custom_credits: creditsNum },
    }),
  });
  if (!payRes.ok) {
    const payErr = await payRes.text();
    log('error', 'mp.custom_payment_insert_error', { organization_id, error: payErr });
    return { status: 502, body: { error: 'Error insertando payment', detail: payErr } };
  }
  const [payment] = await payRes.json();
  log('info', 'mp.custom_preference_created', { payment_id: payment.id, preference_id: mpData.id, organization_id, credits: creditsNum, price_per_credit: pricePerCredit });
  return { status: 200, body: { payment_id: payment.id, preference_id: mpData.id, init_point: mpData.init_point, sandbox_init_point: mpData.sandbox_init_point } };
}

async function handleCreateMpPreference(body, log) {
  const { plan_id, user_id } = body ?? {};
  if (!plan_id || !user_id) return { status: 400, body: { error: 'Campos requeridos: plan_id, user_id' } };
  if (!isUUID(plan_id) || !isUUID(user_id)) return { status: 400, body: { error: 'plan_id y user_id deben ser UUIDs válidos' } };
  if (!MP_ACCESS_TOKEN) return { status: 500, body: { error: 'MP_ACCESS_TOKEN no configurado' } };

  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user_id)}&select=organization_id&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!profileRes.ok) return { status: 502, body: { error: 'Error consultando profiles' } };
  const profiles = await profileRes.json();
  if (!profiles.length || !profiles[0].organization_id) return { status: 404, body: { error: 'Perfil sin organización' } };
  const organization_id = profiles[0].organization_id;

  const planRes = await fetch(
    `${SUPABASE_URL}/rest/v1/billing_plans?id=eq.${encodeURIComponent(plan_id)}&active=eq.true&select=id,display_name,price,currency&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!planRes.ok) return { status: 502, body: { error: 'Error consultando billing_plans' } };
  const plans = await planRes.json();
  if (!plans.length) return { status: 404, body: { error: 'Plan no encontrado' } };
  const plan = plans[0];

  const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ title: plan.display_name, quantity: 1, unit_price: Number(plan.price), currency_id: plan.currency }],
      back_urls: {
        success: `${FRONTEND_URL}/payment/success`,
        failure: `${FRONTEND_URL}/payment/failure`,
        pending: `${FRONTEND_URL}/payment/pending`,
      },
      ...(FRONTEND_URL.startsWith('https://') ? { auto_return: 'approved' } : {}),
      external_reference: organization_id,
    }),
  });
  if (!mpRes.ok) {
    const mpErr = await mpRes.text();
    log('error', 'mp.preference_error', { plan_id, status: mpRes.status, error: mpErr });
    return { status: 502, body: { error: 'Error creando preferencia MP', detail: mpErr } };
  }
  const mpData = await mpRes.json();

  const payRes = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
    method:  'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ organization_id, plan_id, amount: Number(plan.price), currency: plan.currency, gateway: 'mercadopago', gateway_preference_id: mpData.id, status: 'pending' }),
  });
  if (!payRes.ok) {
    const payErr = await payRes.text();
    log('error', 'mp.payment_insert_error', { organization_id, plan_id, error: payErr });
    return { status: 502, body: { error: 'Error insertando payment', detail: payErr } };
  }
  const [payment] = await payRes.json();
  log('info', 'mp.preference_created', { payment_id: payment.id, preference_id: mpData.id, organization_id });
  return { status: 200, body: { payment_id: payment.id, preference_id: mpData.id, init_point: mpData.init_point, sandbox_init_point: mpData.sandbox_init_point } };
}

// ─── Server ───────────────────────────────────────────────────────────────────

export function startGateway(queue, log) {
  const server = createServer(async (req, res) => {

    if (req.method === 'OPTIONS') return json(res, 204, {});

    // OAuth callback — EXENTO de auth
    if (req.method === 'GET' && req.url?.startsWith('/api/auth/google/callback')) {
      try {
        const redirectUrl = await handleGoogleOAuthCallback(req, log);
        return redirect(res, redirectUrl);
      } catch (err) {
        log('error', 'google_oauth.callback_error', { error: err.message });
        return redirect(res, `${FRONTEND_URL}/integrations?google_error=server_error`);
      }
    }

    // Autenticación para el resto de rutas
    if (GATEWAY_API_KEY) {
      const auth = req.headers['authorization'] ?? '';
      if (auth !== `Bearer ${GATEWAY_API_KEY}`) {
        return json(res, 401, { error: 'Unauthorized' });
      }
    }

    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { status: 'ok', gateway: true, worker_version: process.env.WORKER_VERSION, google_oauth: !!GOOGLE_CLIENT_ID });
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

    if (req.method === 'POST' && req.url === '/api/mp/create-custom-preference') {
      try {
        const body = await readBody(req);
        const result = await handleCreateCustomMpPreference(body, log);
        return json(res, result.status, result.body);
      } catch (err) {
        log('error', 'mp.custom_request_error', { error: err.message });
        return json(res, 500, { error: err.message });
      }
    }

    // Depositar fila aprobada
    if (req.method === 'POST' && req.url === '/api/deposit-row') {
      try {
        const body = await readBody(req);
        const result = await handleDepositRow(body, log);
        return json(res, result.status, result.body);
      } catch (err) {
        log('error', 'deposit_row.error', { error: err.message });
        return json(res, 500, { error: err.message });
      }
    }

    // Drive: listar carpetas
    if (req.method === 'GET' && req.url?.startsWith('/api/drive/folders')) {
      try {
        const result = await handleListDriveFolders(req, log);
        return json(res, result.status, result.body);
      } catch (err) {
        log('error', 'drive_folders.error', { error: err.message });
        return json(res, 500, { error: err.message });
      }
    }

    // Drive: guardar carpeta seleccionada
    if (req.method === 'POST' && req.url === '/api/drive/set-folder') {
      try {
        const body = await readBody(req);
        const result = await handleSetDriveFolder(body, log);
        return json(res, result.status, result.body);
      } catch (err) {
        log('error', 'drive_set_folder.error', { error: err.message });
        return json(res, 500, { error: err.message });
      }
    }

    json(res, 404, {
      error:     'Not Found',
      endpoints: [
        'POST /api/enqueue',
        'POST /api/mp/create-preference',
        'POST /api/deposit-row',
        'GET  /api/auth/google/callback',
        'GET  /api/drive/folders',
        'POST /api/drive/set-folder',
        'GET  /health',
      ],
    });
  });

  server.listen(GATEWAY_PORT, () => {
    log('info', 'gateway.started', {
      port:      GATEWAY_PORT,
      auth:      GATEWAY_API_KEY ? 'Bearer token' : 'NONE (staging)',
      endpoints: ['enqueue', 'mp/create-preference', 'deposit-row', 'auth/google/callback', 'drive/folders', 'drive/set-folder', 'health'],
    });
  });

  server.on('error', (err) => {
    log('error', 'gateway.server_error', { message: err.message });
  });

  return server;
}
