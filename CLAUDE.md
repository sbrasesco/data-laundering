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
- `poller-handoff.mjs` — central compartido: upload a Aurora Storage, enqueue. **Dedup por SHA256/drive_file_id RETIRADO (DEC-019, 2026-06-24)**: los pollers ya NO deduplican; levantan y procesan todo lo que haya (el usuario es responsable de lo que sube). Garantía de procesamiento único = el archivo **sale de la raíz** (move a `en_proceso/`); por eso ahora **se encola SOLO si ese move tuvo éxito** (si no, no se encola → no se recobra). Las copias en `en_proceso/procesados/fallidos` del cliente llevan **prefijo timestamp** (`{Date.now()}_{nombre}`) para que nombres repetidos no choquen (fix 2026-06-24; Supabase/Firebase. Drive mueve por ID, no aplica). El `original_filename` del documento conserva el nombre real; solo la copia archivada lleva el prefijo. Toda integración nueva lo usa, no duplicar.
- `integration-file-mover.mjs` — mueve `en_proceso/`→`procesados/`/`fallidos/` post-worker (llamado desde worker.mjs). Credenciales vía `credentials_encrypted` + RPC desencriptar.
- `gateway.mjs` — rutas, billing, IPN, VALID_SOURCES. `metadata` hace spread del body (`...(body?.metadata ?? {})`) para preservar `fileMeta` de pollers (`integration_id`, etc.); sin eso file-mover no mueve.
- `document-processor.mjs` (OCR+IA), `worker.mjs` (BullMQ + cron), `supabase-storage-poller.mjs`, `firebase-storage-poller.mjs`, `output-depositor.mjs` (CSV/XLSX → `extracciones/`). `integration-poller.mjs` (Drive, prod) — tocar SOLO para TASK-96.
- **Extracción de adjuntos embebidos** (pdfdetach+mutool+PyMuPDF en `zip-processor.mjs`, vía ZIP y PDF suelto) está **gateada por org** (TASK-108): corre solo si `tenant_feature_flags.extract_embedded_attachments=true` para esa organización (default false). El worker lee el flag con `getExtractAttachmentsFlag` (`worker.mjs`) y lo pasa a `processZip`; OFF → `pdfFiles=[]` → 0 OCs, no se cobran adjuntos. Hoy ON solo Aignition.
- **Estructura de carpetas uniforme**: usuario suelta en raíz/carpeta → poller mueve a `en_proceso/` → worker a `procesados/`/`fallidos/` → output a `extracciones/`.
- **Agregar integración** = `worker/{nombre}-poller.mjs` (list+download+move a `en_proceso/` + `uploadAndEnqueue` con `fileMeta`) + `input_source` al CHECK de `pdf_jobs` y a `VALID_SOURCES`. El movimiento post-worker es automático.
- **Archivos rechazados** (formato no soportado): cada poller llama `registerRejectedFile` (poller-handoff) → RPC `gateway_register_rejected_file` crea un `pdf_jobs` `status='error'`, `error_type='rejected'` con la razón en `error_message`, y mueve el archivo a `{cliente}/fallidos/`. Universal, no se cobra, el front lo muestra como Fallido (TASK-110).

---

## Decisiones clave (fuente: Decisions Log en Notion)

- **DEC-007 (enmendado) + DEC-017** — DB vs worker: *procesamiento/lógica compleja* (OCR, IA, parseo, merge OCs, cálculos, deps externas o multi-entidad) → **Worker**. *Derivación determinística sobre una sola fila* (ej. `doc_status` vía `classify_pdf_job_row`; conteos vía `trg_sync_job_counts_rows`) → **aceptable en DB**. La clasificación de `doc_status` se mantiene en el trigger por escala; migrar al worker SOLO al cruzar gatillos de DEC-017 (deps externas tipo AFIP/histórico/comparación entre docs; o CPU>70% / p95 degradada / millones de filas / límites del plan). Pendiente: **TEST-CLASSIFY-TRIGGER**.
- **DEC-011** — N8N eliminado del pipeline. No existe, no referenciar.
- **DEC-018** — Regionalización multi-país = escalado futuro: país como dimensión de primer nivel (prompt + `document_types.country` + modelo de campos genérico tipo `tax_id`); prompt-por-país y prompt-en-DB se hacen dentro de ese épico. Hoy solo AR. Seguimiento: Kanban TASK-113.

## Stack

