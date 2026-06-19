# DataLand V2.0 — Contexto del proyecto

---

## 🔒 ZONA CERRADA — NO TOCAR SIN RAZÓN EXPLÍCITA

Estos sistemas están validados en producción. No modificar ninguno de estos archivos, tablas ni flujos salvo que haya una tarea nueva que lo justifique explícitamente. Si algo nuevo los afecta, señalarlo primero y confirmar antes de tocar.

### Auth / Frontend loading
- `src/contexts/AuthContext.tsx` — callback `onAuthStateChange` **SÍNCRONO**. No `async`, no `await` dentro. Supabase v2 retiene el session lock (`_acquireLock`) durante toda la ejecución del callback: si es async y espera `fetchProfile()` (~19.5s), `getSession()` queda bloqueado el mismo tiempo → spinner 20s.
  - `setLoading(false)` se llama **inmediatamente** al conocer la sesión, antes de cualquier fetch.
  - `fetchProfile` corre en `Promise.resolve().then(async () => { ... })` — fuera del lock, en el siguiente tick.
  - `fetchProfile` **NO** llama `setProfile(null)` en error — preserva el profile cargado. Solo `signOut` y sesión nula limpian el profile.
  - Reintenta 3 veces (1.5s y 3s entre intentos). Timeout 5s por intento.
- `src/hooks/useTenantCredits.ts` — early return `if (authLoading) return`. Si `authLoading=false` pero `organizationId=null`: no limpiar balance ni bajar `loading` — el profile aún llega en background. `return { balance, loading: loading || authLoading }`. Realtime subscription + polling fallback `setInterval(15_000)`.
- `src/hooks/useClientJobs.ts` — guard `if (authLoading) return`. Si `authLoading=false` y `organizationId=null`: mantener `loading=true`. `authLoading` en deps del `useEffect`.
- **Patrón hooks con guard** (no romper): `if (authLoading) return` → `if (!organizationId) return`. El `loading` retornado incluye `|| authLoading`. Sin esto, los componentes renderizan con datos vacíos/cero y parpadean.
- `src/lib/supabase.ts` — usa `window.__nativeFetch`. SDKs como Amplitude parchean `window.fetch`; si fallan con 401, el fetch parcheado queda roto. No reemplazar por `fetch` directo.
- `index.html` — spinner inline + script guard `__nativeFetch` en `<head>` antes de cualquier recurso externo. No mover ni eliminar. Mensaje CSS "Tardando demasiado" a los 8s. `<ErrorBoundary>` en `main.tsx` + handler `unhandledrejection`.
- `AppShell.tsx` sidebar balance — tres estados: skeleton (`creditsLoading`) → rojo "Sin saldo" (`balance <= 0`) → verde con monto. El "sin saldo" es un `<button>` que abre `InsufficientCreditsModal`. No convertir en `div` estático.

### Billing / Pagos
- `POST /api/mp/webhook` en `gateway.mjs` — flujo IPN validado e2e. No tocar la lógica de lookup `preference_id` / `external_reference` ni la idempotencia por `gateway_payment_id`.
- `POST /api/mp/create-preference` y `create-custom-preference` — generan UUID antes del INSERT, pasan `external_reference`. No cambiar este orden.
- RPC `add_credits(...)` — SECURITY DEFINER, usarla siempre desde gateway con service key. No llamarla desde frontend.
- `MP_ACCESS_TOKEN` — producción (`seller_id 290523599`). No reemplazar por sandbox.
- RPC `charge_credit(...)` — precio base leído de `billing_plans WHERE name='basico' AND active=true` → columna `price_per_doc`, con `COALESCE($0.30)` como fallback si es NULL y `$0.30` hardcodeado si la fila no existe (UX-PRICE-BREAKDOWN, migración posterior a TASK-90). **Cambiar el precio base = editar `billing_plans.price_per_doc` del plan `basico` desde MonitoringPage → Precios** — toma efecto inmediato sin redeploy. El `plan_id` en `organization_credits` es solo para trazabilidad/logging. Costo total = `(base_price + suma_features_activas + polling_cost) × cant_docs`. Acepta `p_polling_interval_minutes INTEGER DEFAULT NULL` — lookup a `polling_interval_tiers.cost_per_doc` (TASK-104, 2026-06-17).
- `polling_interval_tiers` — tabla con 12 tramos (1 a 120 min). `active` controla visibilidad en UI del tenant. Editable desde MonitoringPage > Precios vía RPC `update_polling_tier` (SECURITY DEFINER, solo superadmin). NO hardcodear costos de polling.

### Google Drive OAuth
- `VITE_GOOGLE_CLIENT_ID=59795666065-qhm5r5p4q9rj8glpauhir6a6r4uen4sj.apps.googleusercontent.com` — identifica la app DataLand, no al tenant.
- `VITE_GOOGLE_REDIRECT_URI=https://dataland.aignition.net/worker/api/auth/google/callback` — debe coincidir exactamente con el valor en el `.env` del worker y con lo registrado en Google Cloud Console. NO usar `automation.aignition.net`.
- `integration-poller.mjs` — encola con `${gatewayUrl}/api/enqueue`. No pasar `gatewayUrl` directo como URL de POST.
- `worker.mjs:GATEWAY_URL` — URL base sin path (`https://automation.aignition.net/worker`). No agregar `/api/enqueue` al valor de la variable.

