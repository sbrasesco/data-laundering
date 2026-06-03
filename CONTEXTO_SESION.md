# Contexto de Sesión — Data Laundering V2.0
**Fecha:** 2026-05-29  
**Repo:** sbrasesco/data-laundering (main)  
**Servidor:** root@157.230.231.207 (Digital Ocean droplet-ubuntu-do)

---

## Estado actual del sistema

### Infraestructura en producción
- **n8n:** `/opt/n8n/` — workflow monolítico activo (workflow_task4_logging.json, 43 nodos, versionId: 7e3a439f)
- **extractor:** Docker container `root-extractor`, red host, puerto 5679 — extrae ZIPs para n8n
- **worker:** Docker container `dl-worker` v0.5.0, `/root/worker/`, red host
  - Puerto 9090: GET `/metrics`  
  - Puerto 3001: POST `/api/enqueue` (Input Gateway), GET `/health`
  - Auth: `Authorization: Bearer staging-key-2026`
- **Redis Cloud:** redis-16705.crce216.sa-east-1-2.ec2.cloud.redislabs.com:16705 (São Paulo)
  - Password: DWYpOoQsmjz0K2sV0gbr66SCdf09l35j
  - Queue: `pdf-processing`, BullMQ, 3 attempts, exponential backoff 2s/4s/8s

### Supabase (klhbgsiatzbmxbkzpbzv)
- **Tablas nuevas:** `queue_jobs`, `worker_events`, `workflow_logs`, `tenant_feature_flags`
- **Migraciones aplicadas:**
  - 20260529000001: create_queue_extension_tables
  - 20260529000002: add_unique_pdf_job_id_queue_jobs
  - 20260529000003: create_tenant_feature_flags
- **Feature flags:** 8 orgs con `use_worker_pipeline=false` (todas desactivadas = safe default)

---

## Tasks completadas esta sesión

### Fase 0 (Baseline)
- ✅ TASK-1: Auditoría RLS + fix bug client isolation
- ✅ TASK-2: Mapa flujo actual documentado
- ✅ TASK-3: Métricas baseline (BLOQUEADA hasta 2026-06-04, 7 días de datos)
- ✅ TASK-4: Logging estructurado n8n (workflow_task4_logging.json)
- ✅ Revisión documentación generada

### Fase 1 (Infraestructura Cola) — COMPLETA
- ✅ TASK-5: Tablas Supabase (queue_jobs, worker_events)
- ✅ TASK-6/INFRA-001-a: Redis Cloud provisionado
- ✅ TASK-7: Schema QueueJob definido
- ✅ TASK-8: Test de carga (100 jobs + resilience test kill worker)
- ✅ TASK-9: Worker v0 shadow mode
- ✅ TASK-24/INFRA-001-b: BullMQ verificado
- ✅ TASK-25/QUEUE-002-a: Queue Manager (enqueueJob, getJobStatus, idempotencia)
- ✅ TASK-26/TASK-42: Worker Docker en DO
- ✅ TASK-27/QUEUE-002-b: Retry logic + DLQ
- ✅ TASK-28/QUEUE-002-c: Persistencia estados en Supabase
- ✅ TASK-29/QUEUE-002-d: Endpoint /metrics + /health
- ✅ TASK-30/WORKER-003-a: Rate limiter configurable
- ✅ TASK-31/WORKER-003-b: Smoke test 10 jobs
- ✅ TASK-32/WORKER-003-c: Concurrency test 100 jobs × 5 workers (4.4 jobs/seg)
- ✅ TASK-33: Contrato sub-workflow n8n aprobado + DEC-007 addendum
- ✅ TASK-37: Input Gateway POST /api/enqueue activo
- ✅ TASK-40/TASK-42: Worker Docker Compose + pdfdetach

### Fase 2 (Modo Sombra) — EN CURSO
- ✅ TASK-13: Feature flags por tenant (tabla tenant_feature_flags)
- 🔄 TASK-34: Sub-workflow n8n (documento individual) — **PENDIENTE VALIDAR**

---

## TASK-34 — Estado actual (lo que quedó pendiente)

### Sub-workflow generado
**Archivo:** `workflow_subworkflow_v3.json` (33 nodos)  
**Webhook URL:** `https://automation.aignition.net/webhook/sub-document` (producción)  
**Webhook test:** `https://automation.aignition.net/webhook-test/sub-document`

