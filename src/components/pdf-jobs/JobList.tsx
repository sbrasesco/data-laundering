import { useNavigate } from 'react-router-dom';
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
            const hasIssues    = !isProcessing && job.status !== 'error' && (job.status === 'done_with_warnings' || job.has_warnings || failed > 0);

            let displayLabel: string;
            let displayVariant: 'secondary' | 'success' | 'destructive' | 'warning' | 'outline';
            if (isProcessing)            { displayLabel = 'Procesando';      displayVariant = 'secondary'; }
            else if (job.status === 'error') { displayLabel = 'Error';       displayVariant = 'destructive'; }
            else if (hasIssues)          { displayLabel = 'Con advertencia'; displayVariant = 'warning'; }
            else                         { displayLabel = getJobStatusLabel(job.status); displayVariant = getJobStatusVariant(job.status); }

            const rowBg = hasIssues ? 'bg-yellow-50/70 dark:bg-yellow-950/10' : '';

            return (
              <TableRow key={job.id} className={rowBg}>
                <TableCell className="text-sm">{formatDate(job.created_at)}</TableCell>
                <TableCell className="text-sm">{job.clients?.name || '-'}</TableCell>
                <TableCell><InputSourceBadge source={job.input_source} /></TableCell>
                <TableCell className="text-sm">{formatPeriod(job.period_month, job.period_year)}</TableCell>
                <TableCell>
                  <Badge variant={displayVariant}>{displayLabel}</Badge>
                </TableCell>
                <TableCell className="text-sm tabular-nums">
                  {total > 0 ? `${processed} / ${total}` : '-'}
                  {(job.corrected_documents ?? 0) > 0 && (
                    <span className="ml-1.5 inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20 dark:bg-blue-900/20 dark:text-blue-400">
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