React 18 + TS + Vite + shadcn/ui + Tailwind · Supabase (PostgreSQL + RLS + Realtime) · Worker Node ESM (`worker/*.mjs`) en Docker (VPS DigitalOcean) · BullMQ + Redis Cloud (sa-east-1), queue `pdf-processing` · MercadoPago IPN · Integraciones: Google Drive ✅, Firebase Storage ✅, Supabase Storage ✅, SFTP ⛔.

## Producción

- **Frontend**: `https://dataland.aignition.net` → VPS `root@157.230.231.207:/var/www/dataland/`
- **Worker/gateway**: `v1.9.9` en `root@157.230.231.207:/root/worker/` (Docker Compose). Commits worker recientes: f4987cb (TASK-96) + TASK-110 + TASK-114; **7f568fe** = TASK-108 (gateo de adjuntos por org) + DEC-019/REMOVE-DEDUP (pollers sin dedup) DEPLOYADO 2026-06-24.
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

- **gateway.mjs rutas**: `POST /api/enqueue` (Bearer) · `/api/mp/create-preference` + `create-custom-preference` (Bearer) · `/api/mp/webhook` (sin auth, IPN) · `/api/deposit-row` (Bearer) · `/api/drive/folders` + `set-folder` (Bearer) · `/api/auth/google/callback` (sin auth) · `/api/integrations/init-folders` + `test-connection` + `migrate-folders` (Bearer) · `/api/metrics` (Bearer, proxy :9090) · `/api/prompt` (Bearer, prompt del extractor read-only, TASK-114) · `/health`.
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
Tabla `document_types` (code, label, sort_order, active), RLS read `authenticated_read_document_types`. `code` = valor canónico de `pdf_job_rows.tipo_documento` que produce la IA: `FACTURA_A/B/C/M`, `NOTA_DEBITO_A/B/C`, `NOTA_CREDITO_A/B/C`, `ORDEN_COMPRA`, `SOLICITUD_COTIZACION` (fuente: prompt en `document-processor.mjs`). El dropdown de edición manual (`EditRowModal` vía hook `useDocumentTypes`) muestra `label` y guarda `code`. Alta de tipo = INSERT, sin redeploy. Global por ahora (regionalización por país = futuro). Panel admin superadmin en MonitoringPage→Tipos de doc (TASK-111, RPCs `upsert_document_type`/`toggle_document_type`; ✅ en prod).

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
| `upsert_document_type(p_code, p_label, p_sort_order?, p_active?)` | SEC DEFINER + guard superadmin | Alta/edición de `document_types`. `code` normalizado a mayúsculas e inmutable (clave de conflicto); `sort_order` default max+10 (TASK-111) |
| `toggle_document_type(p_code, p_active)` | SEC DEFINER + guard superadmin | Activa/desactiva un tipo de documento (TASK-111) |
| `get_tenant_attachment_flags()` / `set_tenant_attachment_extraction(p_org_id, p_value)` | SEC DEFINER + guard superadmin | Leer/setear el flag `extract_embedded_attachments` por tenant (upsert en `tenant_feature_flags`). Toggle de TASK-108 en MonitoringPage→Tenants |

---

## Tareas

### 🟡 Backlog

| Task | Descripción | Prioridad |
|---|---|---|
| **TASK-105** | UX-OUTPUT-FORMAT: toggle "Archivo acumulativo (Excel)" en tarjeta Drive (`IntegracionesPage`). OFF=csv/`output_enabled=false`; ON=xlsx/`output_enabled=true` (cobra master_file). Precio dinámico de `get_price_breakdown()`. Solo frontend | 🟡 Media |
| **TASK-102** | AI-REFINE-PROMPT: ajustar prompt para facturas de servicios | 🟡 Media |
| **TASK-86** | FIX-CLEANUP: limpiar refs n8n restantes | 🟡 Media |
| **TASK-103** | RESEARCH-AFIP: investigar integración validación AFIP | 🟢 Baja |
| **TASK-113** | ÉPICO REGIONALIZACIÓN multi-país (escalado futuro, DEC-018): país como dimensión (prompt/document_types/campos por país). Solo AR hoy | 🟢 Baja |
| **TEST-CLASSIFY-TRIGGER** | Tests del trigger `classify_pdf_job_row` (ver DEC-017) | 🟢 Baja |
| **TASK-66** | Landing visual refinement — dejar para el final | — |

### ✅ Completadas (en prod)

