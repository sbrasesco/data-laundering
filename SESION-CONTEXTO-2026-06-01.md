# Contexto de sesión — Data Laundering V2.0
**Fecha**: 2026-06-01 (actualizado al cierre de sesión)
**Worker version en producción**: v1.0.0 (DO, dl-worker)

---

## Modo de trabajo

**Claude Code** ejecuta comandos en el servidor (Digital Ocean).
**Claude (Cowork)** trabaja en base de datos (Supabase MCP), archivos locales del repo, y Notion.

**Servidor**: `root@157.230.231.207`
**Repo local**: `C:\Users\sbras\OneDrive\Documentos\Aignition\Servicios\Data Laundering\data-laundering V2.0`
**Deploy**: editar local → scp al servidor → rebuild docker

---

## Lo que se hizo en la sesión 2026-06-01

### Tasks completadas hoy
- **TASK-49** ✅ — pdfdetach + mutool combinados siempre (commit c5b5e34, validado retroactivamente)
- **TASK-50 / DEC-011** ✅ — `document-processor.mjs` deployado y validado en staging
  - OCR: Mistral (`mistral-ocr-latest`) + Extracción: OpenAI (`gpt-4.1-mini`) directo en Worker
  - Shadow comparison vs n8n: 100% match en extracción de facturas
  - Test concurrencia: 3 jobs simultáneos sin interferencias, 0 fallos
  - n8n removido completamente de `worker.mjs` — código limpio, sin fallback
  - Feature flag `PROCESSOR_ORGS` eliminado — todo job que entre al Worker usa `processDocument()`

### Archivos modificados — servidor 100% sincronizado con repo local
| Archivo | Cambio |
|---|---|
| `worker/document-processor.mjs` | NUEVO — OCR Mistral + extracción OpenAI + escritura en pdf_job_rows y pdf_job_row_oc |
| `worker/worker.mjs` | n8n removido completamente. Todo job va directo a `processDocument()`. |

### Variables de entorno en servidor (`/root/worker/.env`)
```
MISTRAL_API_KEY=<key>
OPENAI_API_KEY=<key>
USE_DOCUMENT_PROCESSOR_ORGS=<obsoleta — ya no tiene efecto, puede borrarse>
```

---

## Estado actual del sistema

### Worker v1.0.0 — producción (DO, dl-worker)
```
Servidor:  root@157.230.231.207
Ruta:      /root/worker/
Deploy:    scp *.mjs → docker compose build worker && docker compose up -d worker
```

**Último job validado** (post DT-009):
- 20/20 facturas procesadas ✅ (0 fallos)
- **18/18 OCs** ✅ (DT-009 resuelto con PyMuPDF)
- OCR: `mistral-ocr-latest`, Extracción: `gpt-4.1-mini-2025-04-14`
- Confidence score: 0.98 constante

### Pipeline de procesamiento (Worker)
```
Frontend → Storage → Worker Gateway → BullMQ → Worker
  → zip-processor.mjs        (extrae ZIPs, pdfdetach + mutool + PyMuPDF, OC map)
  → document-processor.mjs   (Mistral OCR + OpenAI extracción)
  → post-processor.mjs       (confianza, audit log, finalización, billing)
```

### Estado de n8n
- **Workflow monolítico** (`/webhook/pdf-to-excel`): activo, clientes existentes lo usan vía frontend
- **Sub-workflow** (`/webhook/sub-document`): NADIE lo llama. Puede desactivarse en cualquier momento.
- Worker NO llama a n8n para nada. Código de fallback removido.

### Billing activo
- Org de prueba: `6b505051-9891-4ef0-b163-07eaf7230f22`
- Planes: Entry (200/$0.15), Mid (500/$0.10), Pro (1000/$0.07)
- `charge_credit(p_organization_id, p_job_id, p_amount, p_description)`

### Infraestructura
- Redis Cloud SP: `redis-16705.crce216.sa-east-1-2.ec2.cloud.redislabs.com:16705`
- BullMQ queue: `pdf-processing`, 3 attempts, backoff exponencial
- Worker concurrency: 3
- Gateway: `https://automation.aignition.net/worker/api/enqueue`
- Supabase: `klhbgsiatzbmxbkzpbzv`

