/**
 * document-processor.mjs — DEC-011
 * OCR (Mistral) + Extracción (OpenAI GPT-4.1-mini) directo en el Worker.
 * Procesamiento de documentos en el Worker (DEC-011: N8N eliminado).
 *
 * Data Laundering V2.0 — v1.1.0
 *
 * Input:  { job_id, organization_id, file_url, file_type, original_filename,
 *            client_cuit, client_name, oc_entries, input_source }
 * Output: { success, row_id, confidence_score, tipo_documento,
 *            numero_comprobante, total }
 */

const MISTRAL_API_KEY      = process.env.MISTRAL_API_KEY;
const OPENAI_API_KEY       = process.env.OPENAI_API_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_KEY         = process.env.SUPABASE_SERVICE_KEY;
const WORKER_VERSION       = process.env.WORKER_VERSION ?? '1.1.0';

const MISTRAL_OCR_MODEL    = 'mistral-ocr-latest';
const OPENAI_EXTRACT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function supabaseHeaders(prefer = 'return=representation') {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer':        prefer,
  };
}

/**
 * Convierte DD-MM-YYYY → YYYY-MM-DD para PostgreSQL.
 * Retorna null si el formato no coincide.
 */
function toIsoDate(ddmmyyyy) {
  if (!ddmmyyyy) return null;
  const m = String(ddmmyyyy).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Devuelve el CORRELATIVO del comprobante: lo de después del último "-".
 *  "0004-A00004-00012150" -> "00012150"; "0004-00012216" -> "00012216"; sin "-" -> tal cual.
 *  La sucursal se conserva aparte en punto_venta. */
function correlativoDe(numero) {
  if (numero == null) return null;
  const s = String(numero).trim();
  if (!s) return null;
  const last = s.split('-').pop().trim();
  return last || s;
}

/** Coacciona a número (acepta number o string es/en: "30,0", "2.948,84", "2948.84"). null si no parsea. */
function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v).trim().replace(/\s/g, '');
  const n = t.includes(',') ? parseFloat(t.replace(/\./g, '').replace(',', '.')) : parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// ─── Mapa codigo_afip por tipo de comprobante (document_types, cacheado) ──────
// codigo_afip pasa a ser atributo del tipo en DB; lo deriva el worker, no la IA.
let _afipCodeMap   = null;
let _afipCodeMapAt = 0;
const AFIP_MAP_TTL_MS = 10 * 60 * 1000; // 10 min

