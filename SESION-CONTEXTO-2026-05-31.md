# Contexto de sesión — Data Laundering V2.0
**Fecha**: 2026-05-31  
**Worker version en producción**: v0.8.0 (DO, dl-worker)

---

## Lo que se hizo en esta sesión

### TASK-46 — Mejorar parser OCs + diagnosticar factura fallida ✅
- `parseOcFromAdjName`: mínimo bajado de 4 a 3 dígitos, normalización de slash/guión, filtro de años (2000-2099)
- `buildOcMap`: logging de adjuntos ignorados (`zip.oc_skipped`)
- `processZip`: ahora retorna `{ documents, failedUploads }` — los fallos de upload se cuentan en `failed_documents`
- pdfdetach: skip de remitos ahora loguea `zip.adj_skipped_pdfdetach`

### TASK-47 — Soporte nativo .rar ✅
- `gateway.mjs`: `VALID_FILE_TYPES` incluye `'rar'`
- `worker.mjs`: `if (['zip', 'rar'].includes(fileType))`
- `pdfJobHelpers.ts`: detecta `.rar` y envía `file_type: 'rar'`

### DT-007 — PDFs con FileAttachment annotations (Loma Negra) ✅
**Causa raíz confirmada**: "508112-600-136734 Loma negra.pdf" embebe la OC vía
FileAttachment annotation (`/Annot`), no mediante `/EmbeddedFiles` estándar.
El PDF tiene `AcroForm` malformado (`Can't get Fields array`). En Alpine
(Docker), poppler abortaba la extracción silenciosamente.

**Fix**:
- `Dockerfile`: agrega `mupdf-tools` (Alpine: `apk add mupdf-tools`)
- `zip-processor.mjs`: si pdfdetach extrae 0 adjuntos → loguea `zip.pdfdetach_empty` → ejecuta `mutool extract` como fallback

### Bug adjDir eliminado por flatten ✅
**Causa**: `adjDir = workDir/adj` se crea vacío al inicio de `processZip`.
El paso de aplanado de carpetas (`find "${workDir}" -mindepth 1 -type d -exec rmdir {} +`)
lo borra porque está vacío en ese momento. Pdfdetach después no puede mover adjuntos al dir inexistente.

**Fix** (aplicado en servidor por Claude Code):
Agregar `await mkdir(adjDir, { recursive: true })` justo ANTES del loop de pdfdetach (línea 206 en el servidor).
La línea 181 (original del setup) se mantiene — la nueva en 206 garantiza que adjDir existe post-flatten.

---

## Estado actual del sistema

### Worker v0.8.0 — producción (DO, dl-worker)
```
Servidor: root@157.230.231.207
Ruta: /root/worker/
Compose: docker compose build worker && docker compose up -d worker
```

**Resultado del último ZIP de prueba** (job `5301f6a7-e6c6-48f9-91c1-5a0b92f69912`):
- 20/20 facturas procesadas ✅
- 17/18 OCs escritas en `pdf_job_row_oc` (falta 55062 — ver tarea abierta)
- 0 failed documents

### Infraestructura activa
- Redis Cloud São Paulo: `redis-16705.crce216.sa-east-1-2.ec2.cloud.redislabs.com:16705`
- BullMQ queue: `pdf-processing`, 3 attempts, backoff exponencial
- Worker concurrency: 3
- Input Gateway: `https://automation.aignition.net/worker/api/enqueue`
- Sub-workflow n8n: `https://automation.aignition.net/webhook/sub-document`
- Supabase project: `klhbgsiatzbmxbkzpbzv`
- Org de prueba: `6b505051-9891-4ef0-b163-07eaf7230f22`

### Feature flags
- 8 orgs con `use_worker_pipeline = false` (pipeline monolítico n8n activo para todos)
- Worker en shadow/staging mode con tenants de prueba

---

## Tarea abierta: TASK-48 (Notion: 371e32b0-60fc-8127-9a2e-f437fd21a68b)