### Seguridad / Base de datos
- `tenant_integrations.credentials` — **NO EXISTE como columna top-level**. Las credenciales están en `credentials_encrypted` (bytea). Para leerlas siempre usar RPC `admin_get_integration_credentials(p_integration_id, p_org_id)`. Para queries REST, seleccionar `integration_type, folder_path, organization_id` (nunca `credentials`).
- `integration_processed_files` — RLS habilitado (TASK-87, 2026-06-15). Políticas: `tenant_select_own`, `tenant_insert_own`. No deshabilitar.
- Trigger `on_auth_user_created → handle_new_user()` — crea org + profile automáticamente. El frontend **nunca** inserta org/profile manualmente.
- RPCs con SECURITY DEFINER (`charge_credit`, `add_credits`, `get_all_tenants_admin`, `get_tenant_jobs_admin`, `approve_document_row`) — no eliminar ni modificar sin evaluar impacto en RLS.

### Realtime / Subscripciones (CERRADO — 2026-06-19)
- **Publicación `supabase_realtime`**: tablas `pdf_jobs` y `pdf_job_rows` habilitadas vía migración `enable_realtime_pdf_jobs`. Sin esto, ningún evento `postgres_changes` llega al cliente y la UI no refresca sola. **NO remover estas tablas de la publicación.**
- **Nombres de canal — NO duplicar**:
  - `useClientJobs` → `'pdf_jobs_changes'` (ClientDashboardPage)
  - `usePdfJobs` → `'mis_procesos_jobs_changes'` + `'mis_procesos_rows_changes'` (MisProcesosPage)
  - Supabase reutiliza canales con el mismo nombre en el mismo cliente. Si dos hooks usan el mismo nombre y se montan en secuencia, las subscripciones se corrompen.
- **Polling de respaldo**: ambos hooks tienen polling (8s / 5s) que activa solo cuando hay jobs en estado `pending`/`processing` o recientes en el estado local. Depende de Realtime para recibir el INSERT inicial; si Realtime falla, el primer job nunca entra al estado y el polling nunca arranca.

### Observabilidad
- Sentry — `@sentry/react` + `vite-plugin`, source maps subidos. `SENTRY_AUTH_TOKEN` debe ser env var real al buildear, no solo en `.env`.
- `GET /api/metrics` en `gateway.mjs` — proxy a `metrics.mjs:9090`, consumido por `MonitoringPage`. No cambiar la ruta ni el auth Bearer.

### Deploy
- Worker: SIEMPRE `docker compose build && docker compose up -d --force-recreate` desde `/root/worker/`. NUNCA `docker run` manual.
- Frontend: `npm run build` → `rm -rf /var/www/dataland/assets` → `scp -r dist/.`. NUNCA Netlify ni git pull en servidor.

### Variable crítica
- `VITE_WORKER_GATEWAY_URL` = URL base SIN path. Cada archivo appenda su endpoint. No incluir `/api/enqueue` ni ningún path en esta variable.

### Pipeline de integración (worker) — CERRADO (2026-06-18)
El pipeline de procesamiento está validado y estabilizado. No tocar sin tarea explícita que lo justifique.

- `worker/poller-handoff.mjs` — módulo central compartido: SHA256, dedup via `admin_register_processed_file`, upload a Aurora Storage, enqueue en gateway. Exports: `checkAndRegisterFile`, `uploadAndEnqueue`, `handoffBuffer`, `runIntegrationPoller`. **Toda integración nueva usa este módulo — no duplicar esta lógica.**
- `worker/integration-file-mover.mjs` — mueve archivos desde `en_proceso/` a `procesados/` o `fallidos/` post-worker. Soporta supabase_storage, firebase_storage, integration_drive. Se llama desde worker.mjs automáticamente — no duplicar. **Credenciales**: la columna `credentials` NO existe en `tenant_integrations` — están en `credentials_encrypted` (bytea). `fetchIntegration` selecciona `integration_type, folder_path, organization_id` y luego llama RPC `admin_get_integration_credentials` para desencriptar.
- `worker/gateway.mjs` — rutas activas, billing, IPN MercadoPago, VALID_SOURCES. Cerrado. **FIX metadata passthrough (2026-06-18)**: `metadata: { ...(body?.metadata ?? {}), source: input_source, worker_version: ... }` — preserva campos `fileMeta` de pollers (`integration_id`, `original_path`, `bucket_name`, `drive_file_id`…) que `integration-file-mover.mjs` necesita. Antes los sobreescribía → `integration_id = undefined` → file-mover salía sin mover nada.
- `worker/document-processor.mjs` — OCR + AI extraction. Cerrado.
- `worker/worker.mjs` — BullMQ consumer, cron de integraciones. Cerrado.
- `worker/supabase-storage-poller.mjs` — adaptador Supabase Storage (lista/descarga/mueve a en_proceso). Cerrado.
- `worker/firebase-storage-poller.mjs` — adaptador Firebase Storage (lista/descarga/mueve a en_proceso). Cerrado.
- `worker/integration-poller.mjs` — Google Drive (producción activa). Tocar SOLO para TASK-94 y TASK-96.
- `worker/output-depositor.mjs` — deposita CSV/XLSX a extracciones/ del cliente. Soporta: google_drive, firebase_storage, supabase_storage, sftp, ftp. Cerrado.

