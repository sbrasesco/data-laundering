/**
 * zip-processor.mjs — TASK-35: Descompresión ZIP + split por documento
 * Data Laundering V2.0 — Fase 2
 *
 * Mueve al Worker la lógica que hoy hace el nodo "Descomprimir ZIP2" de n8n:
 * 1. Descargar ZIP desde file_url
 * 2. Extraer y aplanar estructura de carpetas
 * 3. Extraer adjuntos PDF embebidos (pdfdetach) — OCs
 * 4. Detectar PDFs escaneados y convertir a PNG (pdftoppm)
 * 5. Construir OC map por documento
 * 6. Subir cada documento individual a Supabase Storage
 * 7. Retornar array de documentos listos para encolar/procesar
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile, rm, mkdir, stat } from 'fs/promises';
import { join, extname, basename } from 'path';

const execAsync = promisify(exec);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? 'facturas';
const TMP_BASE = '/tmp/worker-zip';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runCmd(cmd) {
  try {
    const { stdout, stderr } = await execAsync(cmd);
    return { stdout, stderr, ok: true };
  } catch (e) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message, ok: false };
  }
}

function mimeType(ext) {
  const map = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

// ─── Upload a Supabase Storage ────────────────────────────────────────────────

async function uploadToStorage(filePath, storagePath) {
  const buf = await readFile(filePath);
  const ext = extname(filePath).slice(1);
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': mimeType(ext),
        'x-upsert': 'true',
      },
      body: buf,
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Storage upload failed (${res.status}): ${err}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
}

// ─── OC Map desde adjuntos ────────────────────────────────────────────────────

function parseOcFromAdjName(adjName) {
  // Ignorar remitos
  if (/remito/i.test(adjName)) return null;
  const nums = adjName.match(/\d{4,}/g) || [];
  return nums.map(n => n.replace(/^0+/, '') || n);
}

async function buildOcMap(adjDir, parentName) {
  const ocMap = {}; // parentFile → [{numero_oc, nombre_adjunto, codigo_obra}]
  try {
    const adjFiles = await readdir(adjDir);
    for (const af of adjFiles) {
      if (!af.startsWith('__adj__') || !af.toLowerCase().endsWith('.pdf')) continue;
      // Format: __adj__{parent}__{adjname}.pdf
      const inner = af.slice(7); // remove __adj__
      const sep = inner.lastIndexOf('__');
      if (sep === -1) continue;
      const parent = inner.slice(0, sep);
      const adjBase = inner.slice(sep + 2).replace(/\.pdf$/i, '');
      const nums = parseOcFromAdjName(adjBase);
      if (!nums || nums.length === 0) continue;

      // Try to get obra code from .obra file
      let codigoObra = null;
      try {
        const obraFile = join(adjDir, af.replace(/\.pdf$/i, '.obra'));
        codigoObra = (await readFile(obraFile, 'utf8')).trim() || null;
      } catch {}

      const parentKey = parent + '.pdf';
      if (!ocMap[parentKey]) ocMap[parentKey] = [];
      for (const num of nums) {
        if (!ocMap[parentKey].find(e => e.numero_oc === num)) {
          ocMap[parentKey].push({ numero_oc: num, nombre_adjunto: adjBase, codigo_obra: codigoObra });
        }
      }
    }
  } catch {}
  return ocMap;
}

// ─── Procesamiento principal ──────────────────────────────────────────────────

/**
 * Procesa un ZIP y retorna un array de documentos individuales.
 * Cada documento tiene toda la info necesaria para llamar al sub-workflow.
 *
 * @param {object} jobData — datos del job padre (job_id, organization_id, file_url, ...)
 * @param {function} log — logger estructurado
 * @returns {Array<{file_url, file_type, original_filename, oc_entries, storage_path}>}
 */
