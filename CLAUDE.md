# DataLand V2.0 — Contexto del proyecto

## 🧭 División de trabajo (leer primero)

- **Cowork (este entorno)**: DB (Supabase MCP: migraciones, RPCs, triggers, queries), código (frontend + worker: leer/editar), análisis y documentación (Notion + este CLAUDE.md). **No hace** deploy/git/SSH.
- **Claude Code CLI**: servidor y despliegue — `git`, `ssh` al VPS, `npm run build`, `scp` frontend, `docker compose` worker. Cowork le pasa los comandos.
- **No mezclar**: Cowork prepara (DB directo; código en el repo); Claude Code buildea/commitea/deploya.
- **Sync OneDrive**: hay latencia entre lo que Cowork edita y lo que Claude Code/git ven. Si un build no toma un cambio, esperar/reintentar y verificar con `grep`.
- **Riesgo de truncado al editar (2026-06-23)**: en archivos grandes de OneDrive, una edición puede dejar el archivo **truncado en disco** (pierde el final) mientras la relectura muestra una versión vieja/completa. Verificar SIEMPRE con build/parse (`npx esbuild <archivo> --loader:.tsx=tsx --bundle=false --format=esm --outfile=/dev/null` o `npx tsc --noEmit`) + balance `()`/`{}` + `git diff --stat` antes de commitear. Para edits grandes en esta carpeta, preferir escribir vía python/bash. (Caso real: MonitoringPage.tsx, CLAUDE.md y DocumentsTable.tsx se truncaron el 2026-06-23.)

> **Regla de oro**: las zonas cerradas no se tocan salvo tarea explícita. Ante la duda, señalar impacto y **preguntar ANTES de ejecutar**. Producción con clientes activos: estabilidad > velocidad.

---

## 🔒 ZONA CERRADA — no tocar sin tarea explícita

### Auth / Frontend loading
- `AuthContext.tsx` — callback `onAuthStateChange` **SÍNCRONO** (sin async/await). Supabase v2 retiene el session lock durante el callback: si es async y espera `fetchProfile()` (~19.5s), `getSession()` se bloquea igual → spinner 20s. `setLoading(false)` inmediato al conocer sesión; `fetchProfile` en `Promise.resolve().then(...)` (fuera del lock), fire-and-forget, NO llama `setProfile(null)` en error, reintenta 3× (1.5s/3s, timeout 5s). Solo `signOut`/sesión nula limpian profile.
- **Patrón hooks con guard** (`useTenantCredits`, `useClientJobs`): `if (authLoading) return` → `if (!organizationId) return` (mantener `loading=true`, el profile llega en background); el `loading` retornado incluye `|| authLoading`. Sin esto los componentes parpadean con ceros. Ambos tienen Realtime + polling fallback (15s/8s).
- `supabase.ts` — usa `window.__nativeFetch` (SDKs como Amplitude parchean `window.fetch` y lo rompen). No reemplazar por `fetch` directo.
- `index.html` — spinner inline + guard `__nativeFetch` en `<head>` antes de cualquier recurso externo; mensaje "Tardando demasiado" a los 8s. `<ErrorBoundary>` en `main.tsx` + handler `unhandledrejection`. No mover/eliminar.
- `AppShell.tsx` sidebar balance — 3 estados: skeleton (`creditsLoading`) → rojo "Sin saldo" (`balance<=0`, es un `<button>` que abre `InsufficientCreditsModal`) → verde con monto. No convertir en `div`.