**Estructura de carpetas uniforme para TODAS las integraciones:**
- Usuario suelta archivos en raíz / carpeta configurada
- Poller mueve a `en_proceso/` al levantar (señal de "tomado")
- Worker mueve a `procesados/` (éxito) o `fallidos/` (error terminal) via `integration-file-mover.mjs`
- Output va a `extracciones/` via `output-depositor.mjs`

**Agregar integración nueva** = crear `worker/{nombre}-poller.mjs` con list + download + move a `en_proceso/` + llamar `uploadAndEnqueue` de `poller-handoff.mjs` con `fileMeta` apropiado, agregar `input_source` al CHECK constraint de `pdf_jobs` y a `VALID_SOURCES` en `gateway.mjs`. El movimiento post-worker es automático vía `integration-file-mover.mjs`.

---

## Stack

- **Frontend**: React 18 + TypeScript + Vite, shadcn/ui, Tailwind CSS
- **Backend/DB**: Supabase (PostgreSQL + RLS + Realtime)
- **Worker**: Node.js ESM (`worker/*.mjs`), Docker en VPS DigitalOcean
- **Queue**: BullMQ + Redis Cloud (sa-east-1) — queue `pdf-processing`
- **Pagos**: MercadoPago — IPN webhook ✅ validado e2e sandbox (TASK-85 prod 2026-06-14, commits f785cc1 + f7a8649)
- **Integraciones activas**: Google Drive ✅, Firebase Storage ✅, SFTP ⛔ desactivado
- **N8N**: ELIMINADO definitivamente (DEC-011). No existe. No referenciar.

## Producción

- **Frontend**: `https://dataland.aignition.net` → VPS `root@157.230.231.207:/var/www/dataland/`
- **Worker/gateway**: `v1.9.9` en `root@157.230.231.207:/root/worker/` (Docker Compose)
- **Supabase project**: `klhbgsiatzbmxbkzpbzv`
- **Superadmins**: `arcademy.dev@gmail.com`, `sbrasesco@outlook.es`

## Deploy workflow

```bash
# Frontend — siempre SCP al VPS, nunca Netlify, nunca git pull
npm run build
rm -rf /var/www/dataland/assets   # limpiar assets viejos en servidor
scp -r dist/. root@157.230.231.207:/var/www/dataland/

# Worker — SIEMPRE docker compose, NUNCA docker run manual
scp worker/*.mjs root@157.230.231.207:/root/worker/
ssh root@157.230.231.207 "cd /root/worker && docker compose build && docker compose up -d --force-recreate"
# Verificar:
# docker logs dl-worker --tail 30
# curl -s http://localhost:3001/health
```

**Regla crítica**: usar `docker compose up -d` desde `/root/worker/`. Si se usa `docker run` manual con `--network` incorrecto, el container queda en `caddy_net` en lugar de host mode y Caddy no puede alcanzar el gateway en `:3001`.

---

## Arquitectura del worker (estado real — 2026-06-14)

N8N fue eliminado completamente. El pipeline completo es:

```
Frontend / Integration poller
  ↓
POST /api/enqueue  →  gateway.mjs (:3001)
  ↓
BullMQ queue "pdf-processing"  (Redis Cloud sa-east-1)
  ↓
worker.mjs  →  document-processor.mjs
  ↓
Supabase (resultados)  +  Drive / Firebase / SFTP (outputs)
```

### gateway.mjs — rutas activas

| Ruta | Auth | Propósito |
|---|---|---|
| `POST /api/enqueue` | Bearer | Encolar job PDF/ZIP |
| `POST /api/mp/create-preference` | Bearer | Crear preferencia MP + insertar payment (pending) |
| `POST /api/mp/create-custom-preference` | Bearer | Igual, créditos personalizados |
| `POST /api/mp/webhook` | Sin auth | IPN MercadoPago → aprueba payment + add_credits ✅ |
| `POST /api/deposit-row` | Bearer | Depositar fila aprobada manualmente |
| `GET /api/drive/folders` | Bearer | Listar carpetas Drive |
| `POST /api/drive/set-folder` | Bearer | Guardar carpeta Drive seleccionada |
| `GET /api/auth/google/callback` | Sin auth | OAuth callback Google |
| `POST /api/integrations/init-folders` | Bearer | Crear carpetas de sistema en storage del cliente (TASK-107) |
| `GET /api/metrics` | Bearer | Proxy métricas cola → :9090 ✅ TASK-85 |
| `GET /health` | Bearer | Estado del gateway |

### metrics.mjs — puerto 9090

Expone métricas de la cola (✅ consumidas por MonitoringPage vía `GET /api/metrics` en gateway — TASK-85):
- `queue_depth`: waiting / active / delayed
- `latency_ms`: p50, p95, avg, sample_size
- `error_rate_pct`
- `totals`: completed / failed
- Endpoints: `GET /health`, `GET /metrics`

### Variables de entorno worker (`.env` en `/root/worker/`)

```
REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
SUPABASE_URL, SUPABASE_SERVICE_KEY
WORKER_CONCURRENCY=3, WORKER_VERSION
METRICS_PORT=9090, GATEWAY_PORT=3001
GATEWAY_API_KEY, MP_ACCESS_TOKEN
GATEWAY_URL=https://automation.aignition.net/worker   ← necesaria para TASK-85
STORAGE_BUCKET=facturas
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
FRONTEND_URL=https://dataland.aignition.net
NODE_ENV=production
```