**Sesión 2026-06-23**: **TASK-92** estados de documento estandarizados (trigger `classify_pdf_job_row` reescrito: `failed` solo si error real o leído sin ningún dato; baja confianza/campos faltantes → `warning`; respeta `approved_at`; fix bug `NULL IN(...)`. Vocabulario unificado a **Exitoso/Con advertencia/Fallido**. Columna "Estado" por-documento en `DocumentsTable`). · **TASK-93** aviso de discrepancia (`getDocDiscrepancy` + `JobDiscrepancyNotice` en ProcesoDetailPage; gap real vs anomalía de conteo; no lista nombres → TASK-109) + **UX-JOB-ALLFAILED** (job 100% fallido → "Fallido" en JobList/JobDetailHeader/JobStatusBadge/MonitoringPage). · **TASK-94 + TASK-97** período = mes de procesamiento universal (trigger `trg_set_pdf_job_period`, backfill hecho) + quitado el selector Mes/Año del subidor. · **TASK-95** Activity vacía: causa raíz = RPC `get_tenant_jobs_admin` con `id` ambiguo (migración `fix_get_tenant_jobs_admin_ambiguous_id`) + empty-state + manejo de error. · **TASK-96** carpeta de errores en Drive (no-soportados → `fallidos/`; + soporte `.rar`). · **TASK-110** archivos rechazados visibles como proceso fallido (universal, todas las integraciones): RPC `gateway_register_rejected_file` + `error_type='rejected'` + helper compartido `registerRejectedFile`; el front ya los muestra como Fallido con la razón (nombre + formato). · Builds: `main-8UVxgJRP.js`, `main-D8Ivc5LK.js`; worker f4987cb+.

**Previas**: TASK-73 (Excel acumulativo Drive) · TASK-78 (Drive por cliente) · TASK-79 (`input_source` + filtro cliente) · TASK-80 (edición/aprobación manual de docs con error) · TASK-81 (saldo USD) · TASK-82 (panel Monitoreo superadmin) · TASK-83 (resiliencia frontend ante extensiones, 6 fixes → reglas en ZONA CERRADA/Auth) · TASK-84 (MonitoringPage Tenants vía RPC bypass RLS) · TASK-85 (MP webhook IPN, validado e2e) · TASK-87 (RLS `integration_processed_files`) · TASK-90 → **UX-PRICE-BREAKDOWN** (precio base configurable; `get_price_breakdown()`) · TASK-91 (validación email/CUIT duplicado) · REG-TAXID (CUIT obligatorio en registro) · TASK-104 (`polling_interval_tiers`) · TASK-106 (Supabase Storage e2e) · TASK-107 (init-folders) · INT-TEST-CONNECTION · INT-FOLDER-MIGRATION · FIX-GATEWAY-METADATA (spread de `metadata`) · Sentry · UX-BALANCE · FIX-AUTH-LOAD / FIX-AUTH-LOCK (reglas en ZONA CERRADA/Auth) · FIX-REG (trigger crea org+profile).

