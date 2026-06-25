/**
 * zip-processor.mjs — TASK-35: Descompresión ZIP + split por documento
 * Data Laundering V2.0 — Fase 2
 *
 * Lógica de descompresión ZIP en el Worker (DEC-011: N8N eliminado):
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

function sanitizeStorageKey(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._\-\s]/g, '_');
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

/**
 * Extrae números de OC del nombre de un adjunto PDF.
 * Versión mejorada (TASK-46): soporta más formatos de nombres.
 *
 * Formatos soportados:
 *   - "OC54487" / "54487" → [54487]           (4+ dígitos)
 *   - "OC-042" / "042"   → [42]               (3+ dígitos, bajado de 4)
 *   - "OC-2026/042"      → [2026, 42]          (slash separador)
 *   - "OC 5487 mayo"     → [5487]              (espacios)
 *   - "remito"           → null                (ignorado)
 *
 * @returns {string[]|null} — array de números como strings, o null si ignorado
 */
function parseOcFromAdjName(adjName) {
  // Ignorar remitos y recibos
  if (/remito|recibo/i.test(adjName)) return null;

  // Normalizar separadores: slash, guión, punto → espacio
  const normalized = adjName.replace(/[\/\-\.]/g, ' ');

  // Extraer secuencias de 3+ dígitos (bajado de 4)
  const nums = normalized.match(/\d{3,}/g) || [];

  // Filtrar años que claramente son años (>=2000, <=2099) si hay otros números
  // Para evitar falsos positivos con "2026" como número de OC
  const filtered = nums.length > 1
    ? nums.filter(n => !(Number(n) >= 2000 && Number(n) <= 2099))
    : nums;

  const result = (filtered.length > 0 ? filtered : nums)
    .map(n => n.replace(/^0+/, '') || n); // quitar ceros a la izquierda

  return result.length > 0 ? result : null;
}

async function buildOcMap(adjDir, log) {
  const ocMap = {}; // parentFile → [{numero_oc, nombre_adjunto, codigo_obra}]
  const skippedLog = []; // para diagnóstico (TASK-46)
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

      if (!nums || nums.length === 0) {
        // Loguear adjuntos ignorados para diagnóstico
        const reason = /remito|recibo/i.test(adjBase) ? 'es_remito' : 'sin_numero_oc';
        skippedLog.push({ adjunto: adjBase, parent, reason });
        continue;
      }

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
  } catch (e) {
    if (log) log('warn', 'zip.oc_map_error', { error: e.message });
  }

  // Loguear adjuntos ignorados
  if (skippedLog.length > 0 && log) {
    log('info', 'zip.oc_skipped', {
      count: skippedLog.length,
      adjuntos: skippedLog,
      note: 'Adjuntos ignorados al construir OC map — ver TASK-46'
    });
  }

  return ocMap;
}

// ─── Extracción de adjuntos para documento individual (TASK-73) ──────────────

/**
 * Extrae adjuntos embebidos de un PDF individual usando las 3 herramientas
 * (pdfdetach + mutool + PyMuPDF) y retorna los oc_entries correspondientes.
 *
 * @param {string} pdfPath  — ruta absoluta al PDF en disco
 * @param {string} pdfBase  — nombre base sin extensión (ej: "factura-001")
 * @param {string} jobDir   — directorio temporal de trabajo (se crea si no existe)
 * @param {string} adjDir   — directorio donde depositar los adjuntos extraídos
 * @param {function} log
 * @returns {Array<{numero_oc, nombre_adjunto, codigo_obra}>}
 */