### Billing / Pagos
- `POST /api/mp/webhook` (gateway.mjs) — IPN validado e2e. No tocar lookup `preference_id`/`external_reference` ni idempotencia por `gateway_payment_id`.
- `create-preference`/`create-custom-preference` — generan UUID antes del INSERT y pasan `external_reference`. No cambiar el orden.
- RPC `add_credits(...)` — SECURITY DEFINER, solo desde gateway con service key, nunca frontend.
- `MP_ACCESS_TOKEN` — producción (`seller_id 290523599`). No usar sandbox.
- RPC `charge_credit(...)` — costo = `(base + features activas + polling) × docs`. Base = `billing_plans.price_per_doc` del plan `basico` (COALESCE $0.30). **Cambiar precio base = editar ese campo desde MonitoringPage → Precios** (efecto inmediato sin redeploy). Acepta `p_polling_interval_minutes` → `polling_interval_tiers.cost_per_doc`.
- `polling_interval_tiers` — 12 tramos (1-120 min), `active` controla visibilidad; editable desde MonitoringPage→Precios vía RPC `update_polling_tier` (superadmin). No hardcodear.

### Google Drive OAuth
- `VITE_GOOGLE_CLIENT_ID=59795666065-qhm5r5p4q9rj8glpauhir6a6r4uen4sj.apps.googleusercontent.com` (identifica la app, no al tenant).
- `VITE_GOOGLE_REDIRECT_URI=https://dataland.aignition.net/worker/api/auth/google/callback` — debe coincidir con el `.env` del worker y Google Cloud Console. NO `automation.aignition.net`.
- `integration-poller.mjs` encola con `${gatewayUrl}/api/enqueue`. `worker.mjs:GATEWAY_URL` = base sin path (`https://automation.aignition.net/worker`), no agregar `/api/enqueue`.

### Seguridad / DB
- `tenant_integrations.credentials` **NO existe** — están en `credentials_encrypted` (bytea). Leer vía RPC `admin_get_integration_credentials(p_integration_id, p_org_id)`. En REST seleccionar `integration_type, folder_path, organization_id` (nunca `credentials`).
- `integration_processed_files` — RLS ON (políticas `tenant_select_own`/`tenant_insert_own`). No deshabilitar.
- Trigger `on_auth_user_created → handle_new_user()` crea org+profile automáticamente. El frontend **nunca** inserta org/profile.
- RPCs SECURITY DEFINER (`charge_credit`, `add_credits`, `get_all_tenants_admin`, `get_tenant_jobs_admin`, `approve_document_row`) — no eliminar/modificar sin evaluar RLS. ⚠️ En RPCs con `RETURNS TABLE(id ...)`, calificar SIEMPRE las columnas en subqueries internas (`profiles.id = auth.uid()`) o Postgres lanza `42702 ambiguous` (bug de TASK-95).

### Realtime
- Publicación `supabase_realtime`: `pdf_jobs` y `pdf_job_rows` habilitadas (migración `enable_realtime_pdf_jobs`). No remover.
- Nombres de canal — NO duplicar: `useClientJobs`→`'pdf_jobs_changes'`; `usePdfJobs`→`'mis_procesos_jobs_changes'`+`'mis_procesos_rows_changes'`. Dos hooks con el mismo nombre corrompen la subscripción.
- Polling de respaldo (8s/5s) activa solo con jobs `pending`/`processing`; depende de Realtime para el INSERT inicial.

### Período de jobs (la DB es la única fuente)
- Trigger `trg_set_pdf_job_period` (BEFORE INSERT en `pdf_jobs`) setea `period_month`/`period_year` desde `created_at` en horario `America/Argentina/Buenos_Aires`, **override siempre**, universal (manual/drive/supabase/firebase). Período = mes de **procesamiento** (base de consumo por mes). NO toca `pdf_job_rows.fecha` (dato del OCR). El frontend ya NO envía período. No volver a setearlo desde frontend/gateway.

### Observabilidad
- Sentry (`@sentry/react` + vite-plugin, source maps). `SENTRY_AUTH_TOKEN` env var real al buildear.
- `GET /api/metrics` (gateway) proxy a `metrics.mjs:9090`, consumido por MonitoringPage. No cambiar ruta/auth.

### Deploy (reglas)
- Worker: SIEMPRE `docker compose build && docker compose up -d --force-recreate` desde `/root/worker/`. NUNCA `docker run` manual (queda en `caddy_net` y Caddy no alcanza `:3001`).
- Frontend: `npm run build` → `rm -rf /var/www/dataland/assets` → `scp -r dist/.`. NUNCA Netlify ni git pull en el server.
- `VITE_WORKER_GATEWAY_URL` = base SIN path (cada archivo appenda su endpoint).

