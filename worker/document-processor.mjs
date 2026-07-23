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

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

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

/** Normaliza el punto de venta a numerico con 4 digitos ("39" -> "0039"). null si no hay digitos. */
export function normalizePuntoVenta(pv) {
  if (pv == null) return null;
  const d = String(pv).replace(/\D/g, '');
  if (!d) return null;
  return d.length >= 4 ? d : d.padStart(4, '0');
}

/**
 * Descompone el comprobante en { puntoVenta, correlativo } segun formato AFIP:
 * punto de venta NUMERICO (4-5 digitos) + correlativo de 8 digitos ("PPPP-NNNNNNNN").
 * La LETRA (A/B/C/M/E) es la CLASE del comprobante -> ya va en tipo_documento/codigo_afip;
 * NO es punto de venta, se descarta de estos campos.
 *   "0004-00012216"       -> { 0004, 00012216 }
 *   "003900075132"        -> { 0039, 00075132 }  (12 digitos PEGADOS, sin separador)
 *   "A0039-00075132"      -> { 0039, 00075132 }
 *   "A 0039 00075132"     -> { 0039, 00075132 }
 *   "0004-A00004-00012150"-> { 0004, 00012150 }
 *   "0003-003900075132"   -> { 0039, 00075132 }  (PV suelto + ultimo bloque PEGADO: gana el pegado)
 *   "00012150"            -> { null, 00012150 }  (solo correlativo; el PV lo aporta el modelo)
 */
export function splitComprobante(numero) {
  const vacio = { puntoVenta: null, correlativo: null };
  if (numero == null) return vacio;
  const grupos = String(numero).match(/\d+/g);   // bloques de digitos; ignora letras y separadores
  if (!grupos || grupos.length === 0) return vacio;

  // El ULTIMO bloque es el que manda: si viene PEGADO (>8 dig = PV+correlativo), se recorta.
  // Los ultimos 8 son el correlativo y su prefijo es el PV, que le gana a cualquier PV suelto
  // que haya emitido el modelo (suele ser un misread, ej. "0003-003900075132" -> PV real 0039).
  const ultimo = grupos[grupos.length - 1];
  if (ultimo.length > 8) {
    return { puntoVenta: normalizePuntoVenta(ultimo.slice(0, -8)), correlativo: ultimo.slice(-8) };
  }

  // El ultimo bloque ya es el correlativo (<=8 dig).
  if (grupos.length >= 2) {
    return { puntoVenta: normalizePuntoVenta(grupos[0]), correlativo: ultimo };
  }
  // Un solo bloque <=8 -> solo correlativo; el punto de venta lo aporta el modelo (del encabezado).
  return { puntoVenta: null, correlativo: ultimo };
}

/**
 * Recupera el PUNTO DE VENTA del texto OCR (fuente de verdad de lo impreso), anclando en el
 * correlativo que el modelo saca bien. Busca en el OCR un bloque contiguo de digitos que TERMINE
 * exactamente en el correlativo (8 dig) y tenga 4-5 digitos de PV adelante (formato AFIP pegado,
 * ej. impreso "A003900076104" -> PV 0039). Solo dispara si encuentra ese patron exacto -> no
 * puede romper otros casos (facturas con separador "0004-00012216" no matchean el pegado).
 * Devuelve el PV normalizado a 4 dig, o null si no lo encuentra con confianza.
 */
export function puntoVentaFromOcr(ocrText, correlativo) {
  if (!ocrText || !correlativo) return null;
  const corr = String(correlativo).replace(/\D/g, '');
  if (corr.length !== 8) return null;                 // solo anclamos con correlativo de 8 digitos
  const re = new RegExp('(?<!\\d)(\\d{4,5})' + corr + '(?!\\d)');
  const m = re.exec(String(ocrText));
  return m ? normalizePuntoVenta(m[1]) : null;
}

/**
 * Extrae el COMPROBANTE IMPRESO directamente del texto OCR (fuente de verdad). El modelo a veces
 * transpone digitos o toma un PV suelto del cuerpo (ej. "Ing. Brutos: 0000" -> PV 0000). Busca dos
 * formatos AFIP inequivocos: (1) clase A/B/C/M/E + 12-13 digitos pegados ("A000200040110");
 * (2) punto de venta + correlativo con separador ("0019-00015207"). Devuelve el token crudo (para
 * splitComprobante) o null si no hay patron claro (ahi manda el modelo). No matchea CUIT
 * (30-8dig-1, lleva 2 digitos antes del guion) ni CAE (14 digitos).
 */
