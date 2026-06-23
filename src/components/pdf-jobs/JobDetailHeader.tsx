import { JobStatusBadge } from './JobStatusBadge';
import { PdfJobDetail } from '../../hooks/usePdfJob';
import { formatDisplayDate } from '../../utils/dateFormat';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, AlertCircle } from 'lucide-react';

interface JobDetailHeaderProps {
  job: PdfJobDetail;
}

function StatItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-sm font-medium text-foreground">{String(value)}</p>
    </div>
  );
}

export function JobDetailHeader({ job }: JobDetailHeaderProps) {
  // Proceso totalmente fallido: el badge ya muestra "Fallido"; no mostrar además
  // el alert amarillo de "se completó con advertencias" (sería contradictorio).
  const allFailed =
    (job.status === 'done' || job.status === 'done_with_warnings') &&
    (job.total_documents ?? 0) > 0 &&
    (job.failed_documents ?? 0) >= (job.total_documents ?? 0);

  const formatPeriod = (month: number | null, year: number | null) => {
    if (!month || !year) return '-';
    const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    return `${months[month - 1]} ${year}`;
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3 mb-6">
            <h2 className="text-lg font-semibold tracking-tight">Proceso {job.id.substring(0, 8)}</h2>
            <JobStatusBadge
              status={job.status}
              total_documents={job.total_documents}
              processed_documents={job.processed_documents}
              failed_documents={job.failed_documents}
              has_warnings={job.has_warnings}
              rows_count={job.rows_count}
            />
          </div>

          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <StatItem label="Cliente"            value={job.clients?.name || '-'} />
            <StatItem label="Período"            value={formatPeriod(job.period_month, job.period_year)} />
            <StatItem label="Fecha de creación"  value={formatDisplayDate(job.created_at)} />
            {job.finished_at && (
              <StatItem label="Fecha de finalización" value={formatDisplayDate(job.finished_at)} />
            )}
            <StatItem label="Total documentos"   value={job.total_documents ?? 0} />
            <StatItem label="Procesados"         value={job.processed_documents ?? 0} />
            <StatItem label="Fallidos"           value={job.failed_documents ?? 0} />
          </div>
        </CardContent>
      </Card>

      {job.has_warnings && !allFailed && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Advertencia</AlertTitle>
          <AlertDescription>
            Este proceso se completó con advertencias. Algunos documentos no pudieron procesarse correctamente.
          </AlertDescription>
        </Alert>
      )}

      {allFailed && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Proceso fallido</AlertTitle>
          <AlertDescription>
            Ningún documento de este proceso pudo procesarse correctamente.
          </AlertDescription>
        </Alert>
      )}

      {job.error_message && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{job.error_message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
