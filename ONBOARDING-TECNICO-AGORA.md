# Agora — Documento técnico de arquitectura (onboarding de ingeniería)

*Audiencia: ingeniero/a que se incorpora al sistema. Nivel: técnico completo, uso interno.*
*Actualizado: 2026-08-11 · Estado de referencia: main `62091e7`+ (prod) · Verificado contra código y base de datos en vivo.*

> Documentos hermanos: `DOCUMENTACION-SISTEMA-AGORA.md` (misma arquitectura en lenguaje simple, para no técnicos), `CLAUDE.md` (bitácora operativa viva: zonas cerradas, decisiones, historial de cambios — **leerlo antes de tocar código**), `RUNBOOK-ROLLBACK.md`, `GTM-01-migracion-agoradigital.md`. Tableros de tareas en Notion: «📋 Kanban — Roadmap de Escalado» y «📋 Kanban Parte 2» (las tareas nuevas van a Parte 2).

---

## 1. Qué es Agora (en dos párrafos)

SaaS **multitenant de digitalización de comprobantes fiscales argentinos**. El cliente (p. ej. una constructora) deja PDFs de facturas de sus proveedores en una carpeta conectada o los sube por la web; Agora hace OCR, interpreta el documento con IA (emisor, receptor, tipo de comprobante, importes, impuestos, percepciones, CAE, renglones), aplica una capa de **correcciones determinísticas** (identidades aritméticas, número de comprobante desde lo impreso), clasifica el resultado con un semáforo (Exitoso / Con advertencia / Fallido, siempre con la razón), y devuelve los datos en la app y como CSV/Excel depositado en la carpeta del cliente. Cobra por documento contra un saldo prepago en USD.

**Está en producción con clientes reales.** La regla número uno del proyecto: *estabilidad > velocidad*. Todo cambio es incremental, reversible y se valida con documentos reales antes de considerarse terminado (ver §17).

---

## 2. Mapa de arquitectura

```
  ENTRADAS                          BACKEND (VPS DigitalOcean)               SERVICIOS EXTERNOS
  ────────                          ──────────────────────────               ──────────────────
  Carpeta del tenant                ┌──────────────────────────────┐
  (Drive / Supabase St. /          │  worker container (Docker)    │
   Firebase St.)                   │  ┌─────────────────────────┐  │
    │  polling 1..120 min          │  │ gateway.mjs  :3001      │  │
    ├──► pollers ── handoff ──────►│  │  /api/enqueue (Bearer)  │──┼──► BullMQ "pdf-processing"
    │    (chequeo de saldo,        │  │  /api/mp/* (IPN MP)     │  │    (Redis Cloud sa-east-1,
    │     move a en_proceso/)      │  │  /api/drive|integr.*    │  │     noeviction, attempts:3)
    │                              │  │  /api/metrics /health   │  │            │
  App web (React) ── upload ──────►│  └─────────────────────────┘  │            ▼
    │                              │  worker.mjs (BullMQ worker,   │◄───────────┘
    │                              │   WORKER_CONCURRENCY=3)       │
    │                              │    └─► document-processor.mjs ┼──► Mistral OCR (texto)
    │                              │         (OCR→IA→determinismo) ┼──► OpenAI (extracción; visión
    │                              │    └─► post-processor.mjs     │        aislada gateada por flag)
    │                              │         (persistencia+cobro)  │
    │                              │    └─► output-depositor.mjs   ┼──► CSV/XLSX a la carpeta
    │                              │    └─► integration-file-mover ┼──► en_proceso→procesados/fallidos
    │                              │  metrics.mjs :9090            │
    │                              └──────────────────────────────┘
    │                                        │
    ▼                                        ▼
  app.agoradigital.io  ◄──────────  Supabase (Postgres+RLS+Realtime+Storage)
  (frontend estático,               proyecto klhbgsiatzbmxbkzpbzv
   Caddy, SPA React)                (docs, saldos, fichas, cuaderno, triggers)

  Pagos: MercadoPago ──IPN──► gateway /api/mp/webhook ──► RPC add_credits
  Admin: MonitoreoPage (superadmin) ve TODAS las orgs vía RPCs SECURITY DEFINER
```

Los tres dominios: `agoradigital.io` (landing, apex) · `app.agoradigital.io` (SPA) · `api.agoradigital.io` (gateway, directo al :3001, sin path). El dominio anterior `dataland.aignition.net` está decomisionado (migración GTM-04, 2026-06-28); la marca del producto es **Agora** aunque quedan rastros del nombre viejo "DataLand" en rutas internas (p. ej. `/var/www/dataland/`).

---

## 3. Infraestructura y entornos

| Pieza | Dónde | Detalle |
|---|---|---|
| VPS | DigitalOcean `157.230.231.207` (root) | Corre TODO el backend + sirve el frontend |
| Worker/gateway | `/root/worker/` (Docker Compose, contenedor `dl-worker`) | Imagen Alpine + Node ESM + python3/pymupdf + 7zip/bsdtar. `docker compose build && up -d --force-recreate` SIEMPRE (nunca `docker run` manual: queda fuera de `caddy_net`) |
| Frontend | `/var/www/dataland/` | Estático, servido por **Caddy en Docker** (`n8n-caddy-1`, Caddyfile en `/opt/n8n/caddy/Caddyfile`). ⚠️ NUNCA `docker compose down` del stack n8n (tira el Caddy). `assets/*` con cache inmutable 1 año; `index.html` no-cache (los deploys se toman al recargar) |
| Base de datos | Supabase `klhbgsiatzbmxbkzpbzv` | Postgres + RLS + Realtime + Storage (buckets `documents`, `facturas`) |
| Cola | Redis Cloud sa-east-1, DB `agora` | `maxmemory-policy=noeviction` (2026-07-04: BullMQ no tolera eviction) |
| OCR | Mistral OCR (API) | Recibe la URL pública del archivo en Storage — por eso los nombres se sanean (§10) |
| LLM | OpenAI | Extracción por texto; visión aislada `OPENAI_VISION_MODEL` (default gpt-4.1-mini) gateada por tenant |
| Pagos | MercadoPago | `MP_ACCESS_TOKEN` de producción (seller 290523599), IPN validado e2e |
| Errores front | Sentry | `@sentry/react` + vite-plugin con source maps |

