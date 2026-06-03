# Contexto de sesión — Data Laundering V2.0
**Fecha**: 2026-06-03 (cierre de sesión)
**Worker version en producción**: v1.3.0 (DO, dl-worker)

---

## Modo de trabajo

**Claude Code** ejecuta comandos en el servidor (Digital Ocean):
- SSH, SCP, git commit/push
- Deploy: `scp *.mjs package.json → ./deploy.sh vX.X.X`
- Ver logs: `ssh root@157.230.231.207 "docker compose -f /root/worker/docker-compose.yml logs --tail=50 worker"`

**Claude (Cowork)** trabaja en:
- Base de datos (Supabase MCP) — queries, migraciones, validaciones
- Archivos locales del repo
- Notion (tasks, decisions log, current state)

**Servidor**: `root@157.230.231.207`
**Repo local**: `C:\Users\sbras\OneDrive\Documentos\Aignition\Servicios\Data Laundering\data-laundering V2.0`

---

## Lo que se hizo en la sesión 2026-06-03

### TASK-38 — Módulo de integraciones ✅ CERRADA

**Paso A — DB:**
- Tabla `tenant_integrations` creada con RLS (4 políticas: SELECT/INSERT/UPDATE/DELETE)
- Columna `credentials_encrypted bytea` — credenciales encriptadas con pgcrypto
- Constraint `UNIQUE (organization_id, integration_type)`
- 4 RPCs con `SECURITY DEFINER` + pgcrypto:
  - `upsert_tenant_integration(p_type, p_config, p_credentials, p_folder_path, p_interval)`
  - `get_my_integrations()`
  - `toggle_tenant_integration(p_integration_id, p_active)`
  - `delete_tenant_integration(p_integration_id)`
- Tipos soportados: `frontend_only`, `google_drive`, `ftp`, `sftp`, `remote_folder`, `firebase_storage`

**Paso B — Frontend:**
- `src/pages/IntegracionesPage.tsx` — formulario dinámico por tipo, lista con toggle/editar/eliminar, badge 🔜 para tipos sin worker
- Route `/integrations` en `App.tsx`
- Link "Integraciones" en navbar (`AppLayout.tsx`)

**Firebase Storage** — agregado post-cierre (cliente lo pidió):
- CHECK constraint actualizado para incluir `firebase_storage`
- Frontend actualizado (ícono 🔥, campos: Service Account JSON + Bucket name)

### Deuda técnica registrada

| Orden | Task | Prioridad |
|---|---|---|
| 42 | Migrar clave de encriptación → Supabase Vault | 🔴 Crítica |
| 43 | Corregir errores TypeScript pre-existentes | 🟡 Media |
| 44 | Configuración de salida automática de resultados | 🟠 Alta |

### Fase 6 — Rediseño & GTM — planificada en Kanban

| Orden | Task | Prioridad | Depende de |
|---|---|---|---|
| 50 | Definir paquetes de créditos y precios | 🔴 Crítica | — |
| 51 | Landing page pública y funnel | 🔴 Crítica | Orden 50 |
| 52 | Integrar pasarela de pago (TBD) | 🔴 Crítica | Orden 50 |
| 53 | Registro integrado al checkout | 🔴 Crítica | Orden 52 |
| 54 | Acreditación automática de créditos (webhook) | 🔴 Crítica | Orden 52+53 |
| 55 | Onboarding post-registro | 🟠 Alta | Orden 53 + TASK-38 |
| 56 | Rediseño visual del app | 🟠 Alta | Orden 51 |

### TASK-56 — Rediseño visual — EN PROGRESO 🔄

**Lo que se instaló y configuró:**
- Tailwind CSS v3 con `preflight: false` (coexiste con CSS existente)
- `postcss.config.js` en CJS (`module.exports`)
- `tailwind.config.js` en CJS (`module.exports`)
- Alias `@/` en `vite.config.ts` y `tsconfig.json`
- `src/lib/utils.ts` — función `cn()` para combinar clases Tailwind
- Google Fonts movido de CSS a `index.html` (correcto)
- `transform: scale(0.7)` en `#root` eliminado de `global.css`
- Variables CSS de temas del sidebar agregadas a `global.css`

**Nuevo AppShell con sidebar:**
- `src/components/layout/AppShell.tsx` — sidebar oscuro con Tailwind
- 5 temas configurables: purple (default), indigo, teal, slate, rose
- Selector de tema en el footer del sidebar, persiste en `localStorage`
- `AppLayout.tsx` reemplazado por alias thin de `AppShell` — todas las páginas existentes funcionan sin cambios

**Estado al cierre:**
- Build de producción: ✅ limpio (152 módulos)
- Dev server: requiere `rm -rf node_modules/.vite && npm run dev` para limpiar cache de Vite
- Páginas internas: funcionan con el nuevo sidebar pero **aún usan el CSS viejo** — pendiente migrarlas a Tailwind

**Próximo paso en TASK-56:**
1. Verificar que el sidebar se ve correctamente en el navegador
2. Migrar `ClientDashboardPage.tsx` al nuevo estilo Tailwind (primera página piloto)
3. Luego migrar el resto de páginas de a una

---

## Estado actual del sistema

### Worker v1.3.0 — producción (DO, dl-worker)
```
Servidor:  root@157.230.231.207
Ruta:      /root/worker/
Deploy:    scp *.mjs package.json → ./deploy.sh vX.X.X
Rollback:  ./rollback.sh vX.X.X
```

**Imágenes disponibles para rollback**:
- `data-laundering-worker:v1.0.0` — baseline
- `data-laundering-worker:v1.1.0` — protección financiera DEC-012
- `data-laundering-worker:v1.2.0` — error_type en pdf_jobs
- `data-laundering-worker:v1.3.0` — Bull Board

