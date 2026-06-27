import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { PdfJob } from '../../hooks/usePdfJobs';
import { getJobStatusLabel, getJobStatusVariant } from '../../utils/status';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const SOURCE_LABELS: Record<string, string> = {
  integration_drive: 'Drive',
  ftp:               'FTP',
  sftp:              'SFTP',
  firebase_storage:  'Firebase',
};

function InputSourceBadge({ source }: { source: PdfJob['input_source'] }) {
  if (!source || source === 'frontend_upload') return <span className="text-xs text-muted-foreground">Manual</span>;
  return <Badge variant="outline" className="text-xs">{SOURCE_LABELS[source] ?? source}</Badge>;
}

interface JobListProps {
  jobs: PdfJob[];
}

export function JobList({ jobs }: JobListProps) {
  const navigate = useNavigate();

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString('es-AR', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  const formatPeriod = (month: number | null, year: number | null) => {
    if (!month || !year) return '-';
    const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    return `${months[month - 1]} ${year}`;
  };

  // Duración del proceso = finished_at - created_at (datos ya en pdf_jobs). '—' si no finalizó.
  const formatDuration = (createdAt?: string | null, finishedAt?: string | null) => {
    if (!createdAt || !finishedAt) return '—';
    const ms = new Date(finishedAt).getTime() - new Date(createdAt).getTime();
    if (!isFinite(ms) || ms < 0) return '—';
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    return `${m}m ${totalSec % 60}s`;
  };

  if (jobs.length === 0) {
    return (
      <div className="rounded-lg border bg-card text-card-foreground p-12 text-center">
        <p className="text-sm text-muted-foreground">
          Todavía no tenés procesos. Creá tu primer proceso.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Fecha</TableHead>
            <TableHead>Cliente</TableHead>
            <TableHead>Origen</TableHead>
            <TableHead>Período</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Tiempo</TableHead>
            <TableHead>Documentos</TableHead>
            <TableHead>Acción</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => {
            const total     = job.total_documents ?? 0;
            const processed = job.processed_documents ?? 0;
            const failed    = job.failed_documents ?? 0;

            const isProcessing = job.status === 'pending' || job.status === 'processing' || total === 0 || processed + failed < total;
            const allFailed    = !isProcessing && total > 0 && failed >= total;
            const hasIssues    = !isProcessing && !allFailed && job.status !== 'error' && (job.status === 'done_with_warnings' || job.has_warnings || failed > 0);

            let displayLabel: string;
            let displayVariant: 'secondary' | 'success' | 'destructive' | 'warning' | 'outline';
            if (isProcessing)            { displayLabel = 'Procesando';      displayVariant = 'secondary'; }
            else if (job.status === 'error' || allFailed) { displayLabel = 'Fallido'; displayVariant = 'destructive'; }
            else if (hasIssues)          { displayLabel = 'Con advertencia'; displayVariant = 'warning'; }
            else                         { displayLabel = getJobStatusLabel(job.status); displayVariant = getJobStatusVariant(job.status); }

            const rowBg = allFailed
              ? 'bg-red-50/70 dark:bg-red-950/10'
              : hasIssues ? 'bg-yellow-50/70 dark:bg-yellow-950/10' : '';

            return (
              <TableRow key={job.id} className={rowBg}>
                <TableCell className="text-sm">{formatDate(job.created_at)}</TableCell>
                <TableCell className="text-sm">{job.clients?.name || '-'}</TableCell>
                <TableCell><InputSourceBadge source={job.input_source} /></TableCell>
                <TableCell className="text-sm">{formatPeriod(job.period_month, job.period_year)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={displayVariant}>{displayLabel}</Badge>
                    {job.has_duplicate && (
                      <span
                        title="Este proceso contiene al menos un documento duplicado (no se generó su CSV de salida)"
                        className="inline-flex cursor-default"
                      >
                        <AlertTriangle className="h-4 w-4 text-orange-500" aria-label="Contiene un documento duplicado" />
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm tabular-nums text-muted-foreground">
                  {formatDuration(job.created_at, job.finished_at)}
                </TableCell>
                <TableCell className="text-sm tabular-nums">
                  {total > 0 ? `${processed} / ${total}` : '-'}
                  {(job.corrected_documents ?? 0) > 0 && (
                    <span className="ml-1.5 inline-flex items-center rounded-full bg-[#A347D1]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#6b21a8] ring-1 ring-inset ring-[#A347D1]/30">
                      {job.corrected_documents} corr.
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Button size="sm" onClick={() => navigate(`/jobs/${job.id}`)}>
                    Ver detalles
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