**No hay staging.** `main` = producción al cierre de cada ronda; los cambios se deployan *antes* de commitear y se commitean recién al validar con documentos reales (§17). El sandbox de pruebas es el propio tenant **Aignition** (bucket `test-agora`), no un entorno aparte.

**Superadmins** (columna `profiles.is_superadmin`): `sbrasesco@outlook.es`, `javierginez@gmail.com`.

**Tenants activos** (2026-08): **MENARA CONSTRUCCIONES S.A.** (cliente real; integración Supabase Storage, bucket `produccion`, polling 1 min; ~650 procesos desde el 20/07) · **Aignition** (tenant propio de testing; Supabase Storage `test-agora`, polling 1 min) · **Estudio ACME** (Drive, poco volumen).

---

## 4. El repositorio

Un solo repo (raíz = frontend Vite; el worker vive adentro):

```
data-laundering V2.0/
├── src/                    # Frontend React 18 + TypeScript + Vite
│   ├── pages/              # 13 páginas, TODAS lazy (React.lazy + Suspense)
│   ├── components/         #   layout/ (AppShell), pdf-jobs/, documents/, ui/ (shadcn)
│   ├── hooks/              # usePdfJobs, useClientJobs, useAllDocuments, useTenantCredits…
│   ├── contexts/           # AuthContext (⚠️ zona cerrada, ver §6)
│   ├── lib/                # supabase.ts, documentClassification.ts, themes.ts
│   └── utils/              # excelExport (xlsx dinámico), dateFormat, status
├── worker/                 # Backend Node ESM (.mjs) — se deploya por scp + docker build
│   ├── gateway.mjs         # HTTP :3001 — entrada de todo (62 KB)
│   ├── worker.mjs          # BullMQ worker + cron de pollers
│   ├── document-processor.mjs  # OCR + prompt + determinismo (44 KB, el corazón)
│   ├── post-processor.mjs  # persistencia de resultados + cobro
│   ├── output-depositor.mjs    # CSV/XLSX de salida + dedup de duplicados
│   ├── zip-processor.mjs   # ZIP/RAR (7zz + bsdtar) + adjuntos embebidos (flag por org)
│   ├── poller-handoff.mjs  # contrato común de pollers + guard de saldo
│   ├── integration-poller.mjs      # Google Drive (OAuth + service account legacy)
│   ├── supabase-storage-poller.mjs # Supabase Storage
│   ├── firebase-storage-poller.mjs # Firebase Storage
│   ├── ftp-sftp-poller.mjs # existe pero DESACTIVADO (integración ⛔)
│   ├── integration-file-mover.mjs  # en_proceso→procesados/fallidos/duplicados + rename
│   ├── doc-naming.mjs      # {cuit}_{numero}_{codigoafip} compartido
│   ├── metrics.mjs (:9090) # queue_depth, latencia p50/p95, error rate
│   ├── errors.mjs          # TerminalError (no reintenta) vs transitorios
│   ├── dlq-processor.mjs, persistence.mjs, bull-board.mjs
│   └── Dockerfile, docker-compose.yml, deploy.sh, rollback.sh
├── sql/                    # scripts versionados (p. ej. tests/test_classify_pdf_job_row.sql)
├── queue-service/          # verificaciones de la fase INFRA (histórico)
├── CLAUDE.md               # ⭐ bitácora operativa (zonas cerradas, decisiones, historial)
├── DOCUMENTACION-SISTEMA-AGORA.md / .docx   # arquitectura en lenguaje simple
├── BRAND-GUIDELINE-AGORA.docx               # identidad visual (ver §19)
├── GTM-01-migracion-agoradigital.md, GTM-06-verificacion-oauth.md, RUNBOOK-ROLLBACK.md
└── package.json, vite.config.ts, tailwind.config.js, tsconfig.json
```

⚠️ Particularidad operativa: la carpeta vive en **OneDrive**. Hay historial real de archivos **truncados** al editarlos con herramientas de edición automática (8+ casos) y de latencia de sync (un scp puede subir una versión vieja). De ahí dos costumbres del equipo: ediciones grandes **vía script python** con verificación posterior (`node --check`/esbuild + balance de llaves + `git diff --stat`), y **handshake md5** local → servidor → contenedor en cada deploy. El `.gitattributes` normaliza EOL a LF (los "modified" masivos sin diff real son ruido CRLF).

---

## 5. Frontend — arquitectura

**Stack**: React 18 + TypeScript + Vite + shadcn/ui + Tailwind + react-router. Bundle inicial ~529 KB (159 KB gzip): las 13 páginas son chunks lazy, `xlsx` se importa dinámico solo al exportar, el DatePicker es chunk aparte.

**Páginas**: `AppHomePage`, `ClientDashboardPage` (dashboard del tenant), `MisProcesosPage` (historial de jobs), `DocumentsPage` (todos los documentos), `ProcesoDetailPage`, `SubirZipPage` (carga manual), `IntegracionesPage`, `MonitoringPage` (solo superadmin, `SuperadminRoute`), `ClientsPage`, `SettingsPage`, `LoginPage`, `OnboardingPage`, `LandingPage`. Layout con `<Outlet/>`: `AppShell` (sidebar) se monta una sola vez.