**Puertos activos en el servidor**:
| Puerto | Servicio | Acceso |
|---|---|---|
| 3001 | Worker Gateway | `https://automation.aignition.net/worker/api/enqueue` |
| 9090 | Metrics server | Solo interno |
| 9091 | Bull Board | SSH tunnel `ssh -L 9091:localhost:9091 root@157.230.231.207` |

### Pipeline de procesamiento (Worker v1.3.0)
```
Frontend → Storage → Worker Gateway → BullMQ → Worker
  → Gateway: chequeo balance >= 1 (bloquea si balance = 0, HTTP 402)
  → worker.mjs: getBalance() (bloquea si balance < docs del ZIP, INSUFFICIENT_CREDITS)
  → document-processor.mjs (Mistral OCR + OpenAI extracción)
  → post-processor.mjs (confianza, audit log, finalización, billing)
  → pdf_jobs: status + error_type ('credits' | 'processing')
```

### Estado de n8n
- **Workflow monolítico** (`/webhook/pdf-to-excel`): activo pero congelado (DEC-010), nadie lo llama
- **Sub-workflow** (`/webhook/sub-document`): inactivo
- Worker NO llama a n8n — n8n eliminado del pipeline crítico (DEC-011)

### Billing activo
- Org Aignition: `6b505051-9891-4ef0-b163-07eaf7230f22`
- Balance actual: 200 créditos
- `charge_credit(p_organization_id, p_job_id, p_amount, p_description)`
- `pdf_jobs.error_type`: `'credits'` = negocio, `'processing'` = sistema

### Infraestructura
- Redis Cloud SP: `redis-16705.crce216.sa-east-1-2.ec2.cloud.redislabs.com:16705`
- BullMQ queue: `pdf-processing`, 3 attempts, backoff exponencial
- Worker concurrency: 3
- Gateway: `https://automation.aignition.net/worker/api/enqueue`
- Supabase: `klhbgsiatzbmxbkzpbzv`

### Observabilidad
- **Bull Board**: `ssh -L 9091:localhost:9091 root@157.230.231.207` → `http://localhost:9091` (admin / dl-monitor-2026)
- **Página /monitoring**: disponible en el frontend
- **Indicador de salud**: 🟢 error sistema < 1% / 🟡 1–3% / 🔴 > 3%

---

## Clientes / Tenants

- **Clientes reales activos**: ninguno todavía
- Aignition es el único tenant real (piloto interno)
- Un cliente nuevo consultó por integración con file server — se está evaluando si es FTP/SFTP o SMB (respuesta pendiente)

---

## Stack técnico del frontend

```
React 18 + React Router v6 + TypeScript + Vite 5
Tailwind CSS v3 (nuevo, instalado en esta sesión)
CSS custom (global.css, 632 líneas — en proceso de migración)
Supabase JS SDK
```

**Archivos clave modificados en esta sesión:**
| Archivo | Cambio |
|---|---|
| `src/components/layout/AppShell.tsx` | NUEVO — sidebar con Tailwind y selector de temas |
| `src/components/layout/AppLayout.tsx` | Reemplazado — ahora es alias de AppShell |
| `src/pages/IntegracionesPage.tsx` | NUEVO — página de integraciones |
| `src/lib/utils.ts` | NUEVO — función cn() |
| `src/styles/global.css` | Tailwind directives + sidebar CSS vars + scale(0.7) eliminado |
| `tailwind.config.js` | NUEVO — CJS, preflight: false |
| `postcss.config.js` | NUEVO — CJS |
| `vite.config.ts` | Alias @/ agregado |
| `tsconfig.json` | baseUrl + paths para @/ |
| `index.html` | Google Fonts movido aquí |
| `src/App.tsx` | Route /integrations agregada |

---

## Comandos útiles de referencia

```bash
# Dev server (limpiar cache primero si hay problemas)
rm -rf node_modules/.vite && npm run dev

# Build de producción
npm run build

# Ver logs en tiempo real (pedirle a Claude Code)
ssh root@157.230.231.207 "docker compose -f /root/worker/docker-compose.yml logs -f worker"

# Bull Board (abrir en terminal local, dejar abierto)
ssh -L 9091:localhost:9091 root@157.230.231.207
# → http://localhost:9091 (admin / dl-monitor-2026)

# Query jobs recientes (Supabase MCP — Cowork)
# SELECT id, status, error_type, error_message, total_documents
# FROM pdf_jobs WHERE organization_id = '6b505051-9891-4ef0-b163-07eaf7230f22'
# ORDER BY created_at DESC LIMIT 5;
```

---

## Notion — estructura del proyecto

- **Kanban**: `https://www.notion.so/3f50ef369c7a4e539451f0a9ebee60eb`
- **Current State**: `https://www.notion.so/367e32b060fc81c78198f196e2eff3f2`
- **Decisions Log**: buscar en Notion "Decisions Log Data Laundering"

## Decisiones registradas relevantes

| ID | Decisión |
|---|---|
| DEC-010 | n8n congelado — sin nuevas responsabilidades |
| DEC-011 | n8n eliminado del pipeline crítico — Worker es el pipeline |
| DEC-012 | Protección financiera: chequeo pre-Mistral en gateway y worker |

---

## Deuda técnica conocida (en Kanban)

| Orden | Descripción | Urgencia |
|---|---|---|
| 42 | Clave de encriptación hardcodeada en RPCs → mover a Supabase Vault | Antes de primer cliente real con credenciales |
| 43 | 4 errores TypeScript pre-existentes (ImportMeta.env, PostgrestError, usePdfJob) | Baja — no rompe producción |
| 44 | Salida automática de CSV por integración (output config en tenant_integrations) | Media |
