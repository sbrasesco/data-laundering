# DataLand V2.0 — Contexto del proyecto

## Stack

- **Frontend**: React 18 + TypeScript + Vite, shadcn/ui, Tailwind CSS
- **Backend/DB**: Supabase (PostgreSQL + RLS + Realtime + Edge Functions)
- **Worker**: Node.js ESM (`worker/*.mjs`), Docker en VPS DigitalOcean
- **Pagos**: MercadoPago (webhook vía Edge Function `mp-webhook`)
- **Integraciones**: Google Drive, FTP, SFTP, Firebase Storage, SMB/remote_folder

## Producción

- **Frontend**: `https://dataland.aignition.net` → VPS `root@157.230.231.207:/var/www/dataland/`
- **Worker/gateway**: `v1.9.9` en `root@157.230.231.207:/root/worker/` (Docker Compose)
- **Supabase project**: `klhbgsiatzbmxbkzpbzv`
- **Superadmins**: `arcademy.dev@gmail.com`, `sbrasesco@outlook.es`

## Deploy workflow

```bash
# Frontend — siempre SCP al VPS, nunca Netlify
npm run build
scp -r dist/. root@157.230.231.207:/var/www/dataland/

# Worker
scp worker/*.mjs root@157.230.231.207:/root/worker/
ssh root@157.230.231.207 "cd /root/worker && docker compose build && docker compose up -d --force-recreate"
```

## Arquitectura de créditos / billing

- `organization_credits.balance` → `numeric(12,4)` en USD
- `charge_credit` (SECURITY DEFINER RPC): descuenta USD exacto por doc procesado
- `feature_pricing_multipliers`: costo adicional por feature (`cost_usd`); tiene RLS activo con SELECT policy `authenticated_read_feature_pricing`
- `credit_price_tiers`: tabla de precios por volumen (5 tramos, $0.20–$0.30/doc)
- `billing_plans`: planes Básico/Profesional/Business con `balance_usd`
- **Pendiente n8n**: webhook de compra de plan debe pasar `balance_usd` a RPC `add_credits` (todos los pagos actuales están `pending`)

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

## Estructura de tareas (Kanban)

| Task | Estado |
|------|--------|
| TASK-66 | Landing page refinement — Backlog, dejar para el final |
| TASK-73 | Excel acumulativo Drive — ✅ Validado prod |
| TASK-78 | Drive por cliente (carpetas `{cliente}/{extracciones,procesados}`) — ✅ Validado prod |
| TASK-79 | input_source + filtro cliente en MisProcesos — ✅ Validado prod |
| TASK-80 | Edición manual y aprobación de docs con error — ✅ Validado prod |
| TASK-81 | Reemplazar créditos por saldo USD — ✅ Validado prod |
| TASK-82 | Panel Monitoreo superadmin — ✅ Validado prod |
| TASK-83 | Resiliencia frontend ante extensiones de browser — ✅ Validado prod |

## TASK-83 — Resiliencia frontend ante extensiones (2026-06-14)

Cuatro fixes deployados ante pantalla en blanco / bugs causados por extensiones de browser o red lenta:

### Fix 1 — Guard `organizationId` en SubirZipPage (`daf80d5`)
`fetchProfile` puede hacer timeout en redes lentas → `organizationId = null` → el gateway rechazaba el job con "Campos requeridos". Fix: `if (!organizationId) { setError(...); return; }` en `handleSubmit` antes de crear el job. También se deshabilita el botón mientras `authLoading || !organizationId`.
- Archivo: `src/pages/SubirZipPage.tsx`

### Fix 2 — ErrorBoundary global + handler `unhandledrejection` (`956542e`)
Sin error boundary, cualquier excepción en el árbol React deja pantalla en blanco. Las extensiones que corren en main world pueden inyectar promesas sin catch que propagan al contexto de la página. Fix: `<ErrorBoundary>` wrapeando `<App />` muestra "Algo salió mal / Recargar página" en vez de blanco. `window.addEventListener('unhandledrejection', e => { e.preventDefault(); })` swallowea promesas externas.
- Archivos: `src/components/ErrorBoundary.tsx`, `src/main.tsx`