**Patrones que hay que conocer antes de tocar nada** (la mayoría nacieron de incidentes reales y están en ZONA CERRADA):

- **Auth (AuthContext.tsx)**: el callback `onAuthStateChange` es **SÍNCRONO a propósito**. Supabase v2 retiene el session-lock durante el callback: si es async y espera el fetch del profile, `getSession()` se bloquea y la app queda 20 s en spinner. `setLoading(false)` apenas se conoce la sesión; `fetchProfile` corre fuera del lock (`Promise.resolve().then`), fire-and-forget con 3 reintentos, y NUNCA setea `profile=null` en error.
- **`window.__nativeFetch`** (`lib/supabase.ts` + guard en `index.html` `<head>`): SDKs de terceros (Amplitude etc.) parchean `window.fetch` y rompen el cliente Supabase; se captura el fetch nativo antes de cargar nada externo. No reemplazar por `fetch` directo.
- **Hooks con guard de auth** (`useTenantCredits`, `useClientJobs`): `if (authLoading) return` → `if (!organizationId) return` manteniendo `loading=true` (el profile llega en background). Sin esto, los componentes parpadean con ceros.
- **Realtime + polling de respaldo**: publicación `supabase_realtime` habilitada para `pdf_jobs` y `pdf_job_rows`. Los nombres de canal NO se pueden duplicar entre hooks (`useClientJobs`→`pdf_jobs_changes`; `usePdfJobs`→`mis_procesos_jobs_changes` + `mis_procesos_rows_changes`); dos suscripciones con el mismo nombre se corrompen. Todos los hooks tienen polling de fallback por si Realtime no entrega.
- **Paginación server-side en las 3 vistas de volumen** — lección repetida tres veces (Documentos, Dashboard, Mis Procesos): traer "todo" de una org funciona hasta que el cliente acumula cientos de filas y una URL de PostgREST con `.in(ids)` explota contra el límite del proxy (~16 KB). El patrón vigente: `.range()` + `count:'exact'` + página de 10-15 + los `.in()` siempre scoped a los ids de la página + filtros en el query (no en JS) + Realtime refresca la página visible con debounce.
- **Fechas**: componente propio `date-picker.tsx` (shadcn popover + react-day-picker, locale es, muestra dd/MM/yyyy). Contrato interno estricto `yyyy-MM-dd | ''` (idéntico al viejo `<input type=date>`). Cota superior de rangos: `created_at < (fechaHasta + 1 día)` parseado a mano — `new Date('yyyy-MM-dd')` parsea UTC y con `setHours` local (UTC-3) excluía el propio día.
- **Sidebar de saldo (AppShell)**: 3 estados — skeleton → rojo «Saldo insuficiente para procesar» cuando `balance < 1` (el mínimo real de procesamiento, mismo umbral que el 402 del gateway; NO `<=0`) → verde con monto y `≈N docs` estimado vía `get_price_breakdown()`.
- **Estados de documento**: vocabulario unificado Exitoso / Con advertencia / Fallido. El front NO clasifica: lee `doc_status` + `warning_reason` que calcula la DB (§12). Helper `documentClassification.ts`.

**tsc**: `npx tsc --noEmit` tiene un baseline conocido de **4 errores preexistentes** (IntegracionesPage ×3 TS2367 + OnboardingPage TS2339). El criterio de todo cambio es **0 errores nuevos**, no 0 absoluto. Housekeeping pendiente de matarlos.

---

## 6. El gateway (`gateway.mjs`, :3001)

Servidor HTTP único (sin framework pesado) que atiende `api.agoradigital.io`. Rutas:

| Ruta | Auth | Función |
|---|---|---|
| `POST /api/enqueue` | Bearer `GATEWAY_API_KEY` | Entrada universal de trabajo: valida `input_source` contra `VALID_SOURCES`, **chequea saldo (`balance < 1` → 402 `INSUFFICIENT_CREDITS`, fail-open si el chequeo falla)**, crea el `pdf_jobs` vía RPC `gateway_create_pdf_job` y encola en BullMQ con `attempts:3` + backoff exponencial 5 s. El `metadata` del body se **spreadea completo** al job (preserva el `fileMeta` de los pollers: `integration_id`, `original_path`, etc. — sin eso el file-mover no puede mover el archivo después) |
| `POST /api/mp/create-preference` / `create-custom-preference` | Bearer | Genera preferencia de pago MP. El UUID de `payments` se genera ANTES del INSERT y viaja como `external_reference` |
| `POST /api/mp/webhook` | sin auth (IPN) | Notificación de pago MP: lookup por `preference_id`/`external_reference`, idempotencia por `gateway_payment_id`, acredita vía RPC `add_credits` (planes acreditan `billing_plans.balance_usd`; custom acredita lo pagado por tramos de `credit_price_tiers`) |
| `POST /api/deposit-row` | Bearer | Deposita la salida de UN doc aprobado a mano (flujo editar→aprobar) |
| `/api/drive/folders`, `set-folder`, `/api/auth/google/callback` | Bearer / público | OAuth y carpetas de Drive |
| `/api/integrations/init-folders`, `test-connection`, `migrate-folders` | Bearer | Alta/verificación de integraciones (crea la estructura de carpetas, incl. `duplicados/`) |
| `GET /api/metrics` | Bearer | Proxy a `metrics.mjs` :9090 (lo consume MonitoringPage) |
| `GET /api/prompt` | Bearer | Visor read-only del SYSTEM_PROMPT del extractor |
| `GET /health` | Bearer `staging-key-2026` | `{status, gateway, worker_version, google_oauth}` |

