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

const SYSTEM_PROMPT = `Eres Extractor de comprobantes argentinos. Devolvé SOLO JSON válido, sin texto extra.
REGLAS: fecha en DD-MM-YYYY, importes como número (punto decimal), null si no encontrás el dato, confidence_score siempre número 0-1.
EMISOR vs RECEPTOR — REGLA FUNDAMENTAL:
- EMISOR = proveedor que emite la factura. SIEMPRE está en el ENCABEZADO (parte superior). emisor_cuit = CUIT del encabezado.
- RECEPTOR = empresa que recibe y paga. Identificado por etiquetas EXPLÍCITAS: "Señor/es:", "Sr.:", "Cliente:", "A:", "Destinatario:", "Razón Social del cliente:".
- ANCLA DE RECEPTOR: si el prompt incluye CUIT o nombre de referencia, ese dato ES el receptor con certeza absoluta.
- PROHIBIDO: nunca cruces emisor y receptor.
TIPO_DOCUMENTO: FACTURA_A/B/C/M, NOTA_DEBITO_A/B/C, NOTA_CREDITO_A/B/C, ORDEN_COMPRA, SOLICITUD_COTIZACION, null.
CODIGO_AFIP: código numérico que aparece debajo de la letra del comprobante (A/B/C) en el recuadro central del encabezado. Ejemplos: "01"=Factura A, "02"=Nota Débito A, "03"=Nota Crédito A, "06"=Factura B, "07"=Nota Débito B, "08"=Nota Crédito B, "11"=Factura C, "12"=Nota Débito C, "13"=Nota Crédito C, "51"=Factura M. Devolver como string con ceros a la izquierda (ej: "01").
PUNTO_VENTA: 4 dígitos antes del guión en el número de comprobante (ej: de "0003-00001234" → "0003"). Si no surge del número buscarlo en el encabezado.
NUMERO_COMPROBANTE: string completo con punto de venta (ej: "0001-00001234").
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
DATOS PARCIALES: completá lo que encontrás, null el resto. Bajá confidence_score si faltan campos clave.
ESTRUCTURA EXACTA:
{"fecha":null,"moneda":"ARS","es_moneda_ars":true,"es_moneda_usd":false,"tipo_documento":null,"codigo_afip":null,"punto_venta":null,"numero_comprobante":null,"emisor_nombre":null,"emisor_cuit":null,"condicion_iva_emisor":null,"receptor_nombre":null,"receptor_cuit":null,"condicion_iva_receptor":null,"cliente":null,"neto_gravado":null,"monto_exento":null,"iva_21":null,"iva_105":null,"iva_27":null,"iva_5":null,"iva_25":null,"iva":null,"percepcion_ingresos_brutos":null,"percepcion_iva":null,"impuestos_internos":null,"total":null,"nro_cae":null,"fecha_vto_cae":null,"documento_relacionado":null,"orden_compra":[],"confidence_score":0.95}`;

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

  const payload = {
    org_id:                    orgId,
    job_id:                    jobId,
    source_file:               sourceFile                       ?? null,
    fecha:                     toIsoDate(extracted.fecha),
    moneda:                    extracted.moneda                 ?? 'ARS',
    es_moneda_ars:             extracted.es_moneda_ars          ?? true,
    es_moneda_usd:             extracted.es_moneda_usd          ?? false,
    tipo_documento:            extracted.tipo_documento          ?? null,
    codigo_afip:               extracted.codigo_afip             ?? null,
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