async function getAfipCodeMap(log) {
  const now = Date.now();
  if (_afipCodeMap && (now - _afipCodeMapAt) < AFIP_MAP_TTL_MS) return _afipCodeMap;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/document_types?select=code,codigo_afip&active=eq.true`, // solo tipos activos (no el catálogo)
      { headers: supabaseHeaders('return=representation') },
    );
    if (!res.ok) throw new Error(`document_types ${res.status}`);
    const rows = await res.json();
    const map = {};
    for (const r of rows) if (r?.code) map[r.code] = r.codigo_afip ?? null;
    _afipCodeMap   = map;
    _afipCodeMapAt = now;
    return map;
  } catch (e) {
    if (log) log('warn', 'afip_map.fetch_failed', { error: String(e?.message ?? e) });
    return _afipCodeMap ?? {}; // fallback: cache previo o vacío (codigo_afip -> null)
  }
}

// ─── Guardrail: corregir la VARIANTE del tipo con el código AFIP impreso ──────
// Cuando el documento imprime "Cód./Código Nº: NN" y ese NN es un código AFIP
// válido (existe en document_types), lo usamos para corregir la variante A/B/C/M
// que a veces la IA elige mal. Solo corrige dentro de la MISMA clase
// (Factura/NC/ND) o cuando la IA no dio una variante válida. Descarta números
// que no son códigos AFIP (ej. "Código: 464" = código de cliente).
function claseDeTipo(t) {
  if (!t) return null;
  if (t.startsWith('FACTURA'))      return 'FACTURA';
  if (t.startsWith('NOTA_CREDITO')) return 'NOTA_CREDITO';
  if (t.startsWith('NOTA_DEBITO'))  return 'NOTA_DEBITO';
  return null;
}

export function correctTipoByPrintedCode(tipo, ocrText, afipMap, log) {
  if (!ocrText || !afipMap) return tipo;
  // reverse: codigo_afip -> tipo (ej. "03" -> "NOTA_CREDITO_A")
  const rev = {};
  for (const [t, c] of Object.entries(afipMap)) if (c) rev[String(c)] = t;

  const re = /c[oó]d(?:igo)?\.?\s*(?:n[ºo°]?)?\s*:?\s*(\d{1,3})/gi;
  const found = new Set();
  let m;
  while ((m = re.exec(ocrText)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n)) continue;
    const norm = n < 10 ? '0' + n : String(n); // 002->02, 3->03, 011->11, 051->51
    if (rev[norm]) found.add(norm);            // solo códigos AFIP reales (descarta 464)
  }
  if (found.size === 0) return tipo;

  const claseLLM = claseDeTipo(tipo);
  let chosen = null;
  if (claseLLM) {
    const matching = [...found].filter(c => claseDeTipo(rev[c]) === claseLLM);
    if (matching.length === 1) chosen = matching[0]; // misma clase, corrige variante
  } else if (found.size === 1) {
    chosen = [...found][0]; // la IA no dio variante válida y hay un único código
  }
  if (!chosen) return tipo;

  const tipoDelCodigo = rev[chosen];
  if (tipoDelCodigo && tipoDelCodigo !== tipo) {
    if (log) log('info', 'tipo.corrected_by_code', { from: tipo, to: tipoDelCodigo, codigo: chosen });
    return tipoDelCodigo;
  }
  return tipo;
}

// ─── 1. OCR via Mistral ───────────────────────────────────────────────────────

/**
 * Llama a la API de Mistral OCR y retorna el texto extraído en markdown.
 * PDFs → document_url; imágenes → image_url.
 */
async function runMistralOCR(fileUrl, fileType, log) {
  const isImage = ['jpg', 'jpeg', 'png'].includes(fileType.toLowerCase());

  const document = isImage
    ? { type: 'image_url',    image_url:    { url: fileUrl } }
    : { type: 'document_url', document_url: fileUrl };

  if (log) log('info', 'ocr.start', { file_type: fileType, model: MISTRAL_OCR_MODEL, url: fileUrl });

  const res = await fetch('https://api.mistral.ai/v1/ocr', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${MISTRAL_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ model: MISTRAL_OCR_MODEL, document }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Mistral OCR failed (${res.status}): ${errText}`);
  }

  const data  = await res.json();
  const text  = (data.pages ?? []).map(p => p.markdown ?? '').join('\n\n');
  const model = data.model ?? MISTRAL_OCR_MODEL;

  if (log) log('info', 'ocr.done', {
    model,
    pages:  data.pages?.length ?? 0,
    chars:  text.length,
    usage:  data.usage_info,
  });

  return { text, model };
}

// ─── 2. Extracción via OpenAI ─────────────────────────────────────────────────

