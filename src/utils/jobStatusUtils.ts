export type JobStatusDb = 'pending' | 'processing' | 'done' | 'error';

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

export function getUiStatus(job: JobForStatus): UiStatus {
  const total = job.total_documents ?? 0;
  const processed = job.processed_documents ?? 0;
  const failed = job.failed_documents ?? 0;
  const hasWarnings = job.has_warnings === true;
  const completedCount = processed + failed;

  // Estados "duros" primero
  if (job.status === 'error') return 'ERROR';
  if (job.status === 'pending') return 'PENDIENTE';

  // Mientras está marcando processing en la DB
  if (job.status === 'processing') return 'PROCESANDO';

  // Si la DB ya marcó 'done' pero los contadores todavía no reflejan todo,
  // hay que seguir mostrando "Procesando", nunca "completado con advertencias".
  if (job.status === 'done') {
    // REGLA ESTRICTA: Mientras completedCount < total, siempre PROCESANDO
    if (completedCount < total) {
      return 'PROCESANDO';
    }

    // Solo cuando completedCount >= total, evaluar si está completado o con advertencias
    if (failed > 0 || hasWarnings) {
      return 'COMPLETADO_CON_ADVERTENCIAS';
    }

    return 'COMPLETADO';
  }

  // Fallback defensivo
  return 'PROCESANDO';
}

