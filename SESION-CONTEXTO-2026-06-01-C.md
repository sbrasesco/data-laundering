# Contexto de sesión — Data Laundering V2.0
**Fecha**: 2026-06-01 (cierre de sesión noche)
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

## Lo que se hizo en la sesión 2026-06-01 (noche)

### Tasks completadas

- **Fix jobs atascados en 'processing' (402)** ✅
  - Nueva función `failPdfJob(jobId, msg, errorType)` en `pdfJobHelpers.ts`
  - `SubirZipPage.tsx`: `.then()` y `.catch()` del fire-and-forget llaman `failPdfJob`
  - Jobs con error de gateway pasan a `status='error'` en lugar de quedar atascados

- **Clasificar errores: `error_type` en `pdf_jobs`** ✅
  - DB migration: columna `error_type TEXT CHECK (IN ('processing', 'credits'))` — nullable, retrocompatible
  - `errors.mjs`: `TerminalError` acepta `{ cause, code }` opcional
  - `worker.mjs`: throws de créditos usan `{ code: 'INSUFFICIENT_CREDITS' }`, catch deriva `errorType`
  - `post-processor.mjs`: `failJob(jobId, msg, log, errorType = 'processing')`
  - Worker v1.2.0 (commit `35573fb`) — validado: job `e9ef4165` → `error_type='credits'`

- **Bull Board** ✅
  - Puerto 9091, solo `127.0.0.1` (SSH tunnel)
  - Auth: `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD` (default: `admin` / `dl-monitor-2026`)
  - Acceso: `ssh -L 9091:localhost:9091 root@157.230.231.207` → `http://localhost:9091`
  - Worker v1.3.0 (commit `2fd5871`)

- **Página /monitoring en el frontend** ✅
  - `MonitoringPage.tsx` — stat cards, indicador de salud, errores recientes, balance por tenant
  - Link "Monitoreo" en navbar (`AppLayout.tsx`)
  - Route en `App.tsx`
  - Indicador de salud: 🟢 < 1% / 🟡 1–3% / 🔴 > 3% tasa de error del sistema
  - Commit `d70d429` (frontend)

- **TASK-20 (Cutover gradual) cerrada** ✅
  - Obsoleta por DEC-011 — n8n ya no está en el pipeline
  - Umbrales operativos rescatados e implementados en /monitoring

### Archivos modificados hoy
| Archivo | Cambio |
|---|---|
| `worker/errors.mjs` | `TerminalError` acepta `{ code }` |
| `worker/worker.mjs` | Throws con `INSUFFICIENT_CREDITS`, catch deriva `errorType` |
| `worker/post-processor.mjs` | `failJob` escribe `error_type` |
| `worker/bull-board.mjs` | NUEVO — Bull Board en puerto 9091 |
| `worker/package.json` | @bull-board/api, @bull-board/express, express, express-basic-auth |
| `src/lib/pdfJobHelpers.ts` | `failPdfJob(jobId, msg, errorType)` |
| `src/pages/SubirZipPage.tsx` | Llama `failPdfJob` en error del gateway |
| `src/pages/MonitoringPage.tsx` | NUEVO — página de monitoreo |
| `src/App.tsx` | Route `/monitoring` |
| `src/components/layout/AppLayout.tsx` | Link "Monitoreo" en navbar |

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
- Worker NO llama a n8n para nada — n8n eliminado del pipeline crítico (DEC-011)

### Billing activo
- Org Aignition: `6b505051-9891-4ef0-b163-07eaf7230f22`
- Balance actual: 200 créditos
- `charge_credit(p_organization_id, p_job_id, p_amount, p_description)`
- `pdf_jobs.error_type`: `'credits'` = negocio (cliente sin saldo), `'processing'` = sistema

### Infraestructura
- Redis Cloud SP: `redis-16705.crce216.sa-east-1-2.ec2.cloud.redislabs.com:16705`
- BullMQ queue: `pdf-processing`, 3 attempts, backoff exponencial
- Worker concurrency: 3
- Gateway: `https://automation.aignition.net/worker/api/enqueue`
- Supabase: `klhbgsiatzbmxbkzpbzv`

### Observabilidad
- **Bull Board**: `ssh -L 9091:localhost:9091 root@157.230.231.207` → `http://localhost:9091` (admin / dl-monitor-2026)
- **Página /monitoring**: disponible en el frontend para usuarios autenticados
- **Indicador de salud**: 🟢 error sistema < 1% / 🟡 1–3% / 🔴 > 3%

---

## Clientes / Tenants

- **Clientes reales activos**: ninguno todavía
- Aignition es el único tenant real (usado como piloto interno)
- Los demás en organizations son cuentas vacías ("Organización sin nombre")
- Cuando lleguen clientes: crear org en Supabase, cargar créditos, dar acceso al frontend

---

## Próximas tasks (en orden sugerido)

### 1. TASK-20 archivada — siguiente foco: onboarding de clientes reales
El sistema está listo para recibir clientes. Definir flujo de onboarding:
- Creación de org en Supabase
- Carga inicial de créditos
- Acceso al frontend

### 2. Integración carpetas (Fase 5)
- Google Drive watcher → Input Gateway
- FTP/SFTP → Input Gateway
- Pause/resume del listener según balance (DEC-012 ya define la lógica)

### 3. Rediseño del frontend (cuando haya clientes)
- Usar template / diseño más vistoso
- La funcionalidad ya está — solo cambiar capa visual
- Página /monitoring ya existe y funciona — migrar junto con el resto

---

## Comandos útiles de referencia

```bash
# Ver logs en tiempo real (pedirle a Claude Code)
ssh root@157.230.231.207 "docker compose -f /root/worker/docker-compose.yml logs -f worker"

# Deploy nueva versión (pedirle a Claude Code)
scp "C:/Users/sbras/.../worker/"*.mjs "C:/Users/sbras/.../worker/package.json" root@157.230.231.207:/root/worker/
ssh root@157.230.231.207 "cd /root/worker && ./deploy.sh v1.4.0"

# Rollback (pedirle a Claude Code)
ssh root@157.230.231.207 "cd /root/worker && ./rollback.sh v1.2.0"

# Bull Board (abrir en terminal local, dejar abierto)
ssh -L 9091:localhost:9091 root@157.230.231.207
# → http://localhost:9091 (admin / dl-monitor-2026)

# Query jobs recientes (Supabase MCP — Cowork)
# SELECT id, status, error_type, error_message, total_documents
# FROM pdf_jobs
# WHERE organization_id = '6b505051-9891-4ef0-b163-07eaf7230f22'
# ORDER BY created_at DESC LIMIT 5;

# Balance actual (Supabase MCP — Cowork)
# SELECT balance FROM organization_credits
# WHERE organization_id = '6b505051-9891-4ef0-b163-07eaf7230f22';
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