export const SYSTEM_PROMPT = `Sos un analista de comprobantes fiscales argentinos. Tu trabajo NO es copiar texto suelto: es INTERPRETAR el documento para identificar correctamente cada dato, en especial el TIPO de comprobante (letra + clase). Razoná internamente y devolvé SOLO JSON válido, sin texto extra ni explicaciones.
REGLAS: fecha en DD-MM-YYYY, importes como número (punto decimal), null si no encontrás el dato, confidence_score siempre número 0-1.
EMISOR vs RECEPTOR — REGLA FUNDAMENTAL:
- EMISOR = proveedor que emite la factura. SIEMPRE está en el ENCABEZADO (parte superior). emisor_cuit = CUIT del encabezado.
- RECEPTOR = empresa que recibe y paga. Identificado por etiquetas EXPLÍCITAS: "Señor/es:", "Sr.:", "Cliente:", "A:", "Destinatario:", "Razón Social del cliente:".
- ANCLA DE RECEPTOR: si el prompt incluye CUIT o nombre de referencia, ese dato ES el receptor con certeza absoluta.
- PROHIBIDO: nunca cruces emisor y receptor.
TIPO_DOCUMENTO — primero identificá la CLASE (FACTURA / NOTA DE CRÉDITO / NOTA DE DÉBITO), que casi siempre está escrita arriba (centro o derecha): "FACTURA" → FACTURA; "NOTA DE CRÉDITO"/"N. DE CRÉDITO"/"NOTA CREDITO" → NOTA_CREDITO; "NOTA DE DÉBITO"/"N. DE DÉBITO"/"NOTA DEBITO" → NOTA_DEBITO. Después determiná la VARIANTE (A/B/C/M) en este ORDEN de prioridad:
  NIVEL 1 — LETRA: si hay una LETRA GRANDE aislada (A, B, C o M) en el recuadro del encabezado (arriba al centro), esa letra manda. Ignorá números cercanos.
  NIVEL 2 — CÓDIGO IMPRESO: si NO hay letra clara pero hay un "Cod. NN"/"Código NN" en el encabezado (ej. "Cod. 002"), traducílo a la variante con esta tabla — Facturas: 01=A, 06=B, 11=C, 51=M · Notas de débito: 02=A, 07=B, 12=C · Notas de crédito: 03=A, 08=B, 13=C.
  NIVEL 3 — INFERENCIA FISCAL (sólo si NO hay letra NI código en el texto): deducí la variante por la situación de IVA: emisor "Responsable Monotributo"/Monotributo → C; emisor "Responsable Inscripto" con IVA discriminado (hay renglón "IVA 21%/10,5%/..." o el receptor es Responsable Inscripto) → A; emisor "Responsable Inscripto" con IVA NO discriminado (precio final con IVA incluido, o receptor Consumidor Final/Monotributo) → B.
  Combiná CLASE + VARIANTE: FACTURA + A = FACTURA_A; NOTA DE CRÉDITO + C = NOTA_CREDITO_C.
  NUNCA devuelvas la clase sin variante (ej. "FACTURA" suelto es inválido). Si tras los 3 niveles no podés determinar la variante, devolvé null.
  PROHIBIDO decidir el tipo con el número de COMPROBANTE ("3 - 00002831" = punto de venta + correlativo), códigos de producto, o cualquier dígito suelto.
  ORDEN DE COMPRA / SOLICITUD DE COTIZACIÓN → ORDEN_COMPRA / SOLICITUD_COTIZACION.
  Valores válidos: FACTURA_A/B/C/M, NOTA_DEBITO_A/B/C, NOTA_CREDITO_A/B/C, ORDEN_COMPRA, SOLICITUD_COTIZACION, null.
CODIGO_AFIP: devolvé SIEMPRE null. NO lo extraigas del documento. El sistema lo completa derivándolo de tipo_documento contra la tabla oficial. Jamás tomes un dígito del comprobante (el "3" de "3 - 00002831") como código.
PUNTO_VENTA: el punto de venta antes del guión del comprobante. Puede venir SIN ceros a la izquierda (ej. "3 - 00002831"); normalizalo SIEMPRE a 4 dígitos → "0003". Si no surge del número buscarlo en el encabezado.
NUMERO_COMPROBANTE: string completo con punto de venta normalizado a 4 dígitos (ej: "0003-00002831").
MONEDA: "USD" si aparece USD/U$S/DÓLARES, si no "ARS". es_moneda_ars/es_moneda_usd = boolean.
CONDICIÓN IVA: buscar junto al CUIT del emisor y del receptor. Valores posibles: "IVA Responsable Inscripto", "IVA Responsable No Inscripto", "IVA No Responsable", "IVA Sujeto Exento", "Consumidor Final", "Responsable Monotributo", "Proveedor del Exterior", "Cliente del Exterior", null.
IMPORTES — extraer todos los que aparezcan:
- neto_gravado: "Neto Gravado" / "Base imponible" / "Gravado X%"
- monto_exento: "Exento" / "No Gravado" / "Monto Exento"
- iva_21: monto correspondiente a IVA 21%
- iva_105: monto correspondiente a IVA 10,5%
- iva_27: monto correspondiente a IVA 27%
- iva_5: monto correspondiente a IVA 5%
- iva_25: monto correspondiente a IVA 2,5%
- iva: suma total de todos los IVA (o monto global si no está discriminado)
- percepcion_ingresos_brutos: "Percepción IIBB" / "Perc. Ing. Brutos"
- percepcion_iva: "Percepción IVA"
- impuestos_internos: "Impuestos Internos" / "Imp. Internos" (común en combustibles, tabacos)
- total: importe final "Total" / "TOTAL A PAGAR"
CAE — al pie de la factura:
- nro_cae: número de 14 dígitos. Buscar "CAE N°:", "CAE:", "Código de Autorización".
- fecha_vto_cae: fecha de vencimiento. Buscar "Fecha de Vto. de C.A.E.", "Vto. CAE". Formato DD-MM-YYYY.
documento_relacionado: OC/remito mencionado como string breve, null si no hay.
orden_compra: array con TODOS los números de OC. Si hay sección "[ADJUNTOS OC CONFIRMADAS: X, Y]", incluir SIEMPRE esos números. Usar [] si no hay.
DETALLE DE RENGLONES (items): array con CADA renglón de producto/servicio del cuerpo del comprobante, en orden. Por renglón: {"descripcion": texto del producto/servicio, "cantidad": número o null, "precio_unitario": número o null, "importe": subtotal del renglón número o null}. Sacá descripción + cantidad + al menos un precio (unitario y/o importe); si falta uno, null (se calcula después). NO incluyas subtotales/totales generales ni líneas que no sean productos. [] si no hay renglones.
DATOS PARCIALES: completá lo que encontrás, null el resto. Bajá confidence_score si faltan campos clave.
ESTRUCTURA EXACTA:
{"fecha":null,"moneda":"ARS","es_moneda_ars":true,"es_moneda_usd":false,"tipo_documento":null,"codigo_afip":null,"punto_venta":null,"numero_comprobante":null,"emisor_nombre":null,"emisor_cuit":null,"condicion_iva_emisor":null,"receptor_nombre":null,"receptor_cuit":null,"condicion_iva_receptor":null,"cliente":null,"neto_gravado":null,"monto_exento":null,"iva_21":null,"iva_105":null,"iva_27":null,"iva_5":null,"iva_25":null,"iva":null,"percepcion_ingresos_brutos":null,"percepcion_iva":null,"impuestos_internos":null,"total":null,"nro_cae":null,"fecha_vto_cae":null,"documento_relacionado":null,"orden_compra":[],"items":[],"confidence_score":0.95}`;