export function comprobanteFromOcr(ocrText) {
  if (!ocrText) return null;
  const s = String(ocrText);
  let m = s.match(/(?:^|[^A-Za-z0-9])[ABCMEabcme][ ]?(\d{12,13})(?!\d)/);
  if (m) return m[1];
  m = s.match(/(?:^|[^\d])(\d{4,5}-\d{8})(?!\d)/);
  if (m) return m[1];
  return null;
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

// ─── VISION: deteccion AISLADA del tipo (TASK-139, arquitectura B) ───────────
// La imagen se usa SOLO para leer la letra A/B/C/M del recuadro (lo que el OCR de
// texto pierde). La extraccion de importes/CUIT/etc queda en su llamada de texto
// INTACTA -> la imagen no puede correr ningun importe (a diferencia de la hibrida).
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL ?? 'gpt-4.1-mini';

// Render con PyMuPDF (fitz) — mismo motor que zip-processor. NO pdftoppm: en Alpine
// sin fuentes omite el texto -> PNG en blanco -> el modelo ve un form vacio.
const FITZ_RENDER = 'import fitz,sys\npix=fitz.open(sys.argv[1])[0].get_pixmap(dpi=int(sys.argv[3]))\npix.save(sys.argv[2])';

const VALID_TIPOS = new Set([
  'FACTURA_A','FACTURA_B','FACTURA_C','FACTURA_M',
  'NOTA_DEBITO_A','NOTA_DEBITO_B','NOTA_DEBITO_C',
  'NOTA_CREDITO_A','NOTA_CREDITO_B','NOTA_CREDITO_C',
  'ORDEN_COMPRA','SOLICITUD_COTIZACION',
]);

const VISION_TIPO_SYSTEM = 'Sos un analista de comprobantes fiscales argentinos. Mira la IMAGEN del documento e identifica SOLO el TIPO de comprobante. La LETRA grande (A/B/C/M) suele estar arriba al centro en un recuadro; tambien puede haber "Cod. NN". Devolve SOLO JSON: {"tipo_documento":"FACTURA_A|FACTURA_B|FACTURA_C|FACTURA_M|NOTA_CREDITO_A|NOTA_CREDITO_B|NOTA_CREDITO_C|NOTA_DEBITO_A|NOTA_DEBITO_B|NOTA_DEBITO_C|ORDEN_COMPRA|SOLICITUD_COTIZACION|null","letra":"A|B|C|M|null","visto_en":"letra|codigo|texto"}. No expliques nada.';

/**
 * Devuelve una URL de imagen para el canal visual, o null si no se pudo.
 * Imagen (jpg/jpeg/png): se pasa la propia URL. PDF: descarga + render 1a pagina
 * con PyMuPDF -> data URL base64. NUNCA lanza: ante cualquier error devuelve null.
 */
async function renderFirstPageDataUrl(fileUrl, fileType, log) {
  const ft = String(fileType || '').toLowerCase();
  if (['jpg', 'jpeg', 'png'].includes(ft)) return fileUrl;
  if (ft !== 'pdf') return null;
  const base   = `/tmp/vision_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpPdf = `${base}.pdf`;
  const tmpPng = `${base}.png`;
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`download ${res.status}`);
    writeFileSync(tmpPdf, Buffer.from(await res.arrayBuffer()));
    execFileSync('python3', ['-c', FITZ_RENDER, tmpPdf, tmpPng, '150']);
    if (!existsSync(tmpPng)) throw new Error('PyMuPDF no genero PNG');
    const b64 = readFileSync(tmpPng).toString('base64');
    return `data:image/png;base64,${b64}`;
  } catch (e) {
    if (log) log('warn', 'vision.render_failed', { error: String(e?.message ?? e) });
    return null;
  } finally {
    rmSync(tmpPdf, { force: true });
    rmSync(tmpPng, { force: true });
  }
}

/**
 * Llamada de vision AISLADA: mira la imagen y devuelve SOLO el tipo_documento
 * (string valido) o null. No toca ningun otro campo. NUNCA lanza.
 */
async function detectTipoWithVision(imageDataUrl, log) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:           OPENAI_VISION_MODEL,
        messages: [
          { role: 'system', content: VISION_TIPO_SYSTEM },
          { role: 'user',   content: [
            { type: 'text',      text: 'Identifica el tipo de comprobante de esta imagen.' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ] },
        ],
        temperature:     0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 150)}`);
    const data = await res.json();
    const raw  = data.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw);
    const tipo = parsed?.tipo_documento ?? null;
    if (log) log('info', 'vision.tipo', { tipo, letra: parsed?.letra ?? null, visto_en: parsed?.visto_en ?? null, model: data.model ?? OPENAI_VISION_MODEL });
    return tipo || null;
  } catch (e) {
    if (log) log('warn', 'vision.tipo_failed', { error: String(e?.message ?? e) });
    return null;
  }
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
COMPROBANTE PEGADO (sin guión): a veces el número se imprime como una sola tira larga de dígitos, a veces con la letra de clase adelante (ej. "A003900076104"). Regla AFIP: los ÚLTIMOS 8 dígitos son el correlativo y los 4-5 dígitos anteriores son el PUNTO DE VENTA (en "003900076104" → punto_venta "0039", correlativo "00076104"). La letra inicial (A/B/C/M/E) es la CLASE del comprobante, NO forma parte del número. En ese caso devolvé numero_comprobante CON el punto de venta incluido (ej. "0039-00076104") y punto_venta "0039". PROHIBIDO tomar como punto de venta un número suelto del cuerpo (vendedor "Vend: 66", "Codigo", nº interno, etc.); el punto de venta SIEMPRE sale del propio número de comprobante impreso.
MONEDA: "USD" si aparece USD/U$S/DÓLARES, si no "ARS". es_moneda_ars/es_moneda_usd = boolean.
CONDICIÓN IVA: buscar junto al CUIT del emisor y del receptor. Valores posibles: "IVA Responsable Inscripto", "IVA Responsable No Inscripto", "IVA No Responsable", "IVA Sujeto Exento", "Consumidor Final", "Responsable Monotributo", "Proveedor del Exterior", "Cliente del Exterior", null.
REGLA GENERAL DE INTERPRETACIÓN: No copies importes únicamente por la etiqueta. Analizá la estructura de la factura y la relación entre subtotal, neto gravado, IVA, exentos, percepciones y total para identificar correctamente el significado de cada importe.
IMPORTES — interpretar los importes, no sólo copiar etiquetas:
- neto_gravado:
  1. Buscar primero un campo explícito: "Neto Gravado", "Importe Neto Gravado", "Base Imponible", "Gravado", "Gravado 21%", "Gravado 10,5%", etc.
  2. Si no existe, identificar el subtotal correspondiente únicamente a los conceptos gravados antes del IVA.
  3. Si existen importes exentos, no gravados, percepciones, impuestos internos u otros tributos, NO asumir que el subtotal o el total corresponden al neto gravado.
  4. Sólo cuando la factura contenga exclusivamente conceptos gravados y no existan otros importes adicionales, el subtotal antes del IVA puede considerarse el neto gravado.
  5. Nunca utilizar el importe TOTAL como neto gravado, salvo que el documento demuestre claramente que ambos coinciden.
  6. Si la factura aplica un DESCUENTO o BONIFICACIÓN general, el neto_gravado es la BASE GRAVADA YA CON EL DESCUENTO APLICADO (la base sobre la que se calcula el IVA), NO el subtotal bruto previo al descuento. Coherencia esperada: neto_gravado + IVA + exentos + percepciones + imp. internos = TOTAL.
