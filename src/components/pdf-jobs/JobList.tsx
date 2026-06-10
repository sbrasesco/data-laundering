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
            const computedStatus = isProcessing ? 'pending' : (job.status === 'done_with_warnings' ? 'done' : job.status);
            const displayLabel   = isProcessing ? 'Procesando' : getJobStatusLabel(computedStatus);
            const displayVariant = getJobStatusVariant(computedStatus);

            return (
              <TableRow key={job.id}>
                <TableCell className="text-sm">{formatDate(job.created_at)}</TableCell>
                <TableCell className="text-sm">{job.clients?.name || '-'}</TableCell>
                <TableCell><InputSourceBadge source={job.input_source} /></TableCell>
                <TableCell className="text-sm">{formatPeriod(job.period_month, job.period_year)}</TableCell>
                <TableCell>
                  <Badge variant={displayVariant}>{displayLabel}</Badge>
                </TableCell>
                <TableCell className="text-sm tabular-nums">
                  {total > 0 ? `${processed} / ${total}` : '-'}
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