---

## Tareas — estado actual

### 🟡 Backlog activo
| Task | Descripción | Prioridad |
|------|-------------|-----------|
| **TASK-91** | FIX-CLIENT-VALIDATION: Validar email y CUIT duplicados al crear cliente. 🔄 EN PROGRESO — constraints DB aplicadas (`clients_org_email_unique`, `clients_org_tax_id_unique`, migración `add_clients_org_email_unique` 2026-06-19); la DB ya bloquea duplicados. Falta UX: traducir el error 23505 a mensaje amigable en ClientsPage | 🔴 Crítica |
| **TASK-92** | FIX-STATUS-TERMINOLOGY: Estandarizar estados de documentos | 🟠 Alta |
| **TASK-93** | FIX-FILE-COUNT-NOTIFICATION: Notificar discrepancia archivos subidos vs procesados | 🟠 Alta |
| **TASK-94** | FIX-DRIVE-DATES: Fecha de período en docs cargados desde Google Drive | 🟠 Alta |
| **TASK-95** | FIX-MONITORING-ACTIVITY: Pestaña Activity vacía en MonitoringPage | 🟠 Alta |
| **TASK-96** | FIX-DRIVE-ERROR-FOLDER: Carpeta de errores en integración Google Drive. NOTA (2026-06-19): para Supabase/Firebase ya cubierto (`fallidos/` vía init/migrate-folders + worker); queda acotada a Drive | 🟠 Alta |
| **TASK-97** | UX-REMOVE-DATE-FIELD | 🟡 Media |
| **TASK-98** | UX-DOCTYPE-DROPDOWN | 🟡 Media |
| **TASK-99** | UX-CLARIFY-UPLOADER | 🟡 Media |
| **TASK-100** | UX-DRAG-DROP | 🟡 Media |
| **TASK-101** | UX-REMOVE-REDUNDANT-BUTTON | 🟡 Media |
| **TASK-102** | AI-REFINE-PROMPT: Ajustar prompt para facturas de servicios | 🟡 Media |
| **TASK-103** | RESEARCH-AFIP: Investigar integración validación AFIP | 🟢 Baja |
| **TASK-86** | FIX-CLEANUP: Limpiar refs n8n restantes | 🟡 Media |
| **TASK-66** | Landing visual refinement — dejar para el final | — |
| **TASK-105** | UX-OUTPUT-FORMAT: Selector CSV/Excel en tarjeta Google Drive (IntegracionesPage). Ver spec abajo. | 🟡 Media |