`input_source` válidos: `frontend_upload`, `integration_drive`, `supabase_storage`, `firebase_storage`, `ftp`, `sftp`, `api_direct`, `integration_remote` (el CHECK de la tabla `pdf_jobs` está alineado con `VALID_SOURCES`; se desalinearon una vez y los jobs morían en silencio — lección aprendida).

Truco operativo: **re-encolar un documento para pruebas sin tenant** = `curl` desde el VPS a `http://localhost:3001/api/enqueue` con la key del `.env`, `input_source: api_direct`, la org de Aignition y una `file_url` del Storage propio.

---

## 7. Cola y worker (`worker.mjs` + BullMQ)

- Cola única `pdf-processing` en Redis. **1 documento = 1 unidad de procesamiento** (un ZIP se abre y cada PDF interno es un doc del mismo job; NUNCA procesar un ZIP como unidad).
- `WORKER_CONCURRENCY=3`. Cron interno del mismo proceso dispara los pollers de integraciones según `polling_interval_minutes` por integración.
- **Resiliencia (validada en prod)**: encolado con `attempts:3` + backoff exponencial 5 s → los errores transitorios (Mistral 503, fetch cortado, URL de storage aún no propagada) se recuperan solos. Los `TerminalError` (`errors.mjs`: sin saldo, ZIP vacío, formato inválido) van como `UnrecoverableError` y NO reintentan. El handler `on('failed')` **persiste la falla final** vía `failJob` (PATCH idempotente) → no quedan filas huérfanas en `processing`. Si aparece un job "trabado", se inspecciona el hash de BullMQ (`bull:pdf-processing:<job_id>` → `failedReason`/`attempts`/`opts`) y se destraba con UPDATE scoped.
- ⚠️ `docker compose up -d --force-recreate` corta jobs en vuelo (mitigado por attempts:3, pero se deploya con la cola vacía: `queue_depth` en `/api/metrics`).
- Flujo por job: descargar archivo → `zip-processor` si es comprimido (7zz con fallback bsdtar para RAR5; extracción de adjuntos embebidos de PDFs gateada por `tenant_feature_flags.extract_embedded_attachments`, hoy solo Aignition) → por cada doc: `document-processor` (§8) → `insertJobRow` → `post-processor.finalizeJob` (agregados del job: `processed/failed/low_confidence_documents`, manifiesto de archivos, cobro vía `charge_credit`) → `output-depositor` (§9) → `integration-file-mover` (§10, si vino de integración).

---

## 8. Extracción (`document-processor.mjs`) — el corazón del producto

Tres capas, en orden. La filosofía: **la IA propone, el determinismo confirma**.

### 8.1 OCR
Mistral OCR sobre la URL pública del archivo en Storage → markdown/texto crudo, guardado ÍNTEGRO en `pdf_job_rows.raw_ocr_text` (es la fuente de verdad para debugging y para las correcciones determinísticas). Limitación conocida: pierde texto que solo existe como imagen (logos, la letra A/B/C dibujada en el recuadro) — varias piezas de abajo existen por esto.

### 8.2 El prompt (SYSTEM_PROMPT)
Apertura como **"analista de comprobantes fiscales argentinos"** (interpretar, no copiar texto suelto). Puntos principales:
- EMISOR vs RECEPTOR por etiquetas explícitas («Señor/es:», «Cliente:», etc.).
- **Detección de TIPO en 3 niveles**: (1) letra del encabezado; (2) «Cod. NN» impreso → tabla AFIP; (3) inferencia fiscal (Monotributo→C; RI+IVA discriminado→A; RI sin discriminar/CF→B). Nunca clase sin variante.
- **Importes interpretativos**: no copiar por etiqueta; `neto_gravado` por pasos (nunca usar el TOTAL como neto si hay exentos/percepciones; con descuento, el neto es la base POST-descuento); IVA null en B/C sin discriminar (no estimar); percepciones IIBB multi-línea por jurisdicción = SUMAR; en combustibles, IDC/ITC = impuestos internos.
- Devuelve JSON estricto (ESTRUCTURA EXACTA), incluye `items[]` (renglones) y `codigo_afip: null` (lo deriva el worker, no la IA).
- ⚠️ Regla de gobierno: el prompt **solo se adapta de forma ADITIVA** con OK del director. Nunca se reescribe. Cada cambio se valida comparando OFF/ON con los MISMOS documentos: los importes deben quedar idénticos.

### 8.3 Determinismo post-IA (donde vive gran parte del valor)
- **`comprobanteFromOcr(ocrText)`**: el comprobante se extrae del TEXTO IMPRESO como fuente de verdad (patrones AFIP: letra+12/13 dígitos pegados, o `\d{4,5}-\d{8}`; no matchea CUIT ni CAE). **Lo impreso manda sobre lo que dice el modelo.**
- **`splitComprobante`**: separa PV (4-5 dígitos) + correlativo (8) aunque vengan pegados o con la letra adherida. La letra A/B/C/M/E es la CLASE, jamás parte del PV.
- **`normalizePuntoVenta`**: PV canónico de 4 dígitos (recorta `00004→0004`; respeta PV genuinos de 5).
- **`codigo_afip` derivado**: la IA NO lo extrae; el worker lo deriva de `tipo_documento` contra la tabla `document_types` (cacheada 10 min, solo tipos `active`) → tipo y código nunca se contradicen.
- **Identidades aritméticas** (solo ajustes chicos, con salvaguarda de desvío >0.5 y < max(1000, 2% del total) para no romper estructuras no contempladas):
  - CON descuento → `neto_gravado = total − iva − exento − percepciones − internos` (los LLM restan mal; caso Litoral Vial).
  - SIN descuento y percepción IIBB ≠ 0 → deriva `percepcion_ingresos_brutos` por identidad (multi-jurisdicción, caso Loma Negra). Mutuamente excluyentes.