### Pipeline de integración (worker) — CERRADO
Validado y estabilizado. No tocar sin tarea explícita.
- `poller-handoff.mjs` — central compartido: SHA256, dedup (`admin_register_processed_file`), upload a Aurora Storage, enqueue. Toda integración nueva lo usa, no duplicar.
- `integration-file-mover.mjs` — mueve `en_proceso/`→`procesados/`/`fallidos/` post-worker (llamado desde worker.mjs). Credenciales vía `credentials_encrypted` + RPC desencriptar.
- `gateway.mjs` — rutas, billing, IPN, VALID_SOURCES. `metadata` hace spread del body (`...(body?.metadata ?? {})`) para preservar `fileMeta` de pollers (`integration_id`, etc.); sin eso file-mover no mueve.
- `document-processor.mjs` (OCR+IA), `worker.mjs` (BullMQ + cron), `supabase-storage-poller.mjs`, `firebase-storage-poller.mjs`, `output-depositor.mjs` (CSV/XLSX → `extracciones/`). `integration-poller.mjs` (Drive, prod) — tocar SOLO para TASK-96.
- **Estructura de carpetas uniforme**: usuario suelta en raíz/carpeta → poller mueve a `en_proceso/` → worker a `procesados/`/`fallidos/` → output a `extracciones/`.
- **Agregar integración** = `worker/{nombre}-poller.mjs` (list+download+move a `en_proceso/` + `uploadAndEnqueue` con `fileMeta`) + `input_source` al CHECK de `pdf_jobs` y a `VALID_SOURCES`. El movimiento post-worker es automático.
- **Archivos rechazados** (formato no soportado): cada poller llama `registerRejectedFile` (poller-handoff) → RPC `gateway_register_rejected_file` crea un `pdf_jobs` `status='error'`, `error_type='rejected'` con la razón en `error_message`, y mueve el archivo a `{cliente}/fallidos/`. Universal, no se cobra, el front lo muestra como Fallido (TASK-110).

---

## Decisiones clave (fuente: Decisions Log en Notion)

- **DEC-007 (enmendado) + DEC-017** — DB vs worker: *procesamiento/lógica compleja* (OCR, IA, parseo, merge OCs, cálculos, deps externas o multi-entidad) → **Worker**. *Derivación determinística sobre una sola fila* (ej. `doc_status` vía `classify_pdf_job_row`; conteos vía `trg_sync_job_counts_rows`) → **aceptable en DB**. La clasificación de `doc_status` se mantiene en el trigger por escala; migrar al worker SOLO al cruzar gatillos de DEC-017 (deps externas tipo AFIP/histórico/comparación entre docs; o CPU>70% / p95 degradada / millones de filas / límites del plan). Pendiente: **TEST-CLASSIFY-TRIGGER**.
- **DEC-011** — N8N eliminado del pipeline. No existe, no referenciar.

## Stack

React 18 + TS + Vite + shadcn/ui + Tailwind · Supabase (PostgreSQL + RLS + Realtime) · Worker Node ESM (`worker/*.mjs`) en Docker (VPS DigitalOcean) · BullMQ + Redis Cloud (sa-east-1), queue `pdf-processing` · MercadoPago IPN · Integraciones: Google Drive ✅, Firebase Storage ✅, Supabase Storage ✅, SFTP ⛔.

## Producción

- **Frontend**: `https://dataland.aignition.net` → VPS `root@157.230.231.207:/var/www/dataland/`
- **Worker/gateway**: `v1.9.9` en `root@157.230.231.207:/root/worker/` (Docker Compose)
- **Supabase**: `klhbgsiatzbmxbkzpbzv`
- **Superadmins** (DB, `is_superadmin=true`): `sbrasesco@outlook.es`, `javierginez@gmail.com`. ⚠️ `arcademy.dev@gmail.com` NO figura como superadmin en DB.