export async function processZip(jobData, log) {
  const { job_id, organization_id, file_url, client_cuit, client_name } = jobData;

  const jobDir = join(TMP_BASE, job_id);
  const workDir = join(jobDir, 'work');
  const adjDir = join(workDir, 'adj');
  const zipPath = join(jobDir, 'input.archive');

  try {
    // ── Setup ─────────────────────────────────────────────────────────────────
    await mkdir(adjDir, { recursive: true });

    // ── Descargar ZIP ─────────────────────────────────────────────────────────
    log('info', 'zip.downloading', { job_id, file_url });
    const dlResult = await runCmd(`wget -qO "${zipPath}" "${file_url}"`);
    if (!dlResult.ok) throw new Error(`Download failed: ${dlResult.stderr}`);

    // ── Extraer ───────────────────────────────────────────────────────────────
    log('info', 'zip.extracting', { job_id });
    await runCmd(`7z x "${zipPath}" -o"${workDir}/" -y 2>&1 || true`);

    // Aplanar subcarpetas
    await runCmd(
      `find "${workDir}" -mindepth 2 \\( -iname "*.pdf" -o -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \\) ` +
      `-exec mv -t "${workDir}/" {} + 2>/dev/null || true`
    );
    await runCmd(`find "${workDir}" -mindepth 1 -type d -exec rmdir {} + 2>/dev/null || true`);

    // Normalizar extensiones
    for (const [from, to] of [['PDF', 'pdf'], ['JPG', 'jpg'], ['JPEG', 'jpeg'], ['PNG', 'png']]) {
      await runCmd(
        `for f in "${workDir}"/*.${from}; do [ -f "$f" ] && mv "$f" "\${f%.${from}}.${to}"; done 2>/dev/null || true`
      );
    }

    // ── pdfdetach: extraer adjuntos embebidos (OCs) ───────────────────────────
    const pdfFiles = (await readdir(workDir)).filter(f => f.toLowerCase().endsWith('.pdf'));
    for (const pdf of pdfFiles) {
      if (pdf.startsWith('__adj__')) continue;
      const pdfPath = join(workDir, pdf);
      const pdfBase = basename(pdf, '.pdf');
      const tmpAdj = join(jobDir, `adj_tmp_${pdfBase}`);
      await mkdir(tmpAdj, { recursive: true });

      await runCmd(`pdfdetach -saveall -o "${tmpAdj}/" "${pdfPath}" 2>/dev/null || true`);

      const adjFiles = (await readdir(tmpAdj)).filter(f => f.toLowerCase().endsWith('.pdf'));
      for (const af of adjFiles) {
        if (/remito/i.test(af)) continue;
        const adjBase = af.replace(/\.pdf$/i, '').replace(/\.PDF$/i, '');
        const dest = join(adjDir, `__adj__${pdfBase}__${adjBase}.pdf`);
        await runCmd(`mv "${join(tmpAdj, af)}" "${dest}" 2>/dev/null || true`);

        // Extraer código de obra del adjunto
        const { stdout: obraText } = await runCmd(`pdftotext "${dest}" - 2>/dev/null || true`);
        const obraMatch = obraText.match(/para la obra[^0-9]*(\d+)/i);
        if (obraMatch) {
          const obraPath = dest.replace(/\.pdf$/i, '.obra');
          const { writeFile } = await import('fs/promises');
          await writeFile(obraPath, obraMatch[1], 'utf8');
        }
      }
      await rm(tmpAdj, { recursive: true, force: true });
    }

    // ── Convertir PDFs escaneados a PNG ───────────────────────────────────────
    const pdfsNow = (await readdir(workDir)).filter(f => f.toLowerCase().endsWith('.pdf') && !f.startsWith('__adj__'));
    for (const pdf of pdfsNow) {
      const pdfPath = join(workDir, pdf);
      const pdfBase = basename(pdf, '.pdf');
      const pngPath = join(workDir, pdfBase + '.png');

      try {
        // Verificar si tiene texto suficiente
        const { stdout: textOut } = await runCmd(`pdftotext "${pdfPath}" - 2>/dev/null | head -c 2000`);
        const cuit = textOut.match(/\d{11}/);
        const kwCount = (textOut.match(/(factura|cuit|total|iva|comprobante|importe)/gi) || []).length;
        if (!cuit && kwCount < 3) {
          // PDF escaneado → convertir a PNG
          await runCmd(
            `pdftoppm -png -r 200 -f 1 -l 1 "${pdfPath}" "${join(workDir, pdfBase)}" 2>/dev/null || true`
          );
          // Renombrar el primer página generada
          const pngs = (await readdir(workDir)).filter(f => f.startsWith(pdfBase) && f.endsWith('.png'));
          if (pngs.length > 0) {
            await runCmd(`mv "${join(workDir, pngs[0])}" "${pngPath}" 2>/dev/null || true`);
            await rm(pdfPath, { force: true });
            log('info', 'zip.scanned_converted', { job_id, file: pdf });
          }
        }
      } catch {}
    }

    // ── Construir OC map ──────────────────────────────────────────────────────
    const ocMap = await buildOcMap(adjDir, '');
    log('info', 'zip.oc_map', { job_id, docs_with_oc: Object.keys(ocMap).length });

    // ── Recolectar archivos finales ───────────────────────────────────────────
    const allFiles = (await readdir(workDir)).filter(f => {
      const low = f.toLowerCase();
      return (low.endsWith('.pdf') || low.endsWith('.jpg') || low.endsWith('.jpeg') || low.endsWith('.png'))
        && !f.startsWith('__adj__');
    });

    log('info', 'zip.files_found', { job_id, count: allFiles.length, files: allFiles });

    // ── Subir cada documento a Supabase Storage ───────────────────────────────
    const documents = [];
    for (const fileName of allFiles) {
      const filePath = join(workDir, fileName);
      const ext = extname(fileName).slice(1).toLowerCase();
      const storagePath = `${organization_id}/${job_id}/${fileName}`;

      try {
        const publicUrl = await uploadToStorage(filePath, storagePath);
        const ocEntries = ocMap[fileName] || [];
        documents.push({
          file_url: publicUrl,
          file_type: ext === 'jpeg' ? 'jpg' : ext,
          original_filename: fileName,
          storage_path: storagePath,
          oc_entries: ocEntries,
          client_cuit: client_cuit ?? null,
          client_name: client_name ?? null,
        });
        log('info', 'zip.doc_uploaded', { job_id, file: fileName, oc_count: ocEntries.length });
      } catch (err) {
        log('warn', 'zip.upload_failed', { job_id, file: fileName, error: err.message });
      }
    }

    log('info', 'zip.done', { job_id, total_docs: documents.length });
    return documents;

  } finally {
    // Limpieza del directorio temporal
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}