- **Perfiles de proveedor** (§13): si el CUIT de un perfil activo aparece en el OCR (matcheo por dígitos), sus `prompt_hints` se inyectan al user message en bloque delimitado `[PERFIL DEL PROVEEDOR …]`. Sin match = byte-idéntico a no tener perfiles. Caché 10 min. Fail-safe total.
- **Visión aislada (arquitectura B, gateada por `tenant_feature_flags.vision_type_detection`)**: una llamada multimodal aparte mira la imagen de la 1ª página (render con **PyMuPDF, nunca pdftoppm** — en Alpine sin fuentes deja el PNG en blanco) y solo puede sobrescribir `tipo_documento`. La variante A (imagen en la misma llamada de extracción) se DESCARTÓ porque movía importes. Cualquier fallo de render/visión → no toca nada.

### 8.4 Clasificación (en DB, no en el worker)
El trigger `classify_pdf_job_row` (BEFORE UPDATE en `pdf_job_rows`) calcula `doc_status` y `warning_reason` en cada cambio: `failed` solo con error real o cero datos; advertencia por `IMPORTE_NO_CIERRA` (chequeo aritmético, tolerancia 1%), `REVISAR_DESCUento` (descuento + no cierra), `CAMPOS_FALTANTES`, `BAJA_CONFIANZA` (<0.70), `DATOS_INCOMPLETOS`; `approved_at` siempre gana → ok. Tiene harness versionado: `SELECT * FROM test_classify_pdf_job_row();` → **18/18 PASS** obligatorio tras cualquier cambio del trigger.

---

## 9. Salidas (`output-depositor.mjs`)

- **CSV** por doc con separador `;`, encabezados legibles (IVA 21%, IVA 10,5%…), columna `descuento`, sin la columna `iva` genérica.
- **Excel acumulativo** (`resultados.xlsx`) para Drive: re-mapea filas históricas al regenerar (idempotente). Feature paga `master_file`.
- **Detalle de productos** (renglones): archivos aparte (`productos.xlsx` acumulativo / `{base}_productos` per-job), gateado por flag `line_items_enabled` (+$0.10/doc). La extracción de items corre SIEMPRE (dato propio); solo la entrega/cobro se gatea.
- **Duplicados**: misma factura = mismo CUIT + PV + correlativo ya procesado antes en la org → se procesa y se cobra, se marca `is_duplicate` (fila) + `has_duplicate` (job), el PDF va a `duplicados/`, y **NO se deposita salida** (evita registros repetidos en el ERP del cliente). Aplica en todos los flujos con salida.
- Aprobación manual (`/api/deposit-row`): al aprobar un doc editado se deposita su salida y, si estaba incompleto, `renameProcessedInputOnApproval` renombra el archivo en `procesados/` con los datos definitivos.

---

## 10. Integraciones (carpetas vigiladas) — ⚠️ pipeline en ZONA CERRADA

**Contrato común** (`poller-handoff.mjs` + convención de carpetas): el usuario suelta archivos en la raíz de su carpeta/bucket → el poller los mueve a `en_proceso/` → el worker los mueve a `procesados/` o `fallidos/` (o `duplicados/`) al terminar → las salidas se depositan en `extracciones/`.

Reglas que definen el comportamiento:

1. **Sin dedup en la entrada (DEC-019)**: los pollers levantan y procesan TODO lo que haya en la raíz, repetidos incluidos (el usuario es responsable de lo que sube). La garantía de procesamiento único es que **el archivo sale de la raíz**: se encola SOLO si el move a `en_proceso/` tuvo éxito. Las copias en las subcarpetas llevan prefijo timestamp para que nombres repetidos no choquen.
2. **Guard de saldo (POLLER-BALANCE-GUARD, 2026-08)**: al inicio del ciclo de cada integración se consulta el balance de la org; si `< $1` (**mismo umbral fijo que el 402 del gateway — se cambian en tándem o no se cambian**), el poller NO toca ningún archivo (quedan en la raíz), loguea `poller.skip_no_credits` una vez por ciclo y actualiza `last_polled`. Si aun así el enqueue devuelve 402 (carrera de saldo justo), el error viene tipado (`err.code='INSUFFICIENT_CREDITS'`) y el poller **devuelve el archivo a la raíz** → al recargar saldo todo se recupera solo. Motivación: incidente real (tenant sin saldo → archivos varados en `en_proceso/` sin ningún registro, silencio total).
3. **Sanitización de nombres**: la clave de storage en Aurora se sanea (espacios/caracteres raros → `_`) porque un nombre con espacios genera una URL que Mistral no puede descargar (400). El nombre real se conserva en `original_filename` para display.
4. **Renombrado por dato**: en storage (Supabase/Firebase), los archivos de jobs de 1 doc con los 3 datos clave se renombran `{cuit}_{numero}_{codigoafip}.{ext}` al ir a `procesados/` (helper `doc-naming.mjs`). Drive no se renombra (usa el acumulativo + move por ID; decisión del director).
5. **Archivos rechazados** (formato no soportado): `registerRejectedFile` → RPC crea un `pdf_jobs` con `error_type='rejected'` y la razón; el archivo va a `fallidos/`; visible en la app como Fallido; no se cobra.
6. **Agregar una integración nueva** = un poller nuevo (`{nombre}-poller.mjs` con list+download+move+`uploadAndEnqueue`+`fileMeta`) + el `input_source` al CHECK de `pdf_jobs` y a `VALID_SOURCES`. El resto (move post-worker, salidas, rechazados, guard de saldo) es automático por el contrato.

