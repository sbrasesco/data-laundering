/**
 * doc-naming.mjs — Helper compartido para nombrar archivos por dato (FILE-RENAME-BY-DATA, Fase 1)
 * Data Laundering V2.0
 *
 * Criterio unificado para el nombre de archivos de entrada (PDF) y salida (CSV) en las
 * integraciones de storage (Supabase/Firebase): {cuit}_{numero_comprobante}_{codigo_afip}.
 * La combinacion CUIT + numero_comprobante es unica por factura; el codigo_afip identifica el tipo.
 *
 * Se usa en `output-depositor.mjs` (nombre del CSV) y `worker.mjs`/`integration-file-mover.mjs`
 * (renombrado del archivo de entrada), para que el nombre sea identico en ambos lados y no se
 * duplique el criterio.
 *
 * Alcance Fase 1: storage (Supabase/Firebase), 1 documento por job, con los 3 datos presentes.
 * Drive, multi-documento (ZIP) y documentos con datos faltantes NO se renombran (quedan con el
 * nombre por defecto / Fase 2).
 */

/** Sanea una parte del nombre: quita caracteres no validos en claves de archivo/storage. */
export function sanitizeNamePart(v) {
  return String(v ?? '').trim().replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_');
}

/**
 * Construye la base del nombre `{cuit}_{numero}_{codigo_afip}` a partir de una fila extraida.
 * @returns {string|null} la base saneada, o null si falta alguno de los 3 datos (no se renombra).
 */
export function buildDocFileBase(row) {
  const cuit = sanitizeNamePart(row?.cuit);
  const corr = sanitizeNamePart(row?.numero_comprobante); // correlativo (lo de después del último "-")
  const afip = sanitizeNamePart(row?.codigo_afip);
  if (!cuit || !corr || !afip) return null;               // sin correlativo -> no renombra
  const pv  = sanitizeNamePart(row?.punto_venta);
  const num = pv ? `${pv}-${corr}` : corr;                // punto_venta-correlativo (branch-aware)
  return `${cuit}_${num}_${afip}`;
}
