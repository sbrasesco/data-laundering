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
    has_warnings,
  } = props;

  // Mapeo de estados 100% basado en el campo status de la BD
  // done y done_with_warnings ambos muestran "Completado"
  // NO deducimos estados de contadores ni usamos has_warnings - la BD es la fuente de verdad
  const uiStatus = getUiStatus({
    status,
    total_documents: props.total_documents,
    processed_documents: props.processed_documents,
    failed_documents: props.failed_documents,
    has_warnings, // Pasado pero no usado en el mapeo del Dashboard
  });

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

