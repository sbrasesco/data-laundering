# DataLand V2.0 — Contexto del proyecto

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
| `GET /health` | Bearer | Estado del gateway |

### metrics.mjs — puerto 9090

Expone métricas de la cola (aún NO consumidas por MonitoringPage — TASK-86):
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
| Task | Descripción | Notion |
|------|-------------|--------|
| **Sentry** | Integración observabilidad — ~4h | [ver](https://app.notion.com/p/37fe32b060fc818d9042c8a0f145f1bd) |
| **TASK-86** | Worker metrics en MonitoringPage (:9090) | [ver](https://app.notion.com/p/37fe32b060fc81bca166f25545469a82) |
| **SEC-01** | RLS en `integration_processed_files` | [ver](https://app.notion.com/p/37fe32b060fc81d89699eedab89f268f) |
| **FIX-CLEANUP** | Limpiar refs n8n restantes (parcial hecho) | [ver](https://app.notion.com/p/37fe32b060fc8125af48d38e39ff98b8) |
| **TASK-66** | Landing visual refinement — dejar para el final | — |

### ✅ Completadas y en prod
| Task | Descripción |
|------|-------------|
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

## Arquitectura de créditos / billing

- `organization_credits.balance` → `numeric(12,4)` en USD
- `charge_credit(p_org_id, p_amount_usd)` — SECURITY DEFINER: descuenta USD exacto por doc procesado
- `feature_pricing_multipliers`: costo adicional por feature (`cost_usd`); tiene RLS con SELECT policy `authenticated_read_feature_pricing`
- `credit_price_tiers`: precios por volumen (5 tramos, $0.20–$0.30/doc)
- `billing_plans`: planes con `price` (lo que paga el user) y `balance_usd` (crédito que recibe — puede diferir)
- `payments`: `gateway_preference_id` (al crear preferencia), `gateway_payment_id` (al recibir IPN), `status` default `'pending'`

## Features en `feature_pricing_multipliers`

| feature_key | label | cost_usd |
|---|---|---|
| integration_drive | Google Drive | $0.03 |
| integration_firebase | Firebase Storage | $0.03 |
| integration_sftp | SFTP | $0.03 |
| integration_ftp | FTP | $0.03 |
| xlsx_output | Formato Excel (.xlsx) | $0.03 |
| master_file | Archivo maestro acumulativo | $0.03 |
| human_review | Revisión humana | $0.03 |
| integration_drive_multiclient | Multi-cliente | $0.05 |
| polling_interval_1min | Intervalo de escucha (1 min) | $0.15 |

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
- `setLoading(false)` se llama **inmediatamente** tras `getSession` (la sesión viene de localStorage, disponible al instante). `fetchProfile` corre en background sin bloquear la UI — **no usar `await`**.
- `fetchProfile` NO llama `setProfile(null)` en error — preserva el profile cargado
- Reintenta 3 veces (espera 1.5s y 3s). Timeout 20s
- Solo `signOut` y `onAuthStateChange` con session=null limpian el profile

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
| `get_stuck_jobs()` | superadmin | Listar jobs atascados |
| `fail_stuck_job(p_job_id)` | superadmin | Marcar job atascado como fallido |
| `set_tenant_active(p_org_id, p_active)` | superadmin | Activar/desactivar tenant |
| `get_all_tenants_admin()` | SECURITY DEFINER | Todas las orgs con balance (bypasea RLS) |
| `get_tenant_jobs_admin(p_org_id)` | SECURITY DEFINER | Últimos 50 jobs de cualquier tenant |
| `update_plan_price(p_plan_id, p_price)` | superadmin | Editar precio de plan |
| `update_feature_cost(p_feature_key, p_cost_usd)` | superadmin | Editar costo de feature |

---

## Notas críticas (no violar)

- **N8N NO EXISTE**. No referenciar, no buscar workflows, no crear nodos. Todo procesamiento va a `document-processor.mjs` vía BullMQ.
- **Queries directas a `organization_credits` y `organizations` están filtradas por RLS** — para superadmin usar siempre RPCs SECURITY DEFINER.
- **`feature_pricing_multipliers` tiene RLS** — siempre necesita SELECT policy para usuarios autenticados.
- **`classify_pdf_job_row` trigger**: si `NEW.approved_at IS NOT NULL` → `doc_status = 'ok'` definitivo (no sobreescribir aprobación manual).
- **`set_pdf_jobs_counters` trigger**: incluye `status = 'done_with_warnings'` en cálculo de `has_warnings`.
- **Login con Playwright/headless falla en prod** (Supabase bloquea REST login en CI). Testing manual vía browser.
- **`MonitoringPage` no consume métricas del worker** (:9090) — solo datos de Supabase. Esto es deuda técnica (TASK-86).
- **`add_credits` vs `add_credits_admin`**: desde el gateway (service key) SIEMPRE usar `add_credits(p_organization_id, p_amount_usd, p_plan_id, p_description, p_gateway_payment_id)`. `add_credits_admin` requiere `auth.uid()` de superadmin activo — falla con service key.
- **`external_reference` en preferencias MP**: desde commit f7a8649 es el UUID del payment de DB (pre-generado antes del insert). El webhook usa esto como fallback cuando `preference_id` viene null (sandbox). No cambiar a org_id.
- **MP sandbox no envía IPNs automáticamente**: para tests manuales, buscar el payment_id en la API de MP y simularlo con `POST /api/mp/webhook {"type":"payment","data":{"id":"<id>"}}`.
- **MP_ACCESS_TOKEN en el server**: actualmente apunta a producción (`seller_id 290523599`, restaurado 2026-06-15). Si se hace testing con sandbox, restaurar el token de prod antes de cerrar la sesión. Distinguir por seller_id: producción `290523599`, sandbox `3450456818`.
