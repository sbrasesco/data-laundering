import { Badge } from '@/components/ui/badge';
import { getUiStatus, type JobStatusDb } from '../../utils/jobStatusUtils';

interface JobStatusBadgeProps {
  status: JobStatusDb;
  total_documents: number | null;
  processed_documents: number | null;
  failed_documents: number | null;
  has_warnings?: boolean | null;
  rows_count?: number | null;
}

export function JobStatusBadge(props: JobStatusBadgeProps) {
  const { status, has_warnings } = props;

  const uiStatus = getUiStatus({
    status,
    total_documents: props.total_documents,
    processed_documents: props.processed_documents,
    failed_documents: props.failed_documents,
    has_warnings,
  });

  type Variant = 'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning' | 'info';

  const config: Record<string, { text: string; variant: Variant }> = {
    PENDIENTE:                   { text: 'Pendiente',           variant: 'secondary'   },
    PROCESANDO:                  { text: 'Procesando',          variant: 'secondary'   },
    COMPLETADO:                  { text: 'Completado',          variant: 'success'     },
    COMPLETADO_CON_ADVERTENCIAS: { text: 'Con advertencia',     variant: 'warning'     },
    FALLIDO:                     { text: 'Fallido',             variant: 'destructive' },
    ERROR:                       { text: 'Error',               variant: 'destructive' },
  };

  const { text, variant } = config[uiStatus] ?? { text: uiStatus, variant: 'secondary' as Variant };

  return <Badge variant={variant}>{text}</Badge>;
}