Específicos: **Drive** = OAuth 2.0 (`VITE_GOOGLE_CLIENT_ID` / callback `api.agoradigital.io/api/auth/google/callback`; verificación de Google pendiente — GTM-06 diferida, materiales listos) con service-account legacy; subcarpeta por cliente del estudio. **Supabase/Firebase Storage** = credenciales del bucket del TENANT encriptadas en `tenant_integrations.credentials_encrypted` (⚠️ la columna `credentials` NO existe; leer vía RPC `admin_get_integration_credentials`). **SFTP/FTP** = código presente, integración desactivada. Activar/desactivar una integración (`is_active`) frena su polling y su cargo, sin tocar el worker.

---

## 11. Modelo de datos (Supabase, todas las tablas con RLS)

Núcleo (ver esquema completo en la DB; esto es el mapa mental):

| Tabla | Rol |
|---|---|
| `organizations` | El tenant. `tax_id` = CUIT del cliente |
| `profiles` | Usuario ↔ org (+ `is_superadmin`). Trigger `handle_new_user` crea org+profile al registrarse (el frontend NUNCA inserta org/profile) |
| `clients` | Sub-clientes de un tenant (p. ej. un estudio contable con varios clientes) |
| `pdf_jobs` | El proceso (tanda). Estado, contadores (`processed/failed/low_confidence_documents`), `input_source`, `period_month/year` (trigger `trg_set_pdf_job_period`: mes de PROCESAMIENTO en TZ Buenos Aires, override siempre), `file_manifest` (jsonb de archivos detectados), `file_location` (dónde quedó el input), `has_duplicate` |
| `pdf_job_rows` | El documento con TODOS los datos extraídos + `raw_ocr_text` + `doc_status`/`warning_reason` (calculados por trigger) + `confidence_score` + `is_duplicate` + `approved_at/by` |
| `pdf_job_row_oc` | Órdenes de compra vinculadas a un doc |
| `pdf_job_row_items` | Renglones producto/cantidad/precio (LINE-ITEMS) |
| `organization_credits` / `credit_transactions` | Saldo USD y libro de movimientos (cargo con desglose en metadata) |
| `billing_plans` / `feature_pricing_multipliers` / `polling_interval_tiers` / `credit_price_tiers` | TODOS los precios, dinámicos, editables desde Monitoreo→Precios sin deploy |
| `payments` | Pagos MP (preference → payment, idempotencia) |
| `tenant_integrations` | Integraciones por tenant (`credentials_encrypted` bytea, `folder_path`, `polling_interval_minutes`, `is_active`, salida `output_enabled/format`) |
| `integration_processed_files` | Legado del dedup (retirado por DEC-019; la tabla y sus RPCs quedan) |
| `tenant_feature_flags` | Flags por org: `vision_type_detection`, `extract_embedded_attachments`, `line_items_enabled` |
| `document_types` | Catálogo AFIP completo (97 códigos + tipos propios; 12 activos = los que el sistema procesa). `codigo_afip` por tipo. `country` (default AR) = dimensión de regionalización futura. Editable desde Monitoreo sin deploy |
| `extraction_corrections` | El «cuaderno»: par IA→humano por cada edición de usuario (§13) |
| `proveedor_profiles` | Fichas de lectura por CUIT, GLOBALES (§13) |
| `pdf_document_audit_log`, `worker_events`, `queue_jobs`, `workflow_logs` | Auditoría/observabilidad (workflow_logs es legado de n8n) |

**Triggers que hay que conocer** (lógica de negocio EN LA DB, decisión DEC-007/017: derivación determinística sobre una sola fila es aceptable en DB; procesamiento pesado va al worker):
- `classify_pdf_job_row` (BEFORE UPDATE, `pdf_job_rows`) → `doc_status` + `warning_reason`. Harness 18/18 obligatorio.
- `trg_set_pdf_job_period` (BEFORE INSERT, `pdf_jobs`) → período = mes de procesamiento, universal. El frontend NO manda período.
- `trg_capture_extraction_correction` (AFTER UPDATE, `pdf_job_rows`) → captura al cuaderno. Discriminador de "edición humana" = **`auth.uid()` presente** (worker/service key = null → no captura). EXCEPTION-swallow: la captura jamás rompe la edición.
- `trg_assign_free_plan` → org nueva arranca con plan free + USD 20 de saldo (trial intencional).

**RPCs relevantes** (las de admin son SECURITY DEFINER + guard `is_superadmin` sobre `auth.uid()`):
`charge_credit` (cobro: `(base + features + polling) × docs`) · `add_credits` (solo service key/gateway) · `add_credits_admin` (desde UI superadmin) · `approve_document_row` · `get_price_breakdown` · `get_dashboard_metrics` (SECURITY INVOKER: respeta RLS) · `get_system_avg_confidence` · `get_monitoring_overview` + `get_admin_jobs(org,desde,hasta,status,limit,offset)` (Monitoreo global) · `get_all_tenants_admin` / `get_all_users_admin` / `get_tenant_jobs_admin` / `get_tenant_monthly_activity` · `gateway_create_pdf_job` · `gateway_register_rejected_file` · `upsert_document_type` / `toggle_document_type` · `upsert_proveedor_profile` · `get_corrections_stats` · `set_integration_active` · `set_tenant_line_items` / `set_tenant_attachment_extraction` · `update_feature_cost` / `update_polling_tier`.

**Lecciones de Postgres pagadas con incidentes** (respetarlas al escribir RPCs):
- En `RETURNS TABLE(...)` + SECURITY DEFINER, calificar SIEMPRE las columnas en subqueries (`profiles.is_superadmin`) o explota `42702 ambiguous` (pasó 3 veces).
- Cambiar la firma de una función con defaults = **DROP + CREATE**, nunca `CREATE OR REPLACE` (deja un overload ambiguo `42725`; bug real que bloqueó la aprobación manual). Verificar `count(*) FROM pg_proc` = 1.
- Para testear RPCs con guard simulando sesión: `set_config('request.jwt.claims', '{"sub":"<uuid>"}', true)` → `auth.uid()` devuelve ese sub.
- Sin backfill salvo pedido explícito.

