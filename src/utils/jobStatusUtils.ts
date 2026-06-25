export type JobStatusDb = 'pending' | 'processing' | 'done' | 'done_with_warnings' | 'error';

export type UiStatus =
  | 'PENDIENTE'
  | 'PROCESANDO'
  | 'COMPLETADO'
  | 'COMPLETADO_CON_ADVERTENCIAS'
  | 'FALLIDO'
  | 'ERROR';

export interface FileManifestEntry {
  name: string;
  status: 'processed' | 'failed' | 'upload_failed' | 'omitted' | 'unsupported';
}

export interface JobForStatus {
  status: JobStatusDb;
  total_documents: number | null;
  processed_documents: number | null;
  failed_documents: number | null;
  has_warnings?: boolean | null;
  file_manifest?: FileManifestEntry[] | null;
}

/**
 * Mapea el estado de BD a estado UI basándose SOLO en status.
 * Para el Dashboard: done muestra "Exitoso" y done_with_warnings "Con advertencia".
 * NO usa has_warnings ni deduce estados de contadores - la BD es la fuente de verdad.
 */
export function getUiStatus(job: JobForStatus): UiStatus {
  // Estados basados 100% en el campo status de la BD
  if (job.status === 'error') {
    return 'ERROR';
  }
  
  if (job.status === 'pending') {
    return 'PENDIENTE';
  }
  
  if (job.status === 'processing') {
    return 'PROCESANDO';
  }

  // Si TODOS los documentos del proceso fallaron, el proceso es un fallo,
  // no una simple advertencia (derivación determinística sobre los contadores del job).
  {
    const total  = job.total_documents ?? 0;
    const failed = job.failed_documents ?? 0;
    if ((job.status === 'done' || job.status === 'done_with_warnings') && total > 0 && failed >= total) {
      return 'FALLIDO';
    }
  }

  if (job.status === 'done_with_warnings') {
    return 'COMPLETADO_CON_ADVERTENCIAS';
  }

  if (job.status === 'done') {
    const hasIssues = job.has_warnings || (job.failed_documents != null && job.failed_documents > 0);
    return hasIssues ? 'COMPLETADO_CON_ADVERTENCIAS' : 'COMPLETADO';
  }

  return 'PROCESANDO';
}

/**
 * Discrepancia entre los documentos detectados y los contabilizados (procesados + fallidos).
 * NOTA: `total_documents` incluye legítimamente los adjuntos embebidos (ej. órdenes de compra
 * que el worker desengancha y procesa como documentos propios). Por eso NO se compara contra
 * "facturas" sino contra el total real de documentos detectados.
 *
 * - 'gap'     => total > procesados+fallidos: hay documentos que no se contabilizaron
 *                (se perdieron o ni se intentaron). Es el caso a avisarle al cliente.
 * - 'anomaly' => procesados+fallidos > total: inconsistencia de conteo (el "13 de 3").
 * - 'none'    => todo cuadra, o el job aún no terminó (los contadores siguen cambiando).
 *
 * Solo se evalúa en jobs terminados sin error de sistema (done / done_with_warnings).
 * Los jobs en 'error' (ej. rechazo por créditos) no representan documentos perdidos.
 */
export type DocDiscrepancyKind = 'none' | 'gap' | 'anomaly';

export interface DocDiscrepancy {
  kind: DocDiscrepancyKind;
  total: number;
  accounted: number; // processed + failed
  missing: number;   // total - accounted (> 0 sólo en 'gap')
  excess: number;    // accounted - total (> 0 sólo en 'anomaly')
}

export function getDocDiscrepancy(job: JobForStatus): DocDiscrepancy {
  const total     = job.total_documents ?? 0;
  const processed = job.processed_documents ?? 0;
  const failed    = job.failed_documents ?? 0;
  const accounted = processed + failed;
  const none: DocDiscrepancy = { kind: 'none', total, accounted, missing: 0, excess: 0 };

  if (job.status !== 'done' && job.status !== 'done_with_warnings') return none;
  if (total <= 0) return none;

  if (accounted < total) {
    return { kind: 'gap', total, accounted, missing: total - accounted, excess: 0 };
  }
  if (accounted > total) {
    return { kind: 'anomaly', total, accounted, missing: 0, excess: accounted - total };
  }
  return none;
}