### ✅ Completadas y en prod
| Task | Descripción |
|------|-------------|
| TASK-106 (2026-06-19) | INT-SUPABASE-STORAGE: integración Supabase Storage validada e2e. Poller procesa, `gateway_create_pdf_job` crea `pdf_jobs`, billing correcto (base $0.30 + integration_supabase $0.15 + polling = **$0.65/doc validado**). Worker fd3c1af6 / frontend main-B3VNKqZD.js / commit f74f07c. ⚠️ Precios DINÁMICOS: $0.65 es la config de hoy, no un valor fijo. |
| INT-TEST-CONNECTION (2026-06-19) | `POST /api/integrations/test-connection`: valida creds + compara `ref` del JWT vs `project_url`, lista carpetas. Frontend: botón Comprobar conexión, dropdown de carpetas (raíz/existentes/crear nueva), gate de Guardar, auto-test al editar. |
| INT-FOLDER-MIGRATION (2026-06-19) | `POST /api/integrations/migrate-folders`: al cambiar `folder_path` mueve system folders + sueltos A→B con merge, limpia `.keep` viejos (no-Drive). Disparo en `handleSave`. ⚠️ falta validar movimiento con archivos reales. |
| FIX-PDFJOBS-CREATE (2026-06-19) | gateway.mjs usa RPC `gateway_create_pdf_job` (SECURITY DEFINER) en vez de REST con catch silencioso → `pdf_jobs` vuelve a crearse para integration sources. |
| FIX-POLLING-PASSTHROUGH (2026-06-19) | `poller-handoff.uploadAndEnqueue` + supabase/firebase pollers pasan `polling_interval_minutes` al gateway → el polling se cobra como en Drive. Validado $0.65/doc. |
| FIX-PRICE-BREAKDOWN (2026-06-19) | `get_price_breakdown()`: mapea `supabase_storage` ($0.15) y `master_file` solo drive+xlsx (ya no `output_enabled`). Coincide con el cobro real del worker. Migraciones `fix_get_price_breakdown_supabase_storage` + `_masterfile_drive_xlsx_only`. |
| TASK-85 (Notion) | Worker metrics en MonitoringPage: `GET /api/metrics` en gateway (proxy Bearer → :9090), tarjeta "Cola" + modal (queue_depth, p50/p95, error_rate). Polling 30s. Build main-BAo2rvH3.js / commit 2ffba1d (2026-06-15). `VITE_WORKER_API_KEY=staging-key-2026` requerida en `.env` del frontend. `VITE_WORKER_GATEWAY_URL` debe ser la URL base SIN `/api/enqueue` — los archivos del codebase appendean el endpoint específico. |
| Sentry (OBS) | Error monitoring en prod: @sentry/react + vite-plugin, source maps → aignition/javascript-react, setUser/setTag por tenant, filtro extensiones. Build main-Cjx7Trrf.js (commit fb6c5af, 2026-06-15) |
| TASK-73 | Excel acumulativo Drive |
| TASK-78 | Drive por cliente (carpetas `{cliente}/{extracciones,procesados}`) |
| TASK-79 | `input_source` + filtro cliente en MisProcesos |
| TASK-80 | Edición manual y aprobación de docs con error |
| TASK-81 | Reemplazar créditos por saldo USD |
| TASK-82 | Panel Monitoreo superadmin |
| TASK-83 | Resiliencia frontend ante extensiones de browser (6 fixes) |
| TASK-84 | Fix MonitoringPage Tenants: RPC bypass RLS para superadmin |
| TASK-85 | MP Webhook Receiver — `POST /api/mp/webhook` + `notification_url` en preferencias |
| FIX-EXT | Supabase usa `window.__nativeFetch` para sobrevivir monkey-patching |
| FIX-REG | Fix registro: `organization_name` en `signUp options.data` al trigger |
| UX-BALANCE | Saldo sidebar clickeable abre modal recarga; modal título "Recargar saldo" + fix `credits` en custom preference (commit `47017bc`, 2026-06-15) |
| FIX-AUTH-LOAD | `setLoading(false)` inmediato tras `getSession`; `fetchProfile` en background sin bloquear UI en F5 (commit `b7e6f9d`, 2026-06-15) |
| FIX-AUTH-LOCK | Fix definitivo del spinner 20s en F5 y flash de métricas en cero (commit `972ab03`, 2026-06-15) |
| TASK-87 | SEC-01: RLS en `integration_processed_files` — políticas `tenant_select_own` + `tenant_insert_own` (2026-06-15) |
| TASK-90 | FIX-BILLING: `charge_credit` hardcodeado a $0.30/doc base. Eliminado lookup `billing_plans.price_per_doc`. Migración `fix_charge_credit_flat_price` aplicada en prod (2026-06-17). ⚠️ **REEMPLAZADO por UX-PRICE-BREAKDOWN** — ver sección TASK-90 abajo para detalle. |
| TASK-104 | BILLING-POLLING: Tabla `polling_interval_tiers` (12 tramos 1-120 min), RPC `update_polling_tier`, `charge_credit` con `p_polling_interval_minutes`, worker chain wired, IntegracionesPage con dropdown, MonitoringPage panel superadmin (2026-06-17) — build main-DhKkH-eP.js, worker v1.9.9 — validado e2e (2026-06-18) |
| UX-PRICE-BREAKDOWN | Sección "Costo por documento" en SettingsPage. RPC `get_price_breakdown()` (SECURITY DEFINER) lee billing_plans + tenant_integrations + feature_pricing_multipliers + polling_interval_tiers → jsonb `{base_price, features, polling, total_per_doc}`. `charge_credit` migrado para leer `base_price` de `billing_plans WHERE name='basico'` con COALESCE($0.30) fallback. MonitoringPage tarjeta "Precios" con editor completo de planes, features y polling tiers. Build main-BR-UIiPb.js (2026-06-17). |
| FIX-PRICE-BREAKDOWN-MASTER | `get_price_breakdown()` no incluía `master_file`. Fix: migración `fix_get_price_breakdown_master_file` — detecta `output_enabled=true` en cualquier `tenant_integration` activa → agrega `master_file` leyendo costo de `feature_pricing_multipliers` (sin hardcodear). Verificado: Aignition retorna $0.30 + $0.20 (drive) + $0.05 (master_file) + $0.20 (polling) = $0.75 — coincide con cobro real del worker (2026-06-17). |
| FIX-GATEWAY-METADATA | `gateway.mjs`: `metadata` en payload BullMQ ahora hace spread del body original (`...(body?.metadata ?? {})`), preservando `fileMeta` de los pollers. Antes sobreescribía con objeto propio → `integration-file-mover.mjs` recibía `integration_id=undefined` → archivos quedaban en `en_proceso/` sin moverse a `procesados/`/`fallidos/`. Deploy worker v1.9.9+ (2026-06-18). Integración Supabase Storage validada e2e. |
| TASK-107 | INTEGRATION-SETUP-FOLDERS: `POST /api/integrations/init-folders` en gateway — sube `.keep` de 0 bytes a `en_proceso/`, `procesados/`, `fallidos/`, `extracciones/` en el storage del cliente (supabase_storage y firebase_storage). Drive: skip (lo maneja poller). Frontend: `handleSave` llama init-folders post-guardado; botón "Inicializar carpetas" en tarjeta activa para Supabase/Firebase. Build main-CVGdx646.js (2026-06-18). **FIX credentials (2026-06-18)**: columna `credentials` no existe — es `credentials_encrypted` (bytea). Gateway y `integration-file-mover.mjs` ahora usan `SELECT integration_type,folder_path,organization_id` + RPC `admin_get_integration_credentials` para desencriptar. También corrige bug silencioso en `integration-file-mover.mjs` que impedía mover archivos a `procesados/`/`fallidos/`. |

---

## TASK-85 — MP Webhook Receiver (✅ Validado e2e sandbox — 2026-06-14, commits f785cc1 + f7a8649)

`POST /api/mp/webhook` en `gateway.mjs`. Flujo completo validado con sandbox:

1. Gateway crea preferencia MP con `external_reference = paymentUUID` (UUID pre-generado antes del insert en DB)
2. DB insert en `payments` usa ese mismo UUID como `id`
3. MP envía IPN → handler fetch payment de la API de MP
4. Lookup: `preference_id` (prod) o `external_reference` (fallback sandbox donde `preference_id` viene null)
5. Idempotencia: si `gateway_payment_id` ya existe → skip
6. PATCH `status='approved'` + `gateway_payment_id`
7. `add_credits(p_organization_id, p_amount_usd, ...)` — SECURITY DEFINER, funciona con service key

**Nota sandbox**: MP sandbox no envía IPNs automáticamente de forma confiable. En producción con pagos reales el IPN llega solo. Para test manual: buscar el payment_id en la API de MP y hacer POST al webhook.

**MP_ACCESS_TOKEN**: restaurado a producción (`seller_id 290523599`) el 2026-06-15. El server está listo para recibir pagos reales.

---

## TASK-90 — FIX-BILLING: Cobro correcto por documento (✅ Hecho — 2026-06-17)

> ⚠️ **El fix de esta task fue reemplazado por la migración de UX-PRICE-BREAKDOWN (2026-06-17).** El registro histórico se conserva abajo, pero el comportamiento vigente en producción es el de UX-PRICE-BREAKDOWN. No confundir.

**Root cause (histórico)**: `charge_credit` RPC leía `price_per_doc` de `billing_plans` via `organization_credits.plan_id`. Todas las orgs nuevas reciben el plan "free" (trigger `trg_assign_free_plan`), cuyo `price_per_doc = $0.00`. Resultado: cobro base = $0, solo se descontaban features activas ($0.03 cada una).

**Fix TASK-90 (migración `fix_charge_credit_flat_price`, reemplazada)**: `v_base_price := 0.3000` hardcodeado — sin lookup a `billing_plans`. Era el fix de emergencia que resolvió el bug de $0.

**Fix vigente (UX-PRICE-BREAKDOWN, migración posterior)**: `charge_credit` lee `price_per_doc` de `billing_plans WHERE name='basico' AND active=true` con `COALESCE($0.30)` como fallback. El precio base es ahora **configurable desde MonitoringPage → Precios** sin redeploy. El `$0.30` hardcodeado solo actúa si el plan `basico` no existe o su `price_per_doc` es NULL.

---

## Arquitectura de créditos / billing

- `organization_credits.balance` → `numeric(12,4)` en USD
- `charge_credit(p_org_id, p_job_id, p_amount, p_description, p_features[])` — SECURITY DEFINER: descuenta `(base_price + suma_feature_costs + polling_cost) × doc_count`. **Precio base leído de `billing_plans WHERE name='basico'` → `price_per_doc`, con `COALESCE($0.30)` fallback** (UX-PRICE-BREAKDOWN, reemplazó el hardcode de TASK-90). Editable desde MonitoringPage → Precios sin redeploy.
- `feature_pricing_multipliers`: costo adicional por feature (`cost_usd`); tiene RLS con SELECT policy `authenticated_read_feature_pricing`
- `billing_plans`: planes con `price` (lo que paga el user) y `balance_usd` (crédito que recibe). **`price_per_doc` del plan `basico` es el precio base efectivo de cobro** — editable y vigente. Los demás planes tienen `price_per_doc` definido pero actualmente no se usan para cobrar (solo `basico`).
- `organization_credits.plan_id` — solo para logging/trazabilidad. No afecta el precio cobrado.
- `trg_assign_free_plan` — trigger: asigna plan "free" + $20 balance a toda org nueva. El balance $20 es intencional (trial gratuito). El plan "free" tenía `price_per_doc = $0.00` — era el root cause del bug de $0 cobrado (TASK-90, resuelto).
- **Modelo de paquetes (a implementar)**: recarga con bonus. Ej: pagar $19 → recibir $20 en balance. El bonus % varía por tramo. Pendiente de implementación formal.
- `payments`: `gateway_preference_id` (al crear preferencia), `gateway_payment_id` (al recibir IPN), `status` default `'pending'`

## Features en `feature_pricing_multipliers`

Costos reales en prod (2026-06-17):

| feature_key | label | cost_usd | active |
|---|---|---|---|
| integration_drive | Google Drive | $0.20 | true |
| integration_firebase | Firebase Storage | $0.15 | true |
| integration_sftp | SFTP | $0.03 | true |
| integration_ftp | FTP | $0.03 | true |
| master_file | Excel acumulativo | $0.05 | true |
| xlsx_output | Formato Excel (.xlsx) | $0.00 | false |
| human_review | Revisión humana | $0.00 | true |
| integration_drive_multiclient | Multi-cliente | $0.00 | false |
| polling_interval_1min | Intervalo de escucha (1 min) | $0.00 | true |

Editable desde MonitoringPage → Precios (solo superadmin) vía RPC `update_feature_cost`.

---

## TASK-105 — UX-OUTPUT-FORMAT: Selector de formato en tarjeta Google Drive

**Estado:** TODO — 🟡 Media