### Qué hace el sub-workflow v3
Toma el workflow existente (f1c3b26c, 39 nodos) y hace cambios mínimos:
- **Reemplaza:** Webhook ZIP + Descomprimir ZIP → Webhook URL + `curl -sL $FILE_URL` + pdfdetach (misma lógica)
- **Elimina:** Marcar job en procesamiento/completado (el Worker maneja estado)
- **Mantiene intacto:** Extract from File, Mistral OCR, AI Agent, Parsear JSON IA, Create a row, OCs, logs
- **Agrega:** Respuesta TASK-33 contract (`success`, `row_id`, `confidence_score`, etc.)

### Pendiente: test con dico.PDF
El sub-workflow v3 fue importado en n8n pero **faltaba ejecutar el test** al finalizar la sesión.

**Comando para ejecutar:**
```bash
ssh root@157.230.231.207 "curl -s -X POST https://automation.aignition.net/webhook-test/sub-document \
  -H 'Content-Type: application/json' \
  -d '{\"job_id\":\"525c2bcd-d2ad-4b41-96ef-f21a8d12037b\",\"organization_id\":\"6b505051-9891-4ef0-b163-07eaf7230f22\",\"file_url\":\"https://aignition.net/img/dico.PDF\",\"file_type\":\"pdf\",\"original_filename\":\"dico.pdf\",\"client_cuit\":null,\"client_name\":null,\"oc_entries\":[],\"input_source\":\"frontend_upload\"}'"
```

**Nota:** usar `/webhook-test/` (no `/webhook/`) para ver ejecución en el canvas de n8n.

### Posibles errores a monitorear
1. Error en `Descargar y Preparar Archivo` → verificar que `curl` en el container de n8n puede acceder a aignition.net
2. Error en `Parsear JSON IA` → referencias a `$('Set Campos de Entrada').first()` (ya adaptadas)
3. Error en `Create a row` → FK constraint: job_id `525c2bcd` debe existir en pdf_jobs (sí existe)
4. Error en `¿Tiene Factura?` → ya corregido: output[1] → Responder - No Factura

---

## Archivos clave en el workspace

```
data-laundering V2.0/
├── workflow_task4_logging.json          ← Workflow monolítico activo en producción (43 nodos)
├── workflow_subworkflow_v3.json         ← Sub-workflow TASK-34 (33 nodos, pendiente validar)
├── workflow_subworkflow_v2.json         ← Versión anterior (descartar)
├── worker/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── worker.mjs                       ← v0.5.0 (shadow mode + retry + DLQ + persistencia + gateway + métricas)
│   ├── gateway.mjs                      ← POST /api/enqueue
│   ├── metrics.mjs                      ← GET /metrics
│   ├── persistence.mjs                  ← Supabase sync
│   ├── errors.mjs                       ← RetryableError / TerminalError
│   ├── dlq-processor.mjs                ← DLQ cron
│   ├── .env.example
│   └── scripts/
│       ├── smoke-test.mjs               ← 10 jobs shadow
│       └── concurrency-test.mjs         ← 100 jobs × N workers
├── queue-service/
│   ├── src/types.ts
│   ├── src/connection.ts
│   └── src/queue-manager.ts
└── supabase/migrations/
    ├── 20260529000001_create_queue_extension_tables.sql
    ├── 20260529000002_add_unique_pdf_job_id_queue_jobs.sql
    └── 20260529000003_create_tenant_feature_flags.sql
```

---

## Próximos pasos al retomar

1. **Ejecutar test TASK-34** con el comando arriba
2. Si pasa → marcar TASK-34 como ✅ Hecho en Notion + commit workflow_subworkflow_v3.json
3. Si falla → ver error en canvas n8n y corregir
4. **Siguiente task de Fase 2** después de TASK-34: probablemente TASK-35 (dual write en n8n) o TASK-36 (comparar outputs shadow vs producción)

---

## Decisions Log relevantes

- **DEC-007 + addendum:** n8n = extracción + escritura únicamente. Worker = estado + retry. `oc_entries` input es suplementario, pdfdetach extrae del PDF directamente.
- **organization_id** (no tenant_id) en todas las tablas nuevas
- **Redis Cloud** (no Docker) elegido sobre Docker Compose
- **WORKER_CONCURRENCY=3** en producción (testeado hasta 5)
- **workflow_subworkflow_v3** toma el workflow existente como base, cambios mínimos (no reescritura)

---

## Notion Kanban
- URL: https://www.notion.so/3f50ef369c7a4e539451f0a9ebee60eb
- Collection: collection://c7781713-a834-4cb0-832e-fe6cb13075e8
- Proyecto principal: 367e32b060fc81e2a205ef63fcec39b9
