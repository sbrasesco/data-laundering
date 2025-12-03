export type JobStatusDb = 'pending' | 'processing' | 'done' | 'done_with_warnings' | 'error';

export type UiStatus =
  | 'PENDIENTE'
  | 'PROCESANDO'
  | 'COMPLETADO'
  | 'COMPLETADO_CON_ADVERTENCIAS'
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
 * Para el Dashboard: done y done_with_warnings ambos muestran "Completado".
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
  
  // done y done_with_warnings ambos muestran "Completado" en el Dashboard
  if (job.status === 'done' || job.status === 'done_with_warnings') {
    return 'COMPLETADO';
  }

  // Fallback defensivo
  return 'PROCESANDO';
}