**Spec:**
- La tarjeta de Google Drive en `IntegracionesPage.tsx` agrega un toggle/selector "Archivo acumulativo (Excel)"
- **OFF (default):** `output_format='csv'`, `output_enabled=false` — devuelve 1 CSV por proceso, sin costo extra
- **ON:** `output_format='xlsx'`, `output_enabled=true` — genera archivo Excel acumulativo (master_file), se cobra el costo de `master_file` en `feature_pricing_multipliers`
- El precio se muestra dinámicamente desde `get_price_breakdown()` — **nunca hardcodeado**
- Al cambiar el toggle → UPDATE en `tenant_integrations` (columnas `output_format` + `output_enabled`)
- `get_price_breakdown()` ya detecta `output_enabled=true` → `master_file` automáticamente
- `xlsx_output` feature: activar con costo cuando se quiera cobrar por formato xlsx además del master_file (actualmente `active=false`, no cobra)

**Archivos a modificar:**
- `src/pages/IntegracionesPage.tsx` — agregar toggle en la tarjeta Drive
- No requiere cambios en worker ni en RPCs de billing

---

## TASK-83 — Resiliencia frontend ante extensiones (✅ Prod — 2026-06-14)

Seis fixes deployados contra pantalla en blanco causada por extensiones de browser o red lenta:

### Fix 1 — Guard `organizationId` en SubirZipPage (`daf80d5`)
`fetchProfile` puede hacer timeout → `organizationId = null` → gateway rechazaba con "Campos requeridos". Fix: `if (!organizationId) { setError(...); return; }` antes de crear el job; botón deshabilitado mientras `authLoading || !organizationId`.
- Archivo: `src/pages/SubirZipPage.tsx`

### Fix 2 — ErrorBoundary global + handler `unhandledrejection` (`956542e`)
Sin error boundary, cualquier excepción en el árbol React deja pantalla en blanco. Fix: `<ErrorBoundary>` wrapeando `<App />` muestra "Algo salió mal / Recargar página". `window.addEventListener('unhandledrejection', e => { e.preventDefault(); })` swallowea promesas externas.
- Archivos: `src/components/ErrorBoundary.tsx`, `src/main.tsx`

### Fix 3 — `fetchProfile` no limpia profile en error (`27749d4`)
`onAuthStateChange` dispara `fetchProfile` en cada refresh de token. Si fallaba, llamaba `setProfile(null)` → `isSuperadmin = false` → tab Monitoreo desaparecía. Fix: eliminar `setProfile(null)` dentro de `fetchProfile` — solo `signOut` y sesión nula limpian el profile.
- Archivo: `src/contexts/AuthContext.tsx`

### Fix 4 — Fallback HTML + reintentos automáticos (`12cfa00`)
Si el bundle es bloqueado, browser mostraba pantalla en blanco total. Fix:
- `index.html`: spinner con estilos inline visible antes del JS/CSS. Mensaje "Tardando demasiado — hacé clic para recargar" a los 8s vía CSS animation.
- `AuthContext`: `fetchProfile` reintenta hasta 3 veces (espera 1.5s y 3s entre intentos). Timeout subido de 10s a 20s.
- Archivos: `index.html`, `src/contexts/AuthContext.tsx`

### Fix 5 — Guard temprano en `index.html` (`ced328f`)
El `unhandledrejection` handler en `main.tsx` llegaba tarde — extensiones que inyectan en `document_start` podían lanzar antes. Fix: script inline en `<head>` antes de cualquier recurso externo que captura `window.__nativeFetch` y registra el handler temprano.
- Archivo: `index.html`

### Fix 6 — Supabase usa `__nativeFetch` para sobrevivir monkey-patching (`ced328f`)
SDKs como Amplitude parchean `window.fetch`. Si fallan con 401, el fetch parcheado queda roto → Supabase no puede operar. Fix: `index.html` guarda `window.__nativeFetch` antes que cualquier extensión; `src/lib/supabase.ts` usa `global: { fetch: window.__nativeFetch ?? fetch }`.
- Archivos: `index.html`, `src/lib/supabase.ts`

---

## TASK-84 — Fix MonitoringPage Tenants (✅ Prod — 2026-06-14)

Tarjeta Tenants mostraba solo la org propia del superadmin. Queries directas a `organization_credits` y `organizations` son filtradas por RLS sin importar `is_superadmin`. Fix: dos RPCs `SECURITY DEFINER`:
- `get_all_tenants_admin()` → todas las orgs con nombre, balance y `is_active`
- `get_tenant_jobs_admin(p_org_id uuid)` → últimos 50 jobs de cualquier tenant

MonitoringPage actualizado para usar estas RPCs. Commit `9fd576c`.
- Archivo: `src/pages/MonitoringPage.tsx`

---

## FIX-REG — Fix registro: organization_name (✅ Prod — 2026-06-14)

Trigger `handle_new_user()` lee `organization_name` desde `raw_user_meta_data`. El frontend no lo pasaba → todas las orgs se creaban como "Organización sin nombre". Además el frontend intentaba insertar org+profile manualmente → PK duplicada en profiles.

**Fix**: `LoginPage.tsx` pasa `options: { data: { organization_name: organizationName.trim() } }` en `signUp`. Eliminados los inserts manuales de `organizations` y `profiles`.

**Regla permanente**: El trigger `on_auth_user_created → handle_new_user()` crea org + profile automáticamente. El frontend NUNCA debe insertar org/profile manualmente.

Limpieza en prod: 3 orgs renombradas, 8 huérfanas eliminadas.

---

