/**
 * vision-type-test.mjs — Prueba (NO producción) de detección de TIPO con visión.
 *
 * Compara qué tipo de comprobante detectan varios modelos de OpenAI VIENDO la
 * imagen del PDF (no el texto OCR). Sirve para decidir el "fix grande" (que la
 * IA vea la imagen) y elegir modelo, antes de tocar producción. AFIP-CODE-CONSISTENCY.
 *
 * Requiere: OPENAI_API_KEY + python3 con PyMuPDF (fitz) — mismo render que el worker.
 *   (NO usar pdftoppm: en Alpine sin fuentes omite el texto y el PNG sale en blanco.)
 * Uso:   node scripts/vision-type-test.mjs archivo1.pdf archivo2.pdf ...
 * Modelos: por defecto gpt-4.1-mini, gpt-5-mini, gpt-5-nano.
 *          Override con  MODELS="gpt-4.1-mini,gpt-5-mini" node scripts/...
 *
 * Solo lee: convierte la 1a pagina a PNG, se la manda a cada modelo y pide el
 * tipo. NO escribe en la DB ni toca el worker.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODELS = (process.env.MODELS ?? 'gpt-4.1-mini,gpt-5-mini,gpt-5-nano')
  .split(',').map(s => s.trim()).filter(Boolean);

// Precios USD por token [entrada, salida] (jul-2026). Actualizar si cambian.
const PRICES = {
  'gpt-4.1-mini': [0.40 / 1e6, 1.60 / 1e6],
  'gpt-5-mini':   [0.25 / 1e6, 2.00 / 1e6],
  'gpt-5-nano':   [0.05 / 1e6, 0.40 / 1e6],
  'gpt-4.1':      [2.00 / 1e6, 8.00 / 1e6],
  'gpt-4o':       [2.50 / 1e6, 10.0 / 1e6],
};

if (!OPENAI_API_KEY) { console.error('Falta OPENAI_API_KEY en el entorno.'); process.exit(1); }
const pdfs = process.argv.slice(2);
if (pdfs.length === 0) { console.error('Uso: node scripts/vision-type-test.mjs <pdf...>'); process.exit(1); }

const SYSTEM = 'Sos un analista de comprobantes fiscales argentinos. Mira la IMAGEN del documento e identifica el tipo. La LETRA grande (A/B/C/M) suele estar arriba al centro en un recuadro; tambien puede haber "Cod. NN". Devolve SOLO JSON: {"tipo_documento":"FACTURA_A|FACTURA_B|FACTURA_C|FACTURA_M|NOTA_CREDITO_A|NOTA_CREDITO_B|NOTA_CREDITO_C|NOTA_DEBITO_A|NOTA_DEBITO_B|NOTA_DEBITO_C|null","letra":"A|B|C|M|null","visto_en":"letra|codigo|texto"}.';

// Render con PyMuPDF (mismo motor que el worker). pdftoppm en Alpine, sin fuentes,
// omite el texto -> PNG en blanco -> modelos devuelven null (falso negativo).
const FITZ_RENDER = 'import fitz,sys\npix=fitz.open(sys.argv[1])[0].get_pixmap(dpi=int(sys.argv[3]))\npix.save(sys.argv[2])';

function pdfToPngDataUrl(pdfPath, dpi = 150) {
  const out = `/tmp/vt_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
  execFileSync('python3', ['-c', FITZ_RENDER, pdfPath, out, String(dpi)]);
  if (!existsSync(out)) throw new Error('PyMuPDF no genero PNG');
  const b64 = readFileSync(out).toString('base64');
  rmSync(out, { force: true });
  return `data:image/png;base64,${b64}`;
}

async function classify(model, dataUrl) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: [
          { type: 'text', text: 'Identifica el tipo de comprobante de esta imagen.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { text: (data.choices?.[0]?.message?.content ?? '').trim(), usage: data.usage ?? {} };
}

function parseTipo(text) {
  try { return JSON.parse(text.replace(/^```json\s*|\s*```$/g, '')).tipo_documento ?? '?'; }
  catch { return text.slice(0, 40); }
}

const totalCost = {};
for (const pdf of pdfs) {
  const name = basename(pdf);
  console.log(`\n=== ${name} ===`);
  let dataUrl;
  try { dataUrl = pdfToPngDataUrl(pdf); }
  catch (e) { console.log(`  ERROR conversion: ${e.message}`); continue; }
  for (const model of MODELS) {
    try {
      const { text, usage } = await classify(model, dataUrl);
      const [pin, pout] = PRICES[model] ?? [0, 0];
      const cost = (usage.prompt_tokens ?? 0) * pin + (usage.completion_tokens ?? 0) * pout;
      totalCost[model] = (totalCost[model] ?? 0) + cost;
      console.log(`  ${model.padEnd(14)} tipo=${parseTipo(text).padEnd(16)} tok(in/out)=${usage.prompt_tokens}/${usage.completion_tokens}  $${cost.toFixed(5)}`);
    } catch (e) {
      console.log(`  ${model.padEnd(14)} ERROR: ${e.message}`);
    }
  }
}
console.log(`\n--- Costo total por modelo (${pdfs.length} docs) ---`);
for (const model of MODELS) {
  const t = totalCost[model] ?? 0;
  console.log(`  ${model.padEnd(14)} $${t.toFixed(5)}   ( ~$${(t / pdfs.length * 1000).toFixed(2)} / 1000 docs )`);
}