/**
 * Construye el user message con el ancla de receptor + texto OCR + OCs confirmadas,
 * y llama a OpenAI para extraer los campos de la factura.
 */
async function extractWithOpenAI(ocrText, { clientCuit, clientName, ocEntries }, log) {
  // Ancla de receptor (reduce confusión emisor/receptor)
  const parts = [];
  if (clientCuit || clientName) {
    parts.push(`CUIT receptor de referencia: ${clientCuit ?? ''}${clientName ? ` (${clientName})` : ''}`);
    parts.push('');
  }
  parts.push(ocrText);

  // OCs confirmadas desde adjuntos del ZIP
  if (ocEntries && ocEntries.length > 0) {
    const nums = ocEntries.map(e => e.numero_oc).join(', ');
    parts.push('');
    parts.push(`[ADJUNTOS OC CONFIRMADAS: ${nums}]`);
  }

  const userContent = parts.join('\n');

  if (log) log('info', 'ai.start', {
    model:     OPENAI_EXTRACT_MODEL,
    ocr_chars: ocrText.length,
    oc_count:  ocEntries?.length ?? 0,
  });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:           OPENAI_EXTRACT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userContent   },
      ],
      temperature:     0,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI extraction failed (${res.status}): ${errText}`);
  }

  const data  = await res.json();
  const raw   = data.choices?.[0]?.message?.content ?? '{}';
  const model = data.model ?? OPENAI_EXTRACT_MODEL;

  if (log) log('info', 'ai.done', {
    model,
    tokens: data.usage?.total_tokens,
  });

  let extracted;
  try {
    extracted = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI response not valid JSON: ${raw.slice(0, 200)}`);
  }

  return { extracted, model };
}

// ─── 3. Escritura en pdf_job_rows ─────────────────────────────────────────────

