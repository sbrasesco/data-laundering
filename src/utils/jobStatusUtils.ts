export type JobStatusDb = 'pending' | 'processing' | 'done' | 'done_with_warnings' | 'error';

export type UiStatus =
  | 'PENDIENTE'
  | 'PROCESANDO'
  | 'COMPLETADO'
  | 'COMPLETADO_CON_ADVERTENCIAS'
  | 'FALLIDO'
  | 'ERROR';

export interface JobForStatus {
  status: JobStatusDb;
  total_documents: number | null;
  processed_documents: number | null;
  failed_documents: number | null;
  has_warnings?: boolean | null;
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
  
  if (job.status === 'done_with_warnings') {
    return 'COMPLETADO_CON_ADVERTENCIAS';
  }

  if (job.status === 'done') {
    const hasIssues = job.has_warnings || (job.failed_documents != null && job.failed_documents > 0);
    return hasIssues ? 'COMPLETADO_CON_ADVERTENCIAS' : 'COMPLETADO';
  }

  return 'PROCESANDO';
}

