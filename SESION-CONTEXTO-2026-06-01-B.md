# Contexto de sesión — Data Laundering V2.0
**Fecha**: 2026-06-01 (cierre de sesión tarde)
**Worker version en producción**: v1.1.0 (DO, dl-worker)

---

## Modo de trabajo

**Claude Code** ejecuta comandos en el servidor (Digital Ocean):
- SSH, SCP, git commit/push
- Deploy: `scp *.mjs → ./deploy.sh vX.X.X`
- Ver logs: `ssh root@157.230.231.207 "docker compose -f /root/worker/docker-compose.yml logs --tail=50 worker"`

**Claude (Cowork)** trabaja en:
- Base de datos (Supabase MCP) — queries, migraciones, validaciones
- Archivos locales del repo
- Notion (tasks, decisions log, current state)

**Servidor**: `root@157.230.231.207`
**Repo local**: `C:\Users\sbras\OneDrive\Documentos\Aignition\Servicios\Data Laundering\data-laundering V2.0`

---

## Lo que se hizo en la sesión 2026-06-01 (tarde)

### Tasks completadas
- **TASK-16** ✅ — Saldo de créditos en tiempo real en el frontend
  - Hook `useTenantCredits.ts` (Supabase Realtime)
  - Pill 💳 en navbar de `AppLayout.tsx`

- **TASK-23** ✅ — Runbook de rollback + Docker image versioning
  - `data-laundering-worker:v1.0.0` tageado
  - `deploy.sh` y `rollback.sh` en servidor
  - `RUNBOOK-ROLLBACK.md` en repo
  - Drill validado: 4.2 segundos

- **TASK-21** ✅ — Cutover Aignition como tenant piloto
  - Frontend ya enviaba al Worker Gateway (`uploadFileToWorker`, renombrado de `uploadFileToN8n`)
  - Job validado end-to-end: 38/38 docs, billing correcto (-38 créditos)
  - DEC-012 surgió de esta validación

- **DT-010** ✅ — Protección financiera: chequeo de créditos antes de Mistral/OpenAI
  - Worker v1.1.0 (commit `9246c73`, pusheado a main)
  - `getBalance()` en `worker.mjs`
  - ZIP: chequeo post-extracción, balance >= docs, si no → TerminalError sin llamar a Mistral
  - PDF suelto: chequeo balance >= 1 antes de procesar
  - Test validado: balance=1, ZIP 20 docs → error "Saldo insuficiente: tenés 1 crédito, el ZIP tiene 20 documentos. Cargá 19 créditos más.", total_documents=0

### Decisiones registradas
- **DEC-012** (en Decisions Log de Notion) — Protección financiera billing:
  - ZIP: extraer → contar → comparar vs balance → rechazar todo si insuficiente
  - PDF suelto: balance >= 1 antes de procesar
  - Carpeta conectada (futuro): pausar listener si balance = 0, reanudar al recargar

### Archivos modificados hoy
| Archivo | Cambio |
|---|---|
| `src/hooks/useTenantCredits.ts` | NUEVO — balance Realtime |
| `src/components/layout/AppLayout.tsx` | Pill de créditos en navbar |
| `src/lib/pdfJobHelpers.ts` | Renombrar `uploadFileToN8n` → `uploadFileToWorker`, comentario actualizado |
| `src/pages/SubirZipPage.tsx` | Usar `uploadFileToWorker` |
| `worker/worker.mjs` | DEC-012: `getBalance()` + chequeos pre-Mistral (v1.1.0) |
| `worker/docker-compose.yml` | Imagen versionada `${WORKER_VERSION:-v1.0.0}` |
| `worker/deploy.sh` | NUEVO — deploy versionado |
| `worker/rollback.sh` | NUEVO — rollback en < 60 seg |
| `RUNBOOK-ROLLBACK.md` | NUEVO — procedimiento formal |

---

## Estado actual del sistema

### Worker v1.1.0 — producción (DO, dl-worker)
```
Servidor:  root@157.230.231.207
Ruta:      /root/worker/
Deploy:    scp *.mjs + extract_attachments.py → ./deploy.sh vX.X.X
Rollback:  ./rollback.sh vX.X.X
```

**Imágenes disponibles para rollback**:
- `data-laundering-worker:v1.0.0` — OCR Mistral + OpenAI, sin n8n, PyMuPDF
- `data-laundering-worker:v1.1.0` — ídem + protección financiera DEC-012