**Fix n8n sub-workflow: `pdf_job_row_oc` no se escribe para algunos documentos (DT-001)**

### Síntoma
El worker envía `oc_entries` correctamente a n8n. N8n procesa el documento y escribe en `pdf_job_rows` (confidence 0.98). Pero `pdf_job_row_oc` no se escribe para algunos documentos.

**Caso confirmado**:
- Documento: Elisei → `numero_comprobante: 0004-00003838`  
- `oc_entries` recibido por n8n: `[{numero_oc: "55062", nombre_adjunto: "01-00055062", ...}]`
- `pdf_job_rows`: escrito ✅
- `pdf_job_row_oc`: NO escrito ❌

### Causa raíz (DT-001)
En el sub-workflow de n8n, el nodo `Responder - Success` usa:
```javascript
$input.first().json.id  // ← INCORRECTO en contexto de Loop Over Items
```
Dentro del Loop Over Items, `$input.first()` resuelve al item del loop, no
al resultado del nodo `Create a row`. Esto hace que `row_id = null`.

Si el nodo que inserta en `pdf_job_row_oc` también usa este mismo `row_id`
incorrecto (o usa el row_id de la respuesta del worker), el INSERT falla
silenciosamente.

### Fix a aplicar en n8n
En el sub-workflow (`/webhook/sub-document`), buscar el nodo que hace INSERT
a `pdf_job_row_oc` y el nodo `Responder - Success`. Cambiar:

```javascript
// ANTES (incorrecto):
$input.first().json.id

// DESPUÉS (correcto):
$('Create a row').first().json.id
```

> **Nota**: `Create a row` es el nombre del nodo de Supabase que hace el
> INSERT a `pdf_job_rows`. El nombre exacto puede variar — verificar en el
> workflow.

### Criterio de aceptación
- Subir el ZIP de prueba (20 facturas, 18 OCs conocidas)
- `pdf_job_row_oc` muestra 18 registros para ese job
- OC 55062 de Elisei (`0004-00003838`) aparece
- No rompe las 17 OCs que ya funcionan

### Cómo validar (Supabase)
```sql
SELECT o.numero_oc, o.nombre_adjunto, r.numero_comprobante
FROM pdf_job_row_oc o
JOIN pdf_job_rows r ON r.id = o.row_id
WHERE r.job_id = '{nuevo_job_id}'
ORDER BY o.numero_oc::int;
-- Debe retornar 18 filas
```

---

## Archivos modificados en esta sesión (local + servidor)

| Archivo | Cambios | Dónde |
|---|---|---|
| `worker/Dockerfile` | agrega `mupdf-tools` | Local + Servidor |
| `worker/gateway.mjs` | `'rar'` en `VALID_FILE_TYPES` | Local + Servidor |
| `worker/worker.mjs` | v0.8.0, RAR support, failedUploads | Local + Servidor |
| `worker/zip-processor.mjs` | parser OC, mutool fallback, adjDir fix, failedUploads | Local + Servidor |
| `src/lib/pdfJobHelpers.ts` | `file_type` detecta `.rar` | Local (pendiente deploy frontend) |

---

## Decisiones importantes a recordar

- **DEC-007**: n8n solo extrae + escribe. Toda la lógica post-extracción está en el Worker.
- **DEC-002**: Migración progresiva — workflow monolítico sigue activo. `use_worker_pipeline=false` para todos.
- El worker NUNCA actualiza `pdf_jobs.status` directamente — eso lo hace `finalizeJob` vía REST.
- `pdf_job_row_oc` lo escribe **n8n** (no el worker). El worker solo pasa `oc_entries`.

---

## Próxima sesión: empezar leyendo

1. Este archivo
2. Notion TASK-48: `371e32b0-60fc-8127-9a2e-f437fd21a68b`
3. Notion Decisions Log (DT-001): `367e32b0-60fc-81a7-bc60-e91c5e9a1913`
4. El sub-workflow de n8n en `https://automation.aignition.net`