## FIX-AUTH-LOCK — Fix spinner 20s en F5 y flash de métricas en cero (✅ Prod — 2026-06-15, commit `972ab03`)

**Root cause**: `onAuthStateChange` callback era `async` y hacía `await fetchProfile()` (hasta 19.5s con reintentos). Supabase v2 mantiene el session lock interno (`_acquireLock`) durante toda la ejecución del callback. Esto bloqueaba `getSession()` el mismo tiempo → `loading` se quedaba `true` hasta que el timeout de 20s disparaba.

**Fix `AuthContext`**:
- Callback de `onAuthStateChange` es ahora **síncrono** (sin `async`/`await`).
- `setLoading(false)` se llama inmediatamente al conocer la sesión.
- `fetchProfile` corre en `Promise.resolve().then(async () => { ... })` — ejecuta en el siguiente tick, después de que el lock se libera.
- Archivos: `src/contexts/AuthContext.tsx`

**Fix `useClientJobs`** (flash de ceros en dashboard):
- Agrega guard `if (authLoading) return` — espera a que auth resuelva antes de decidir.
- Si `authLoading=false` pero `organizationId=null`: mantener `loading=true` (profile aún llega en background).
- `authLoading` incluido en deps del `useEffect` y en el `loading` retornado.
- Archivo: `src/hooks/useClientJobs.ts`

**Regla permanente**: el callback de `onAuthStateChange` **nunca puede ser async ni hacer await**. Cualquier trabajo async post-auth va en `Promise.resolve().then()` fuera del callback.

---

## Patrones clave del frontend

### `src/lib/supabase.ts`
Usa `window.__nativeFetch` para proteger llamadas de monkey-patching de extensiones. **NO reemplazar por `fetch` directo** sin evaluar impacto.

### Sidebar balance (`AppShell.tsx`)
Tres estados: skeleton (`creditsLoading`) → rojo "Sin saldo" (`balance <= 0`) → verde con monto.
`noCredits = !creditsLoading && balance !== null && balance <= 0`
El estado "sin saldo" es un `<button>` clickeable que abre `InsufficientCreditsModal` (`setShowRecharge(true)`). No es un `div` estático.

### `useTenantCredits` hook
- Early return si `authLoading` (evita flash de "Sin saldo")
- Si `authLoading=false` pero `organizationId=null`: **no** limpiar balance ni bajar `loading` — el profile aún llega en background. El efecto se re-ejecuta cuando `organizationId` aparece.
- Realtime subscription + polling fallback `setInterval(15_000)`
- `return { balance, loading: loading || authLoading }`

### `AuthContext`
- **`onAuthStateChange` callback es SÍNCRONO** — no `async`, no `await` dentro. Supabase v2 mantiene el session lock (`_acquireLock`) durante la ejecución del callback. Si el callback es async y espera `fetchProfile()` (~19.5s), `getSession()` queda bloqueado igual tiempo → spinner 20s. Fix: callback síncrono + `Promise.resolve().then(async () => fetchProfile(...))` para correr fuera del lock.
- `setLoading(false)` se llama **inmediatamente** en `onAuthStateChange` y en `getSession().then()` — antes de cualquier fetch. No bloquear la UI esperando el profile.
- `fetchProfile` corre siempre en background (fire-and-forget) — **nunca `await` en los handlers de auth**.
- `fetchProfile` NO llama `setProfile(null)` en error — preserva el profile cargado
- Reintenta 3 veces (espera 1.5s y 3s). Timeout 5s por intento
- Solo `signOut` y `onAuthStateChange` con session=null limpian el profile

### Hooks con `authLoading` guard (evitar flash de ceros)
Los hooks `useTenantCredits` y `useClientJobs` tienen este patrón:
```ts
if (authLoading) return;           // esperar a que auth resuelva
if (!organizationId) return;       // profile aún carga en background — mantener loading=true
```
El `loading` que retornan incluye `|| authLoading`. **No romper este patrón** — sin él, los componentes renderizan con datos vacíos/cero y luego parpadean cuando llegan los datos reales.

### Rutas protegidas
- Layout route con `<Outlet />` en `App.tsx` — `AppShell` se monta una sola vez
- `SuperadminRoute` component — `MonitoringPage` solo visible para superadmins
- Worker health check header: `Authorization: Bearer staging-key-2026`

### Tipografía
- **Inter** (sans): UI general
- **Lora** (serif, class `font-lora`): números en tarjetas métricas (`MonitoringPage`, `ClientDashboardPage`)
- Google Fonts en `index.html`; `fontFamily.lora` en `tailwind.config.js`

---

## RPCs Supabase relevantes

| RPC | Tipo | Propósito |
|-----|------|-----------|
| `charge_credit(p_org_id, p_amount_usd)` | SECURITY DEFINER | Descontar saldo por doc procesado |
| `add_credits(p_organization_id, p_amount_usd, p_plan_id, p_description, p_gateway_payment_id)` | SECURITY DEFINER | Agregar saldo + registra en `credit_transactions`. **Usar desde gateway/service key** |
| `add_credits_admin(p_org_id, p_amount_usd)` | requiere `auth.uid()` superadmin | Agregar saldo desde UI. **NO funciona con service key** |
| `approve_document_row(p_row_id bigint)` | — | Aprueba doc + incrementa `corrected_documents`; si todos ok → job a `done` |