**Último test validado**:
- 20/20 facturas + 18/18 OCs ✅ (con balance suficiente)
- Rechazo correcto con balance insuficiente ✅ (cero llamadas a Mistral)

### Pipeline de procesamiento (Worker v1.1.0)
```
Frontend → Storage → Worker Gateway → BullMQ → Worker
  → Gateway: chequeo balance >= 1 (bloquea si balance = 0)
  → zip-processor.mjs        (extrae ZIPs, pdfdetach + mutool + PyMuPDF)
  → worker.mjs: getBalance() (bloquea si balance < docs del ZIP)
  → document-processor.mjs   (Mistral OCR + OpenAI extracción) ← NUNCA se toca sin créditos
  → post-processor.mjs       (confianza, audit log, finalización, billing)
```

### Estado de n8n
- **Workflow monolítico** (`/webhook/pdf-to-excel`): activo, congelado (DEC-010)
- **Sub-workflow** (`/webhook/sub-document`): inactivo, puede desactivarse
- Worker NO llama a n8n para nada

### Billing activo
- Org Aignition: `6b505051-9891-4ef0-b163-07eaf7230f22`
- Balance actual: 200 créditos
- Planes: Entry (200/$0.15), Mid (500/$0.10), Pro (1000/$0.07)
- `charge_credit(p_organization_id, p_job_id, p_amount, p_description)`

### Infraestructura
- Redis Cloud SP: `redis-16705.crce216.sa-east-1-2.ec2.cloud.redislabs.com:16705`
- BullMQ queue: `pdf-processing`, 3 attempts, backoff exponencial
- Worker concurrency: 3
- Gateway: `https://automation.aignition.net/worker/api/enqueue`
- Supabase: `klhbgsiatzbmxbkzpbzv`

---

## Problema conocido pendiente

### Jobs atascados en 'processing' cuando el gateway rechaza por balance = 0
Cuando balance = 0, el gateway devuelve 402 ANTES de que BullMQ encole. Pero el frontend ya creó el `pdf_job` con status 'processing'. Ese job queda atascado para siempre.

**Fix pendiente**: el frontend debe actualizar el status del job a 'error' cuando el gateway devuelve 402. O el gateway debe actualizar Supabase antes de rechazar.

---

## Qué sigue — próximas tasks (en orden)

### 1. Fix jobs atascados (bug del gateway 402)
Pequeño fix en el frontend: cuando `uploadFileToWorker` recibe un error `INSUFFICIENT_CREDITS`, actualizar el `pdf_job` a status='error' con mensaje claro.

### 2. Cutover gradual — más tenants
Con DT-010 resuelto, el sistema está listo para activar más tenants.
Siguiente paso: identificar 2-3 tenants de bajo volumen y activarlos.

### 3. Dashboard de monitoreo de workers
Tarea pendiente en kanban. Antes de escalar a más tenants, tener visibilidad de:
- Jobs activos / fallidos / en cola
- Balance por tenant
- Alertas de DLQ

### 4. Integración carpetas (Fase 5)
- Google Drive watcher → Input Gateway
- FTP/SFTP → Input Gateway
- Lógica de pause/resume del listener según balance (DEC-012)

---

## Comandos útiles de referencia

```bash
# Ver logs en tiempo real (pedirle a Claude Code)
ssh root@157.230.231.207 "docker compose -f /root/worker/docker-compose.yml logs -f worker"

# Deploy nueva versión (pedirle a Claude Code)
scp "C:/Users/sbras/.../worker/"*.mjs root@157.230.231.207:/root/worker/
scp "C:/Users/sbras/.../worker/extract_attachments.py" root@157.230.231.207:/root/worker/
ssh root@157.230.231.207 "cd /root/worker && ./deploy.sh v1.2.0"

# Rollback (pedirle a Claude Code)
ssh root@157.230.231.207 "cd /root/worker && ./rollback.sh v1.0.0"

# Ver imágenes disponibles para rollback (pedirle a Claude Code)
ssh root@157.230.231.207 "docker images data-laundering-worker"

# Query jobs recientes (Supabase MCP — Cowork)
# SELECT id, status, error_message, total_documents FROM pdf_jobs
# WHERE organization_id = '6b505051-9891-4ef0-b163-07eaf7230f22'
# ORDER BY created_at DESC LIMIT 5;
```