---

## 12. Multitenancy y seguridad

- **Todo dato pertenece a una org** (`organization_id`/`org_id` en cada tabla) y **RLS está habilitado en todas**: un tenant solo ve lo suyo a nivel motor de DB, no de aplicación. Toda tabla nueva DEBE nacer multitenant + RLS.
- El acceso cross-org existe solo vía RPCs SECURITY DEFINER con guard de superadmin (panel Monitoreo) o vía service key (worker/gateway).
- Credenciales de integraciones: encriptadas a nivel aplicación en `credentials_encrypted` (bytea); en REST jamás seleccionar credenciales.
- El worker usa la service key (bypasea RLS); por eso el discriminador del cuaderno es `auth.uid()` y no un estado.

---

## 13. El flywheel de IA (AI-IMPROVEMENT) — el sistema que aprende

Tres piezas en producción, cerrando un loop completamente self-service (sin SQL, sin deploy):

1. **`extraction_corrections` (el cuaderno)**: cada edición humana de un doc queda anotada automáticamente por trigger — par `original` (lo que dijo la IA) vs `corrected` (lo que puso el humano), solo los campos que cambiaron, con `row_id` para joinear al `raw_ocr_text`. Validado con capturas reales de 2 tenants.
2. **`proveedor_profiles` (las fichas)**: instrucciones de lectura POR PROVEEDOR (clave = CUIT, 11 dígitos), globales a todos los tenants porque describen el FORMATO de impresión del emisor, no datos del cliente. El worker matchea el CUIT contra el OCR y le inyecta los hints al prompt. Un error se corrige UNA vez y queda aprendido. Casos reales en producción: percepciones multi-jurisdicción (Loma Negra), IDC/ITC combustibles (GRAFER), comprobante pegado (Elsener, Navone), subtotal−bonificación (Litoral Vial), y **emisor cuyo nombre solo existe en el logo** → el modelo invertía emisor/receptor (URBANA; el OCR de texto no ve imágenes: el único bloque «Razón Social+CUIT» textual era el del cliente).
3. **Visor + gestión en Monitoreo (tarjeta IA → Correcciones)**: totales, campos más corregidos, proveedores con más correcciones (con indicador de si ya tienen ficha), últimas correcciones con detalle IA→humano, y el editor de fichas ahí mismo (crear/editar, prellenado desde una corrección; efecto en ~10 min por el caché del worker).

El ciclo: *usuario corrige → cuaderno anota → visor muestra el patrón → se escribe la ficha → la IA deja de errar ese proveedor*. Pendientes del épico (esperan volumen de datos): few-shot dinámico desde correcciones, métricas de routing por confianza, fine-tuning.

---

## 14. Billing

- Saldo prepago en **USD** (`organization_credits.balance`, numeric(12,4)). Carga por MercadoPago (planes con bonus o monto custom por tramos).
- **Cobro por documento** al finalizar el job: `charge_credit` descuenta `(precio_base + features activas + tier de polling) × docs`. El desglose queda en `credit_transactions.metadata`. Precio base = `billing_plans.price_per_doc` del plan `basico`; TODO editable desde Monitoreo→Precios con efecto inmediato.
- Features con precio: integraciones (Drive $0.20, Supabase/Firebase $0.15, SFTP $0.03), Excel acumulativo (`master_file` $0.05), detalle de productos (`line_items` $0.10), revisión humana, tiers de polling (1-120 min). *(Valores al día de hoy — son configuración viva, no constantes.)*
- **Mínimo de procesamiento: $1** — el gateway rechaza con 402 por debajo, los pollers no levantan archivos por debajo, y el sidebar avisa por debajo. Los tres comparten el umbral a propósito.
- El fee de integración solo se cobra cuando el doc ENTRA por esa integración (inconsistencia conocida display-vs-cobro en el desglose: se muestra igual).

---

## 15. Panel de Monitoreo (superadmin)

Ve TODO el sistema vía RPCs (antes las queries directas pasaban por RLS y mostraban solo la org del superadmin — bug real). Seis tarjetas: **Documentos** (hub con barras clickeables: procesos/docs/errores/trabados/cola/tipos, semáforo heredado), **Tenants** (balances, actividad mensual, toggles de flags por org, carga de saldo), **Usuarios**, **Worker** (métricas de cola/latencia/errores vía `/api/metrics`), **Precios** (todo el pricing editable), **IA** (visor del prompt read-only + cuaderno + fichas). Modal Jobs global: filtros tenant/fecha/estado, paginación de a 15, export Excel.

---

## 16. Observabilidad

- **Sentry** en el frontend (con source maps del build).
- **`metrics.mjs` :9090** → `GET /api/metrics`: queue_depth (waiting/active/delayed), latencia p50/p95/avg, error rate, totales.
- **Logs del worker**: `docker logs dl-worker` — eventos estructurados (`integration.*`, `poller.*`, `prov_profile.matched`, `file_mover.*`, `zip.extract_result`, `dlq.*`).
- **En DB**: `worker_events`, `pdf_document_audit_log`, y el propio `raw_ocr_text` por doc (debugging de extracción = comparar OCR vs campos, SIEMPRE con datos antes de tocar código).
- Health: `curl -H 'Authorization: Bearer staging-key-2026' http://localhost:3001/health`.

---

## 17. Método de trabajo y deploy (leer CLAUDE.md antes de tocar)

**Roles**: el director técnico (Sergio) decide, aprueba cambios sensibles y valida en pantalla/con documentos reales; un asistente de arquitectura (Cowork) diagnostica con datos, propone, edita código/DB y documenta; un operador (Claude Code CLI) ejecuta git/build/scp/ssh/docker con comandos exactos y verificación md5. Humanamente: **nada sensible se toca sin propuesta aprobada**.