## Deploy workflow

```bash
# Frontend — siempre SCP, nunca Netlify ni git pull
npm run build
rm -rf /var/www/dataland/assets
scp -r dist/. root@157.230.231.207:/var/www/dataland/
# Worker — siempre docker compose, nunca docker run manual
scp worker/*.mjs root@157.230.231.207:/root/worker/
ssh root@157.230.231.207 "cd /root/worker && docker compose build && docker compose up -d --force-recreate"
# Verificar: docker logs dl-worker --tail 30 ; curl -s http://localhost:3001/health
```

## Pipeline (estado real)

```
Frontend / Integration poller → POST /api/enqueue → gateway.mjs (:3001)
  → BullMQ "pdf-processing" (Redis) → worker.mjs → document-processor.mjs
  → Supabase (resultados) + Drive/Firebase/Supabase (outputs)
```

- **gateway.mjs rutas**: `POST /api/enqueue` (Bearer) · `/api/mp/create-preference` + `create-custom-preference` (Bearer) · `/api/mp/webhook` (sin auth, IPN) · `/api/deposit-row` (Bearer) · `/api/drive/folders` + `set-folder` (Bearer) · `/api/auth/google/callback` (sin auth) · `/api/integrations/init-folders` + `test-connection` + `migrate-folders` (Bearer) · `/api/metrics` (Bearer, proxy :9090) · `/health`.
- **metrics.mjs (:9090)**: queue_depth (waiting/active/delayed), latency_ms (p50/p95/avg), error_rate_pct, totals. Consumido por MonitoringPage vía `/api/metrics`.
- **Env worker** (`/root/worker/.env`): `REDIS_HOST/PORT/PASSWORD`, `SUPABASE_URL/SERVICE_KEY`, `WORKER_CONCURRENCY=3`, `WORKER_VERSION`, `METRICS_PORT=9090`, `GATEWAY_PORT=3001`, `GATEWAY_API_KEY`, `MP_ACCESS_TOKEN`, `GATEWAY_URL=https://automation.aignition.net/worker`, `STORAGE_BUCKET=facturas`, `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `FRONTEND_URL`, `NODE_ENV=production`. **Frontend**: `VITE_WORKER_API_KEY=staging-key-2026`, `VITE_WORKER_GATEWAY_URL` (base sin path).

## Frontend (misc)

- Rutas: layout con `<Outlet />` en `App.tsx` (AppShell se monta una sola vez); `SuperadminRoute` para MonitoringPage. Health header `Authorization: Bearer staging-key-2026`.
- Tipografía: **Inter** (UI) + **Lora** (`font-lora`, números en tarjetas métricas). Google Fonts en `index.html`.

---

## Billing / créditos

- `organization_credits.balance` numeric(12,4) USD. `plan_id` solo logging/trazabilidad.
- `charge_credit(...)` SECURITY DEFINER: descuenta `(base + features + polling) × docs`. Base = `billing_plans.price_per_doc` del plan `basico` (COALESCE $0.30 si NULL/ausente). Editable desde MonitoringPage→Precios sin redeploy. (Reemplazó el hardcode de TASK-90.)
- `feature_pricing_multipliers` (cost_usd; RLS read `authenticated_read_feature_pricing`). `get_price_breakdown()` SECURITY DEFINER → jsonb `{base_price, features, polling, total_per_doc}` (lee billing_plans + tenant_integrations + features + polling_tiers; `master_file` solo drive+xlsx).
- `trg_assign_free_plan` — plan "free" + $20 balance a org nueva (trial intencional).
- `payments`: `gateway_preference_id` (al crear), `gateway_payment_id` (al IPN), `status` default `pending`.
- **Pendiente**: modelo de paquetes con bonus (ej. pagar $19 → $20 balance).

### feature_pricing_multipliers (prod — ⚠️ precios DINÁMICOS, no fijos)

| key | label | cost_usd | active |
|---|---|---|---|
| integration_drive | Google Drive | $0.20 | true |
| integration_firebase | Firebase Storage | $0.15 | true |
| integration_supabase | Supabase Storage | $0.15 | true |
| integration_sftp / ftp | SFTP / FTP | $0.03 | true |
| master_file | Excel acumulativo | $0.05 | true |
| xlsx_output | Formato Excel (.xlsx) | $0.00 | false |
| human_review | Revisión humana | $0.00 | true |
| polling_interval_1min | Escucha 1 min | $0.00 | true |

Editable desde MonitoringPage→Precios (superadmin) vía RPC `update_feature_cost`. Los montos "validados" en el historial son la config de ese momento, no valores hardcodeados.

### document_types (config global — NO hardcodear)
Tabla `document_types` (code, label, sort_order, active), RLS read `authenticated_read_document_types`. `code` = valor canónico de `pdf_job_rows.tipo_documento` que produce la IA: `FACTURA_A/B/C/M`, `NOTA_DEBITO_A/B/C`, `NOTA_CREDITO_A/B/C`, `ORDEN_COMPRA`, `SOLICITUD_COTIZACION` (fuente: prompt en `document-processor.mjs`). El dropdown de edición manual (`EditRowModal` vía hook `useDocumentTypes`) muestra `label` y guarda `code`. Alta de tipo = INSERT, sin redeploy. Global por ahora (regionalización por país = futuro). Panel admin pendiente (TASK-111).

## RPCs relevantes

| RPC | Tipo | Propósito |
|---|---|---|
| `charge_credit(p_org_id, p_amount_usd, ...)` | SEC DEFINER | Descontar saldo por doc procesado |
| `add_credits(p_organization_id, ...)` | SEC DEFINER | Agregar saldo + `credit_transactions`. Desde gateway/service key |
| `add_credits_admin(p_org_id, p_amount_usd)` | requiere superadmin `auth.uid()` | Agregar saldo desde UI (NO service key) |
| `approve_document_row(p_row_id bigint)` | — | Aprueba doc + `corrected_documents`; si todos ok → job `done` |
| `get_all_tenants_admin()` / `get_tenant_jobs_admin(p_org_id)` | SEC DEFINER | Panel superadmin (bypass RLS) |
| `gateway_create_pdf_job(...)` | SEC DEFINER | Crea `pdf_jobs` desde integraciones |
| `get_price_breakdown()` | SEC DEFINER | Desglose de costo por doc |
| `gateway_register_rejected_file(...)` | SEC DEFINER | Crea `pdf_jobs` error_type='rejected' para archivo rechazado (TASK-110) |

---

## Tareas

### 🟡 Backlog

| Task | Descripción | Prioridad |
|---|---|---|
| **TASK-108** | SCOPE-ATTACHMENT-EXTRACTION: limitar extracción de adjuntos (pdfdetach+mutool+PyMuPDF) a un tenant/integración vía flag (default OFF). Hoy global; necesidad de 1 cliente | 🟡 Media |
| **TASK-109** | JOB-FILE-MANIFEST (fase 2 de TASK-93): worker registra manifiesto de archivos por job (nombres+estado/motivo) para nombrar los no procesados. Tabla `pdf_job_files` (org_id+RLS) vs jsonb; punto en `zip-processor.mjs` | 🟡 Media |
| **TASK-111** | ADMIN-DOCUMENT-TYPES: panel superadmin para administrar `document_types` (alta/edición/activar) sin SQL, estilo panel Precios. RPCs `upsert_document_type`/`toggle_document_type`. `code` inmutable | 🟡 Media |
| **TASK-105** | UX-OUTPUT-FORMAT: toggle "Archivo acumulativo (Excel)" en tarjeta Drive (`IntegracionesPage`). OFF=csv/`output_enabled=false`; ON=xlsx/`output_enabled=true` (cobra master_file). Precio dinámico de `get_price_breakdown()`. Solo frontend | 🟡 Media |
| **TASK-99** | UX-CLARIFY-UPLOADER | 🟡 Media |
| **TASK-100** | UX-DRAG-DROP | 🟡 Media |
| **TASK-101** | UX-REMOVE-REDUNDANT-BUTTON | 🟡 Media |
| **TASK-102** | AI-REFINE-PROMPT: ajustar prompt para facturas de servicios | 🟡 Media |
| **TASK-86** | FIX-CLEANUP: limpiar refs n8n restantes | 🟡 Media |
| **TASK-103** | RESEARCH-AFIP: investigar integración validación AFIP | 🟢 Baja |
| **TEST-CLASSIFY-TRIGGER** | Tests del trigger `classify_pdf_job_row` (ver DEC-017) | 🟢 Baja |
| **TASK-66** | Landing visual refinement — dejar para el final | — |

### ✅ Completadas (en prod)

**Sesión 2026-06-23**: **TASK-92** estados de documento estandarizados (trigger `classify_pdf_job_row` reescrito: `failed` solo si error real o leído sin ningún dato; baja confianza/campos faltantes → `warning`; respeta `approved_at`; fix bug `NULL IN(...)`. Vocabulario unificado a **Exitoso/Con advertencia/Fallido**. Columna "Estado" por-documento en `DocumentsTable`). · **TASK-93** aviso de discrepancia (`getDocDiscrepancy` + `JobDiscrepancyNotice` en ProcesoDetailPage; gap real vs anomalía de conteo; no lista nombres → TASK-109) + **UX-JOB-ALLFAILED** (job 100% fallido → "Fallido" en JobList/JobDetailHeader/JobStatusBadge/MonitoringPage). · **TASK-94 + TASK-97** período = mes de procesamiento universal (trigger `trg_set_pdf_job_period`, backfill hecho) + quitado el selector Mes/Año del subidor. · **TASK-95** Activity vacía: causa raíz = RPC `get_tenant_jobs_admin` con `id` ambiguo (migración `fix_get_tenant_jobs_admin_ambiguous_id`) + empty-state + manejo de error. · **TASK-96** carpeta de errores en Drive (no-soportados → `fallidos/`; + soporte `.rar`). · **TASK-110** archivos rechazados visibles como proceso fallido (universal, todas las integraciones): RPC `gateway_register_rejected_file` + `error_type='rejected'` + helper compartido `registerRejectedFile`; el front ya los muestra como Fallido con la razón (nombre + formato). · Builds: `main-8UVxgJRP.js`, `main-D8Ivc5LK.js`; worker f4987cb+.

**Previas**: TASK-73 (Excel acumulativo Drive) · TASK-78 (Drive por cliente) · TASK-79 (`input_source` + filtro cliente) · TASK-80 (edición/aprobación manual de docs con error) · TASK-81 (saldo USD) · TASK-82 (panel Monitoreo superadmin) · TASK-83 (resiliencia frontend ante extensiones, 6 fixes → reglas en ZONA CERRADA/Auth) · TASK-84 (MonitoringPage Tenants vía RPC bypass RLS) · TASK-85 (MP webhook IPN, validado e2e) · TASK-87 (RLS `integration_processed_files`) · TASK-90 → **UX-PRICE-BREAKDOWN** (precio base configurable; `get_price_breakdown()`) · TASK-91 (validación email/CUIT duplicado) · REG-TAXID (CUIT obligatorio en registro) · TASK-104 (`polling_interval_tiers`) · TASK-106 (Supabase Storage e2e) · TASK-107 (init-folders) · INT-TEST-CONNECTION · INT-FOLDER-MIGRATION · FIX-GATEWAY-METADATA (spread de `metadata`) · Sentry · UX-BALANCE · FIX-AUTH-LOAD / FIX-AUTH-LOCK (reglas en ZONA CERRADA/Auth) · FIX-REG (trigger crea org+profile). · **TASK-98** tipo de documento como dropdown desde tabla `document_types` (no hardcode; muestra label, guarda code; build main-DCAXe0jM.js).