- monto_exento: "Exento" / "No Gravado" / "Monto Exento"
- descuento: monto del DESCUENTO o BONIFICACIÓN general aplicado sobre el subtotal (etiquetas "Descuento", "Bonificación", "Desc.", "Bonif."). Es lo que se resta del subtotal bruto para llegar a la base gravada. null si no hay descuento.
- iva_21: monto correspondiente a IVA 21%
- iva_105: monto correspondiente a IVA 10,5%
- iva_27: monto correspondiente a IVA 27%
- iva_5: monto correspondiente a IVA 5%
- iva_25: monto correspondiente a IVA 2,5%
- iva:
  1. Si existe un campo "IVA", "IVA Total" o equivalente, usar ese valor.
  2. Si el IVA está discriminado por alícuotas (21%, 10,5%, 27%, 5%, 2,5%), calcular la suma de todas ellas.
  3. Si la factura es tipo B o C y el IVA no está discriminado, devolver null. No estimarlo matemáticamente.
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
{"fecha":null,"moneda":"ARS","es_moneda_ars":true,"es_moneda_usd":false,"tipo_documento":null,"codigo_afip":null,"punto_venta":null,"numero_comprobante":null,"emisor_nombre":null,"emisor_cuit":null,"condicion_iva_emisor":null,"receptor_nombre":null,"receptor_cuit":null,"condicion_iva_receptor":null,"cliente":null,"neto_gravado":null,"monto_exento":null,"descuento":null,"iva_21":null,"iva_105":null,"iva_27":null,"iva_5":null,"iva_25":null,"iva":null,"percepcion_ingresos_brutos":null,"percepcion_iva":null,"impuestos_internos":null,"total":null,"nro_cae":null,"fecha_vto_cae":null,"documento_relacionado":null,"orden_compra":[],"items":[],"confidence_score":0.95}`;

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
    descuento:                 extracted.descuento               ?? null,
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
    vision_enabled = false,
  } = docData;

  // ── 1. OCR ────────────────────────────────────────────────────────────────
  const { text: ocrText, model: ocrModel } = await runMistralOCR(
    file_url, file_type, log
  );

  // ── 2. Extracción IA (texto OCR) — INTACTA, produce todos los campos ────────
  const { extracted, model: llmModel } = await extractWithOpenAI(
    ocrText,
    { clientCuit: client_cuit, clientName: client_name, ocEntries: oc_entries },
    log
  );

  // ── 2b. VISION (TASK-139, arq. B): si el tenant lo tiene activo, una llamada
  // AISLADA mira la imagen y corrige SOLO tipo_documento (lee la letra que el OCR
  // pierde). Gateado + fail-safe: flag OFF o render/vision fallan -> no toca nada.
  // Los importes/CUIT/etc salen de la extraccion de texto de arriba, sin tocar.
  if (vision_enabled) {
    const imageDataUrl = await renderFirstPageDataUrl(file_url, file_type, log);
    if (imageDataUrl) {
      const visionTipo = await detectTipoWithVision(imageDataUrl, log);
      if (visionTipo && VALID_TIPOS.has(visionTipo) && visionTipo !== extracted.tipo_documento) {
        if (log) log('info', 'vision.tipo_override', { job_id, file: original_filename, from: extracted.tipo_documento, to: visionTipo });
        extracted.tipo_documento = visionTipo;
      }
    }
  }

  // Normalizar el comprobante segun AFIP: punto de venta (4 dig) + correlativo (8 dig).
  // Puede venir PEGADO ("003900075132") o con la letra de clase ("A0039-00075132"); la letra
  // es la CLASE (ya va en tipo_documento/codigo_afip), no el punto de venta.
  // El PV derivado del numero impreso le gana al que adivino el modelo; si el numero no lo trae,
  // se conserva el del modelo (normalizado a 4 digitos).
  // El COMPROBANTE IMPRESO en el OCR es la FUENTE DE VERDAD (el modelo a veces transpone digitos
  // o toma un PV suelto del cuerpo, ej. "Ing. Brutos: 0000"). Si el OCR trae un patron claro, MANDA
  // sobre el numero del modelo; si no, cae al modelo. La letra es la CLASE (ya va en tipo/codigo_afip).
  const ocrComp   = comprobanteFromOcr(ocrText);
  const fromOcr   = splitComprobante(ocrComp);                 // {null,null} si no hubo patron
  const fromModel = splitComprobante(extracted.numero_comprobante);

  const correlativo = fromOcr.correlativo ?? fromModel.correlativo;
  if (correlativo) extracted.numero_comprobante = correlativo;
  extracted.punto_venta =
       fromOcr.puntoVenta                                      // (1) PV impreso del comprobante OCR
    ?? puntoVentaFromOcr(ocrText, correlativo)                 // (2) recuperacion anclada al correlativo
    ?? fromModel.puntoVenta                                    // (3) PV embebido en el numero del modelo
    ?? normalizePuntoVenta(extracted.punto_venta);             // (4) el que emitio el modelo

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
