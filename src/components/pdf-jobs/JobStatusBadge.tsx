import { getUiStatus, type JobStatusDb } from '../../utils/jobStatusUtils';

interface JobStatusBadgeProps {
  status: JobStatusDb;
  total_documents: number | null;
  processed_documents: number | null;
  failed_documents: number | null;
  has_warnings?: boolean | null;
  rows_count?: number | null; // opcional, solo para debug si querés
}

export function JobStatusBadge(props: JobStatusBadgeProps) {
  const {
    status,
    total_documents,
    processed_documents,
    failed_documents,
    has_warnings,
  } = props;

  const total = total_documents ?? 0;
  const processed = processed_documents ?? 0;
  const failed = failed_documents ?? 0;
  const completedCount = processed + failed;

  // Console log para debug
  console.log('JobStatusBadge props:', {
    status,
    total_documents,
    processed_documents,
    failed_documents,
    has_warnings,
    total,
    processed,
    failed,
    completedCount,
  });

  // Calcular estado UI internamente
  let uiStatus: 'PENDIENTE' | 'PROCESANDO' | 'COMPLETADO' | 'COMPLETADO_CON_ADVERTENCIAS' | 'ERROR';

  if (status === 'error') {
    uiStatus = 'ERROR';
  } else if (status === 'pending') {
    uiStatus = 'PENDIENTE';
  } else {
    // En cualquier otro caso
    // Mientras processed_documents + failed_documents < total_documents, o total_documents === 0, mostrar PROCESANDO
    if (total === 0 || completedCount < total) {
      uiStatus = 'PROCESANDO';
    } else {
      // Cuando completedCount >= total_documents
      if (failed > 0 || has_warnings === true) {
        uiStatus = 'COMPLETADO_CON_ADVERTENCIAS';
      } else {
        uiStatus = 'COMPLETADO';
      }
    }
  }

  const statusConfig = {
    PENDIENTE: { 
      text: 'Pendiente', 
      className: 'badge badge-secondary',
      icon: null
    },
    PROCESANDO: { 
      text: 'Procesando', 
      className: 'badge badge-info',
      icon: null
    },
    COMPLETADO: { 
      text: 'Completado', 
      className: 'badge badge-success',
      icon: null
    },
    COMPLETADO_CON_ADVERTENCIAS: { 
      text: 'Completado con advertencias', 
      className: 'badge badge-warning',
      icon: '⚠️'
    },
    ERROR: { 
      text: 'Error', 
      className: 'badge badge-danger',
      icon: null
    },
  };

  const config = statusConfig[uiStatus];

  return (
    <span className={config.className} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
      {config.icon && <span>{config.icon}</span>}
      <span>{config.text}</span>
    </span>
  );
}