async function insertJobRow(jobId, orgId, extracted, meta) {
  const { ocrModel, llmModel, sourceFile, rawOcrText, inputSource } = meta;

  // codigo_afip se deriva del tipo (tabla document_types), no de la IA.
  const afipMap = await getAfipCodeMap();
  // Corregir la variante (A/B/C) con el código AFIP impreso, si está en el OCR.
  const tipoDoc = correctTipoByPrintedCode(extracted.tipo_documento, rawOcrText, afipMap);

  const payload = {
    org_id:                    orgId,
    job_id:                    jobId,
    source_file:               sourceFile                       ?? null,
    fecha:                     toIsoDate(extracted.fecha),
    moneda:                    extracted.moneda                 ?? 'ARS',
    es_moneda_ars:             extracted.es_moneda_ars          ?? true,
    es_moneda_usd:             extracted.es_moneda_usd          ?? false,
    tipo_documento:            tipoDoc                           ?? null,
    codigo_afip:               afipMap[tipoDoc]                              ?? null,
    punto_venta:               extracted.punto_venta             ?? null,
    numero_comprobante:        extracted.numero_comprobante      ?? null,
    proveedor:                 extracted.emisor_nombre           ?? null,  // emisor → proveedor
    cuit:                      extracted.emisor_cuit             ?? null,  // emisor_cuit → cuit
    condicion_iva_emisor:      extracted.condicion_iva_emisor    ?? null,
    receptor_nombre:           extracted.receptor_nombre         ?? null,
    receptor_cuit:             extracted.receptor_cuit           ?? null,
    condicion_iva_receptor:    extracted.condicion_iva_receptor  ?? null,
    cliente:                   extracted.cliente                 ?? null,
    neto_gravado:              extracted.neto_gravado            ?? null,
    monto_exento:              extracted.monto_exento            ?? null,
    iva_21:                    extracted.iva_21                  ?? null,
    iva_105:                   extracted.iva_105                 ?? null,
    iva_27:                    extracted.iva_27                  ?? null,
    iva_5:                     extracted.iva_5                   ?? null,
    iva_25:                    extracted.iva_25                  ?? null,
    iva:                       extracted.iva                     ?? null,
    percepcion_ingresos_brutos:extracted.percepcion_ingresos_brutos ?? null,
    percepcion_iva:            extracted.percepcion_iva          ?? null,
    impuestos_internos:        extracted.impuestos_internos      ?? null,
    total:                     extracted.total                   ?? null,
    nro_cae:                   extracted.nro_cae                 ?? null,
    fecha_vto_cae:             toIsoDate(extracted.fecha_vto_cae),
    documento_relacionado:     extracted.documento_relacionado   ?? null,
    // orden_compra: array → string separado por comas (columna text)
    orden_compra:              Array.isArray(extracted.orden_compra) && extracted.orden_compra.length > 0
                                 ? extracted.orden_compra.join(',')
                                 : null,
    confidence_score:          extracted.confidence_score        ?? null,
    ocr_model:                 ocrModel                          ?? null,
    llm_model:                 llmModel                          ?? null,
    processed_at:              new Date().toISOString(),
    raw_ocr_text:              rawOcrText                        ?? null,
    doc_status:                'ok',
    incompleto:                !extracted.total && !extracted.numero_comprobante,
    ia_extra:                  { input_source: inputSource ?? 'worker', worker_version: WORKER_VERSION },
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/pdf_job_rows`, {
    method:  'POST',
    headers: supabaseHeaders('return=representation'),
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`pdf_job_rows insert failed (${res.status}): ${errText}`);
  }

  const rows = await res.json();
  const rowId = rows[0]?.id;
  if (!rowId) throw new Error('pdf_job_rows insert returned no id');
  return rowId;
}

// ─── 4. Escritura en pdf_job_row_oc ──────────────────────────────────────────

/**
 * Inserta las OC entries (extraídas del ZIP por zip-processor) en pdf_job_row_oc.
 * El row_id ya está creado en el paso anterior.
 */
async function insertOcEntries(rowId, ocEntries) {
  if (!ocEntries || ocEntries.length === 0) return 0;

  const rows = ocEntries.map(oc => ({
    row_id:          rowId,
    numero_oc:       String(oc.numero_oc),
    nombre_adjunto:  oc.nombre_adjunto  ?? null,
    codigo_obra:     oc.codigo_obra     ?? null,
  }));

  const res = await fetch(`${SUPABASE_URL}/rest/v1/pdf_job_row_oc`, {
    method:  'POST',
    headers: supabaseHeaders('return=minimal'),
    body:    JSON.stringify(rows),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`pdf_job_row_oc insert failed (${res.status}): ${errText}`);
  }

  return rows.length;
}

// ─── 4b. Escritura de renglones (LINE-ITEMS) ─────────────────────────────────
/**
 * Inserta los renglones (producto/cantidad/precio) en pdf_job_row_items. Best-effort:
 * un fallo acá NO rompe el job (el detalle es dato accesorio). Extracción SIEMPRE.
 */
async function insertItems(rowId, orgId, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const rows = items.map((it, i) => ({
    row_id:          rowId,
    organization_id: orgId,
    descripcion:     it?.descripcion ?? null,
    cantidad:        toNum(it?.cantidad),
    precio_unitario: toNum(it?.precio_unitario),
    importe:         toNum(it?.importe),
    orden:           i + 1,
  }));
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pdf_job_row_items`, {
      method:  'POST',
      headers: supabaseHeaders('return=minimal'),
      body:    JSON.stringify(rows),
    });
    if (!res.ok) return 0;
    return rows.length;
  } catch {
    return 0;
  }
}