### Fix 3 — `fetchProfile` no limpia profile en error (`27749d4`)
`onAuthStateChange` dispara `fetchProfile` en cada refresh de token. Si fallaba (timeout/red), llamaba `setProfile(null)` → `isSuperadmin = false` → tab Monitoreo desaparecía. Fix: eliminar los `setProfile(null)` dentro de `fetchProfile` — solo `signOut` y el handler de sesión nula limpian el profile.
- Archivo: `src/contexts/AuthContext.tsx`

### Fix 4 — Fallback HTML + reintentos automáticos (`12cfa00`)
Si el CSS/JS bundle es bloqueado por extensión, el browser mostraba pantalla en blanco total. Si Supabase era bloqueado momentáneamente, `fetchProfile` fallaba sin reintento. Fixes:
- `index.html`: spinner con estilos inline dentro de `#root` — visible antes de que cargue cualquier JS/CSS. Mensaje "Tardando demasiado — hacé clic para recargar" aparece a los 8s vía CSS animation.
- `AuthContext`: `fetchProfile` reintenta hasta 3 veces (espera 1.5s y 3s entre intentos). Timeout externo subido de 10s a 20s.
- Archivos: `index.html`, `src/contexts/AuthContext.tsx`

## Patrones clave del frontend

### Sidebar balance (AppShell.tsx)
Tres estados: skeleton (creditsLoading) → rojo "Sin saldo" (balance === 0) → verde con monto.
`noCredits = !creditsLoading && balance !== null && balance <= 0`

### useTenantCredits hook
- Early return si `authLoading` para evitar flash de "Sin saldo"
- Realtime subscription + polling fallback `setInterval(15_000)`
- `return { balance, loading: loading || authLoading }`

### AuthContext
- `await fetchProfile(session.user.id)` antes de `setLoading(false)` en `getSession`

### Rutas protegidas
- Layout route con `<Outlet />` en `App.tsx` — `AppShell` se monta una sola vez, no en cada navegación

### Superadmin
- `SuperadminRoute` component; `MonitoringPage` solo visible para superadmins
- Worker health check: `Authorization: Bearer staging-key-2026`

## Tipografía

- **Inter** (sans): UI general
- **Lora** (serif, class `font-lora`): números en tarjetas métricas (`MonitoringPage`, `ClientDashboardPage`)
- Google Fonts cargado en `index.html`; `fontFamily.lora` en `tailwind.config.js`

## RPCs Supabase relevantes

- `charge_credit(p_org_id, p_amount_usd)` — SECURITY DEFINER
- `add_credits(p_org_id, p_amount_usd)` — superadmin
- `add_credits_admin(p_org_id, p_amount_usd)` — superadmin
- `approve_document_row(p_row_id bigint)` — aprueba doc + incrementa `corrected_documents`; si todos `ok` → job pasa a `done`
- `get_stuck_jobs()`, `fail_stuck_job(p_job_id)`, `set_tenant_active(p_org_id, p_active)`
- `update_plan_price(p_plan_id, p_price)`, `update_feature_cost(p_feature_key, p_cost_usd)` — superadmin, precios editables

## Notas importantes

- `classify_pdf_job_row` trigger: si `NEW.approved_at IS NOT NULL` → `doc_status = 'ok'` definitivo (no sobreescribir aprobación manual)
- `set_pdf_jobs_counters` trigger: incluye `status = 'done_with_warnings'` en cálculo de `has_warnings`
- `feature_pricing_multipliers` tiene RLS — siempre necesita SELECT policy para usuarios autenticados
- Login con Playwright/headless falla en prod (Supabase bloquea REST login con esas credenciales en CI); testing manual vía browser