export async function extractAttachmentsFromPdf(pdfPath, pdfBase, jobDir, adjDir, log) {
  await mkdir(adjDir, { recursive: true });

  const tmpAdj       = join(jobDir, `adj_tmp_${pdfBase}`);
  const tmpPdfdetach = join(jobDir, `adj_pdfdetach_${pdfBase}`);
  const tmpMutool    = join(jobDir, `adj_mutool_${pdfBase}`);
  const tmpPymupdf   = join(jobDir, `adj_pymupdf_${pdfBase}`);
  for (const d of [tmpAdj, tmpPdfdetach, tmpMutool, tmpPymupdf]) {
    await mkdir(d, { recursive: true });
  }

  await runCmd(`pdfdetach -saveall -o "${tmpPdfdetach}/" "${pdfPath}" 2>/dev/null || true`);
  await runCmd(`cd "${tmpMutool}" && mutool extract "${pdfPath}" 2>/dev/null || true`);
  await runCmd(`python3 /app/extract_attachments.py "${pdfPath}" "${tmpPymupdf}" 2>/dev/null || echo '{"files":[]}'`);

  const fromPdfdetach = (await readdir(tmpPdfdetach)).filter(f => f.toLowerCase().endsWith('.pdf'));
  const fromMutool    = (await readdir(tmpMutool)).filter(f => f.toLowerCase().endsWith('.pdf'));
  const fromPymupdf   = (await readdir(tmpPymupdf)).filter(f => f.toLowerCase().endsWith('.pdf'));

  log?.('info', 'single.adj_extracted', {
    pdf: pdfBase,
    pdfdetach: fromPdfdetach.length,
    mutool:    fromMutool.length,
    pymupdf:   fromPymupdf.length,
  });

  const seen = new Set();
  for (const [src, files] of [
    [tmpPdfdetach, fromPdfdetach],
    [tmpMutool,    fromMutool],
    [tmpPymupdf,   fromPymupdf],
  ]) {
    for (const f of files) {
      const key = f.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        await runCmd(`mv "${join(src, f)}" "${tmpAdj}/${f}" 2>/dev/null || true`);
      }
    }
  }
  for (const d of [tmpPdfdetach, tmpMutool, tmpPymupdf]) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }

  const adjFiles = (await readdir(tmpAdj)).filter(f => f.toLowerCase().endsWith('.pdf'));
  for (const af of adjFiles) {
    if (/remito/i.test(af)) continue;
    const adjBase = af.replace(/\.pdf$/i, '').replace(/\.PDF$/i, '');
    const dest = join(adjDir, `__adj__${pdfBase}__${adjBase}.pdf`);
    await runCmd(`mv "${join(tmpAdj, af)}" "${dest}" 2>/dev/null || true`);

    const { stdout: obraText } = await runCmd(`pdftotext "${dest}" - 2>/dev/null || true`);
    const obraMatch = obraText.match(/para la obra[^0-9]*(\d+)/i);
    if (obraMatch) {
      const { writeFile } = await import('fs/promises');
      await writeFile(dest.replace(/\.pdf$/i, '.obra'), obraMatch[1], 'utf8');
    }
  }
  await rm(tmpAdj, { recursive: true, force: true }).catch(() => {});

  const ocMap = await buildOcMap(adjDir, log);
  const parentKey = pdfBase + '.pdf';
  return ocMap[parentKey] ?? [];
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
export async function processZip(jobData, log, extractAttachments = false) {
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
    // 7zz (paquete 7zip) soporta ZIP y RAR (incl. RAR5) nativamente. Capturamos la salida para diagnóstico.
    const extractRes = await runCmd(`7zz x "${zipPath}" -o"${workDir}/" -y 2>&1`);
    log('info', 'zip.extract_result', { job_id, ok: extractRes.ok, output: String(extractRes.stdout || extractRes.stderr || '').slice(0, 600) });

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

    await mkdir(adjDir, { recursive: true });
    // ── pdfdetach: extraer adjuntos embebidos (OCs) ───────────────────────────
    if (!extractAttachments) log?.('info', 'zip.adj_extraction_skipped', { job_id, reason: 'org_flag_off' });
    const pdfFiles = extractAttachments
      ? (await readdir(workDir)).filter(f => f.toLowerCase().endsWith('.pdf'))
      : [];
    for (const pdf of pdfFiles) {
      if (pdf.startsWith('__adj__')) continue;
      const pdfPath = join(workDir, pdf);
      const pdfBase = basename(pdf, '.pdf');
      const tmpAdj = join(jobDir, `adj_tmp_${pdfBase}`);
      await mkdir(tmpAdj, { recursive: true });

      // Correr pdfdetach Y mutool siempre — combinar resultados (deduplicar por nombre).
      // Esto elimina la no-determinismo: si uno falla en un PDF, el otro lo atrapa.
      const tmpPdfdetach = join(jobDir, `adj_pdfdetach_${pdfBase}`);
      const tmpMutool    = join(jobDir, `adj_mutool_${pdfBase}`);
      const tmpPymupdf   = join(jobDir, `adj_pymupdf_${pdfBase}`);
      await mkdir(tmpPdfdetach, { recursive: true });
      await mkdir(tmpMutool,    { recursive: true });
      await mkdir(tmpPymupdf,   { recursive: true });

      // Herramienta 1: pdfdetach (poppler)
      await runCmd(`pdfdetach -saveall -o "${tmpPdfdetach}/" "${pdfPath}" 2>/dev/null || true`);
      // Herramienta 2: mutool (mupdf-tools)
      await runCmd(`cd "${tmpMutool}" && mutool extract "${pdfPath}" 2>/dev/null || true`);
      // Herramienta 3: PyMuPDF — cubre FileAttachment annotations que pdfdetach+mutool pierden (DT-009)
      const pymupdfResult = await runCmd(
        `python3 /app/extract_attachments.py "${pdfPath}" "${tmpPymupdf}" 2>/dev/null || echo '{"files":[]}'`
      );

      const fromPdfdetach = (await readdir(tmpPdfdetach)).filter(f => f.toLowerCase().endsWith('.pdf'));
      const fromMutool    = (await readdir(tmpMutool)).filter(f => f.toLowerCase().endsWith('.pdf'));
      const fromPymupdf   = (await readdir(tmpPymupdf)).filter(f => f.toLowerCase().endsWith('.pdf'));

      log?.('info', 'zip.adj_extracted', {
        job_id, pdf,
        pdfdetach: fromPdfdetach.length,
        mutool:    fromMutool.length,
        pymupdf:   fromPymupdf.length,
      });

      // Combinar las 3 herramientas, deduplicando por nombre (case-insensitive)
      const seen = new Set();
      for (const [src, files] of [
        [tmpPdfdetach, fromPdfdetach],
        [tmpMutool,    fromMutool],
        [tmpPymupdf,   fromPymupdf],
      ]) {
        for (const f of files) {
          const key = f.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            await runCmd(`mv "${join(src, f)}" "${tmpAdj}/${f}" 2>/dev/null || true`);
          }
        }
      }
      await rm(tmpPdfdetach, { recursive: true, force: true }).catch(() => {});
      await rm(tmpMutool,    { recursive: true, force: true }).catch(() => {});
      await rm(tmpPymupdf,   { recursive: true, force: true }).catch(() => {});

      const adjFiles = (await readdir(tmpAdj)).filter(f => f.toLowerCase().endsWith('.pdf'));
      for (const af of adjFiles) {
        if (/remito/i.test(af)) {
          log?.('info', 'zip.adj_skipped_pdfdetach', { job_id, adjunto: af, parent: pdfBase, reason: 'es_remito' });
          continue;
        }
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
    // Pasar log para que buildOcMap pueda registrar adjuntos ignorados (TASK-46)
    const ocMap = await buildOcMap(adjDir, log);
    log('info', 'zip.oc_map', {
      job_id,
      docs_with_oc: Object.keys(ocMap).length,
      total_ocs: Object.values(ocMap).flat().length,
      detalle: ocMap,
    });

    // ── Recolectar archivos finales ───────────────────────────────────────────
    const allFiles = (await readdir(workDir)).filter(f => {
      const low = f.toLowerCase();
      return (low.endsWith('.pdf') || low.endsWith('.jpg') || low.endsWith('.jpeg') || low.endsWith('.png'))
        && !f.startsWith('__adj__');
    });

    // Archivos NO soportados dentro del comprimido (TASK-109): se reportan por nombre.
    // find recursivo busybox-safe (usa ! y -iname, sin -printf), excluye la carpeta adj/.
    const unsupRaw = (await runCmd(
      `find "${workDir}" -type f ! -path "*/adj/*" ` +
      `! -iname '*.pdf' ! -iname '*.jpg' ! -iname '*.jpeg' ! -iname '*.png' 2>/dev/null || true`
    )).stdout;
    const unsupportedFiles = (unsupRaw || '').split('\n').map(s => s.trim()).filter(Boolean).map(p => p.split('/').pop());

    log('info', 'zip.files_found', { job_id, count: allFiles.length, files: allFiles, unsupported: unsupportedFiles });

    // ── Subir cada documento a Supabase Storage ───────────────────────────────
    const documents = [];
    let failedUploads = 0;
    for (const fileName of allFiles) {
      const filePath = join(workDir, fileName);
      const ext = extname(fileName).slice(1).toLowerCase();
      const storagePath = `${organization_id}/${job_id}/${sanitizeStorageKey(fileName)}`;

      try {
        log('info', 'zip.uploading_doc', { job_id, file: fileName, ext, storage_path: storagePath });
        const publicUrl = await uploadToStorage(filePath, storagePath);
        const ocEntries = ocMap[fileName]
          ?? (ext === 'png' ? ocMap[basename(fileName, '.png') + '.pdf'] : null)
          ?? [];
        documents.push({
          file_url: publicUrl,
          file_type: ext === 'jpeg' ? 'jpg' : ext,
          original_filename: fileName,
          storage_path: storagePath,
          oc_entries: ocEntries,
          client_cuit: client_cuit ?? null,
          client_name: client_name ?? null,
        });
        log('info', 'zip.doc_uploaded', {
          job_id,
          file: fileName,
          oc_count: ocEntries.length,
          oc_numbers: ocEntries.map(e => e.numero_oc),
          url: publicUrl,
        });
      } catch (err) {
        // Log detallado del fallo para diagnosticar (TASK-46)
        failedUploads++;
        log('error', 'zip.upload_failed', {
          job_id,
          file: fileName,
          ext,
          storage_path: storagePath,
          error: err.message,
          note: 'Documento NO encolado — contado en failed_documents del job',
        });
      }
    }

    log('info', 'zip.done', {
      job_id,
      total_attempted: allFiles.length,
      uploaded: documents.length,
      failed_uploads: failedUploads,
    });
    return { documents, failedUploads, detectedFiles: allFiles, unsupportedFiles };

  } finally {
    // Limpieza del directorio temporal
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}