// ─── Export principal ─────────────────────────────────────────────────────────

/**
 * Procesa un documento individual.
 *
 * Retorna: { success, row_id, confidence_score, tipo_documento, numero_comprobante, total }
 */
export async function processDocument(docData, log) {
  const {
    job_id,
    organization_id,
    file_url,
    file_type,
    original_filename,
    client_cuit   = null,
    client_name   = null,
    oc_entries    = [],
    input_source  = 'worker',
  } = docData;

  // ── 1. OCR ────────────────────────────────────────────────────────────────
  const { text: ocrText, model: ocrModel } = await runMistralOCR(
    file_url, file_type, log
  );

  // ── 2. Extracción IA ──────────────────────────────────────────────────────
  const { extracted, model: llmModel } = await extractWithOpenAI(
    ocrText,
    { clientCuit: client_cuit, clientName: client_name, ocEntries: oc_entries },
    log
  );

  // Normalizar numero_comprobante al CORRELATIVO (lo de después del último "-").
  // La sucursal queda en punto_venta; nombre/duplicados reconstruyen punto_venta-correlativo.
  extracted.numero_comprobante = correlativoDe(extracted.numero_comprobante);

  // ── 3. Escribir fila en pdf_job_rows ──────────────────────────────────────
  const rowId = await insertJobRow(job_id, organization_id, extracted, {
    ocrModel,
    llmModel,
    sourceFile:  original_filename,
    rawOcrText:  ocrText,
    inputSource: input_source,
  });

  if (log) log('info', 'doc.processed', {
    job_id,
    row_id:     rowId,
    file:       original_filename,
    tipo:       extracted.tipo_documento,
    comprobante:extracted.numero_comprobante,
    total:      extracted.total,
    confidence: extracted.confidence_score,
    ocr_model:  ocrModel,
    llm_model:  llmModel,
  });

  // ── 4. Escribir OC entries en pdf_job_row_oc ──────────────────────────────
  const ocCount = await insertOcEntries(rowId, oc_entries);

  // ── 4b. Renglones (LINE-ITEMS): extracción SIEMPRE (dato propio); entrega/cobro se gatean aparte
  const itemCount = await insertItems(rowId, organization_id, extracted.items);
  if (log && itemCount > 0) log('info', 'doc.items_inserted', { job_id, row_id: rowId, items: itemCount });

  if (log && ocCount > 0) log('info', 'doc.oc_inserted', {
    job_id,
    row_id:   rowId,
    oc_count: ocCount,
    oc_nums:  oc_entries.map(e => e.numero_oc),
  });

  return {
    success:            true,
    row_id:             rowId,
    confidence_score:   extracted.confidence_score   ?? null,
    tipo_documento:     extracted.tipo_documento      ?? null,
    numero_comprobante: extracted.numero_comprobante  ?? null,
    total:              extracted.total               ?? null,
  };
}