**Sesión 2026-06-24**: **TASK-98** tipo de documento como dropdown desde tabla `document_types` (no hardcode; muestra label, guarda code; build main-DCAXe0jM.js). · **TASK-99** aclaración ZIP/Drive en el cargador manual (`SubirZipPage`). · **TASK-100** drag & drop de 1 archivo en el cargador (validación + feedback visual). · **TASK-101** un solo punto de entrada 'Nuevo proceso' (quitado ítem 'Subir archivos' del nav; renombrado el botón de AppHomePage). Build main-DF8oXcT4.js. · **TASK-112** TODOS los dropdowns unificados a shadcn Select (0 `<select>` nativos en la app): cliente en Nuevo proceso, filtros cliente Dashboard/MisProcesos/Documentos (centinela `__all__`), tipo de doc en EditRowModal, y los 5 de IntegracionesPage (centinela `__root__` para raíz, polling number→string; solo estético, lógica de config intacta). · **TASK-114** visor read-only del prompt del worker en Monitoreo (`export SYSTEM_PROMPT` + gateway `GET /api/prompt` + tarjeta/modal superadmin; editar = futuro vía DB, DEC-018/TASK-113). · **TASK-111 (✅ Hecho + Validated en prod)** panel admin de `document_types` en MonitoringPage→Tipos de doc (tarjeta + modal: label editable, toggle activo, alta code+label). DB: RPCs `upsert_document_type`/`toggle_document_type` (SEC DEFINER + guard superadmin, `code` inmutable, sort_order default max+10). Validado con sesión superadmin: alta de tipo 'NIF' → escrito en DB (sort_order 130); toggle → active=false. `MonitoringPage.tsx` se truncó al editar (5º caso OneDrive) → reconstruido desde git HEAD + reaplicación en python, verificado (esbuild+tsc+balance+diff aditivo 150+/1-). · **FIX-DOCS-PAGINATION (✅ Hecho + Validated en prod)** bug preexistente en `DocumentsPage`/`useAllDocuments.ts`: `totalCount` sumaba facturas + TODAS las OCs (sin paginar) pero `.range()` solo paginaba facturas → página fantasma que pedía facturas fuera de rango → PostgREST 416 mostrado como error crudo `{"…`. Fix: las OCs se traen scoped a las facturas de la página (`.in('row_id', facturaRowIds)`) y `totalCount = count(facturas)`. Elimina el 416 y la duplicación de OCs entre páginas. Solo frontend; esbuild+tsc+balance OK. `useAllDocuments.ts` también se truncó al editar (6º caso OneDrive, archivo chico) → reconstruido desde git HEAD + python. · **REMOVE-DEDUP / DEC-019 (✅ Hecho + Validated en prod)** a pedido del director: quitada la deduplicación de los 3 pollers de integración (Supabase/Firebase/Drive). Antes, un archivo cuyo SHA256 (o drive_file_id) ya estaba en `integration_processed_files` se borraba/saltaba sin procesar; ahora se levanta y procesa todo. Seguridad anti-recobro: encolar SOLO si el move root→`en_proceso/` tuvo éxito (Supabase: `moveFile` retorna bool + `if(!moved) continue`; Drive: flag `moved` + gate; Firebase ya gateaba). Nombres tal cual (sin prefijo): repetidos pueden trabarse en `en_proceso/` al moverse a `procesados/` (asumido). `integration_processed_files` y sus RPCs quedan (no se borran). node --check + balance + git diff OK (sin truncado). · **TASK-108 (✅ Hecho + Validated en prod)** SCOPE-ATTACHMENT-EXTRACTION: la extracción de adjuntos embebidos se gatea por org vía `tenant_feature_flags.extract_embedded_attachments` (default false; Aignition=true). DB: columna aditiva + Aignition ON (migración `add_extract_embedded_attachments_flag`). Worker: helper `getExtractAttachmentsFlag` en `worker.mjs` + param/gateo en `zip-processor.mjs` (OFF → no extrae → 0 OCs, no cobra). node --check + balance OK. `worker.mjs` y `zip-processor.mjs` se truncaron al editar (7º/8º casos OneDrive) → reconstruidos desde git HEAD + python. **Toggle UI**: columna 'Adjuntos' (switch por tenant) en MonitoringPage→Balance por tenant, vía RPCs `get_tenant_attachment_flags`/`set_tenant_attachment_extraction` (SEC DEFINER + guard superadmin, upsert). Prender/apagar la extracción por cliente sin SQL. · **TASK-109 (🔄 coded, pendiente deploy)** JOB-FILE-MANIFEST (fase 2 de TASK-93): el worker registra el manifiesto de archivos detectados por job en `pdf_jobs.file_manifest` (jsonb nullable, columna aditiva). `zip-processor` devuelve `detectedFiles` (=`allFiles`); `worker.mjs` arma `[{name,status}]` (processed/failed/upload_failed/omitted) y lo pasa a `finalizeJob` (lo escribe en el PATCH). Frontend: `JobDiscrepancyNotice` lista por nombre los no-`processed` cuando hay manifiesto; jobs viejos sin manifiesto = solo conteo (backward-compat). esbuild+tsc+balance OK; .mjs editados vía python (sin truncado). **Extensión (mismo no-deploy):** (1) **RAR arreglado** — p7zip de Alpine NO trae códec RAR (extraía vacío → job 'exitoso' sin nada); Dockerfile usa **solo** `7zip` (provee `7z`+`7zz` con RAR5; se quitó `p7zip` que conflictúa en `/usr/bin/7z` y rompía el build) y `zip-processor` extrae con `7zz` + loguea su salida (`zip.extract_result`) para diagnóstico. (2) **'exitoso vacío' eliminado** — si una subida ZIP/RAR extrae 0 archivos (ni soportados ni no), worker tira `TerminalError` → job Fallido con razón. (3) **No soportados nombrados** — `zip-processor` colecta los archivos no soportados dentro del comprimido (find busybox-safe, excluye `adj/`) y los suma al manifiesto con status `unsupported`; `JobDiscrepancyNotice` nombra TODOS los no-`processed` (incl. no soportados) aun sin hueco de conteo. ⚠️ Requiere rebuild del worker (Dockerfile cambió).