---

## DT-009 — RESUELTO (2026-06-01)

**Fix aplicado**: PyMuPDF como tercera herramienta de extracción de adjuntos.

**Causa raíz**: `508353-THAXOL 37434.pdf` tenía su OC embebida via **FileAttachment annotation** (`/Annot type 17`). pdfdetach y mutool no la detectaban. PyMuPDF sí.

**Archivos modificados**:
| Archivo | Cambio |
|---|---|
| `worker/extract_attachments.py` | NUEVO — script Python que usa PyMuPDF para extraer adjuntos vía EmbeddedFiles Y FileAttachment annotations |
| `worker/zip-processor.mjs` | Agrega PyMuPDF como tercera herramienta paralela, combina y deduplica con pdfdetach + mutool |
| `worker/Dockerfile` | Agrega `python3`, `py3-pip`, `pip install pymupdf` |

**Validación**: ZIP de 20 facturas → **18/18 OCs** ✅. `post.job_finalized → oc_relations: 18`.

## PRÓXIMA TASK

### TASK-16 — Saldo de créditos en tiempo real en el frontend

---

## Deuda técnica activa

| ID | Descripción | Prioridad | Estado |
|---|---|---|---|
| DT-009 | OC faltante — PyMuPDF | Alta | ✅ RESUELTO 2026-06-01 |
| DT-007 | OC faltante ocasional residual (evaluar si DT-009 lo cubre) | Media | Monitorear |

---

## Decisiones activas importantes

- **DEC-009**: Billing por créditos, 1 crédito = 1 documento (facturas + OCs)
- **DEC-010**: N8n congelado — sin nuevas responsabilidades
- **DEC-011**: ✅ COMPLETADO — Worker llama directo a Mistral + OpenAI. N8n fuera del pipeline.
- Créditos se descuentan SOLO post-procesamiento exitoso
- `total_documents` = facturas exitosas + OC relations + fallidos (base del billing y UX)

### Fórmula de contadores en pdf_jobs (DT-008 fix vigente)
```
total_documents     = successful + oc_relations + failed
processed_documents = successful + oc_relations
failed_documents    = failed
```
Ejemplo con 20 facturas + 17 OCs = total 37 (no 20, no 38).

---

## Kanban — próximas tasks

| Orden | Task | Estado |
|---|---|---|
| — | DT-009 — PyMuPDF OC faltante | ✅ RESUELTO |
| 35 | **TASK-16 — Saldo en tiempo real en frontend** | ← PRÓXIMA |
| 35 | TASK-23 — Runbook de rollback (Fase 4, bloqueada por cutover) | Backlog |
| ... | Fase 4 — Cutover primer tenant piloto | Próximo bloque |

---

## Comandos útiles de referencia

```bash
# Ver logs en tiempo real
ssh root@157.230.231.207 "docker compose -f /root/worker/docker-compose.yml logs -f worker"

# Deploy completo (incluir .py para extract_attachments.py)
scp "C:/Users/sbras/OneDrive/Documentos/Aignition/Servicios/Data Laundering/data-laundering V2.0/worker/"*.mjs root@157.230.231.207:/root/worker/
scp "C:/Users/sbras/OneDrive/Documentos/Aignition/Servicios/Data Laundering/data-laundering V2.0/worker/extract_attachments.py" root@157.230.231.207:/root/worker/
ssh root@157.230.231.207 "cd /root/worker && docker compose build worker && docker compose up -d worker"

# Verificar env vars dentro del contenedor
ssh root@157.230.231.207 "docker exec dl-worker printenv | grep -E '(MISTRAL|OPENAI|SUPABASE|REDIS)'"

# Query último job de la org de prueba
# Supabase MCP: project klhbgsiatzbmxbkzpbzv
# SELECT id, status, total_documents, processed_documents, oc_relations FROM pdf_jobs
# WHERE organization_id = '6b505051-9891-4ef0-b163-07eaf7230f22' ORDER BY created_at DESC LIMIT 5;
```