**Ciclo de cambio obligatorio**: diagnóstico con datos (DB/`raw_ocr_text`/Redis; nunca de memoria) → propuesta y OK → cambio quirúrgico → verificación local (`node --check`/esbuild, balance, tests inline, tsc 0 nuevos) → **deploy SIN commit** → validación con reproceso real (importes comparados campo por campo en DB; en cambios de extracción, OFF/ON con los mismos docs e importes idénticos) → recién ahí commit (main=prod) → tarjeta Kanban + CLAUDE.md en el mismo cierre.

**Deploy canónico**:
```bash
# Worker — siempre build (el Dockerfile hace COPY *.mjs: sin build, el contenedor corre código viejo)
scp worker/X.mjs root@157.230.231.207:/root/worker/
ssh root@157.230.231.207 "cd /root/worker && docker compose build && docker compose up -d --force-recreate"
# Frontend — siempre SCP del build local; NUNCA git pull ni Netlify
npm run build            # si package.json cambió: npm install ANTES
ssh root@157.230.231.207 "rm -rf /var/www/dataland/assets"
scp -r dist/. root@157.230.231.207:/var/www/dataland/
```
Con handshake md5 en cada paso (local → host → dentro del contenedor). Rollback: revertir archivos + rebuild (ver `RUNBOOK-ROLLBACK.md` y `rollback.sh`).

**🔒 Zonas cerradas** (validadas en prod; NO tocar sin tarea explícita + OK; lista completa y razones en CLAUDE.md): Auth/carga del frontend · Billing/MercadoPago · **TODAS las integraciones** (OAuth, credenciales, pollers, file-mover, salidas) · el pipeline del worker · Realtime (canales) · RLS/RPCs de seguridad · deploy/Caddy. El **prompt de extracción** solo se adapta de forma aditiva con OK. Regla asociada: los workarounds no se eliminan sin validar la solución definitiva.

---

## 18. Decisiones arquitectónicas (Decisions Log en Notion)

| Decisión | Resumen |
|---|---|
| DEC-007 + DEC-017 | DB vs worker: procesamiento/lógica compleja → worker; derivación determinística sobre una fila (clasificación, conteos) → aceptable en trigger. Migrar al worker solo al cruzar gatillos (deps externas, CPU>70%, p95 degradada, millones de filas) |
| DEC-011 | n8n ELIMINADO del pipeline (fue el orquestador original; no existe más, no referenciar) |
| DEC-018 | Regionalización multi-país = épico futuro; hoy solo AR. `document_types.country` ya existe como dimensión |
| DEC-019 | Dedup de entrada RETIRADO: la garantía es que el archivo salga de la raíz; el guard de saldo completa el contrato con el camino inverso |
| Visión arq B | La visión multimodal va en llamada AISLADA que solo puede corregir `tipo_documento`; la variante híbrida (imagen en la llamada de extracción) se descartó con test OFF/ON porque MOVÍA IMPORTES |
| Umbral $1 | El mínimo de procesamiento es fijo y está alineado en gateway + pollers + sidebar; cambiar el criterio (p. ej. costo real por tenant) = cambiar TODOS los lados a la vez |

**Roadmap de escalado** (visión): workers distribuidos y procesamiento paralelo sobre la base BullMQ/Redis ya montada; few-shot/fine-tuning cuando el cuaderno tenga volumen; regionalización multi-país; billing por créditos ya operativo. El tablero vivo está en Notion (Kanban 1 histórico + Kanban Parte 2 activo).

---

## 19. Frontend visual / marca (referencia rápida)

Identidad en `BRAND-GUIDELINE-AGORA.docx`: **rojo Agora `#FF3131` = color de MARCA** (logo + navegación — no confundir con el verde de éxito), neutros blanco/crema/negro, acentos amarillo `#FED210` / violeta `#A347D1` / verde `#22C365`, el resto son funcionales de badges. Tipografías: **Inter** (UI), **Lora** (números de métricas), **Sugar Pie** (display, servida como woff2). Principio: paleta corta.

---

## 20. Estado y números reales (2026-08-11)

- ~813 procesos / ~824 documentos / ~2.284 renglones extraídos / ~1.224 movimientos de crédito en la DB.
- Menara (cliente real): ~650 procesos desde el 20/07, picos de 75-80/día, integración Supabase Storage 1 min.
- Deuda conocida y trackeada: 13 vulnerabilidades npm preexistentes (housekeeping), baseline tsc de 4 errores de tipos (IntegracionesPage ×3, Onboarding), verificación OAuth de Google diferida (GTM-06, materiales listos), worker single-node (escalar a workers distribuidos es el próximo gran paso del roadmap).
- Watch-points activos y validaciones pendientes: tarjeta «SEGUIMIENTO» en Kanban Parte 2.

## 21. Por dónde empezar (sugerencia de lectura de código)

1. `CLAUDE.md` completo (zonas cerradas + decisiones + historial).
2. Seguir UNA factura: `gateway.mjs:handleEnqueue` → `worker.mjs` → `document-processor.mjs` (SYSTEM_PROMPT + `processDocument`) → `post-processor.mjs` → `output-depositor.mjs`.
3. El contrato de integraciones: `poller-handoff.mjs` → `supabase-storage-poller.mjs` (el más simple) → `integration-file-mover.mjs`.
4. En la DB: `pdf_jobs`/`pdf_job_rows` + el trigger `classify_pdf_job_row` + correr su harness.
5. En el front: `AuthContext.tsx` (leer los comentarios), `useClientJobs.ts` (el patrón de paginación+Realtime), `MonitoringPage.tsx` (el panel admin).
