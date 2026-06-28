import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Button } from '@/components/ui/button';
import { EditRowModal } from './EditRowModal';

interface JobDocumentsSectionProps {
  rows: any[];
  jobId: string;
  orgId: string;
  onRowUpdated: () => void;
}

const WORKER_GATEWAY_URL = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://api.agoradigital.io';
const WORKER_API_KEY     = import.meta.env.VITE_WORKER_API_KEY     ?? 'staging-key-2026';

const STATUS_LABEL: Record<string, string> = {
  ok:               'Exitoso',
  warning:          'Con advertencia',
  failed:           'Fallido',
  pending_approval: 'Pendiente de aprobación',
};

const STATUS_ROW_STYLE: Record<string, React.CSSProperties> = {
  failed:           { borderLeft: '3px solid hsl(var(--destructive))', backgroundColor: 'rgba(220, 53, 69, 0.08)' },
  warning:          { borderLeft: '3px solid #f59e0b',                 backgroundColor: 'rgba(245, 158, 11, 0.08)' },
  pending_approval: { borderLeft: '3px solid #3b82f6',                 backgroundColor: 'rgba(59, 130, 246, 0.08)' },
};

// Recuadro de documento duplicado: tono de alerta distinto (naranja fuerte) para advertir que
// NO generó CSV de salida. Distinto del rojo de 'failed' (no es un error) y del verde de 'ok'.
const DUP_ROW_STYLE: React.CSSProperties = {
  borderLeft:      '4px solid #ea580c',
  backgroundColor: 'rgba(234, 88, 12, 0.12)',
};

const BADGE_CLASS: Record<string, string> = {
  ok:               'bg-green-100 text-green-700 border border-green-200',
  warning:          'bg-yellow-100 text-yellow-700 border border-yellow-200',
  failed:           'bg-red-100 text-red-700 border border-red-200',
  pending_approval: 'bg-blue-100 text-blue-700 border border-blue-200',
};

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function JobDocumentsSection({ rows, jobId: _jobId, orgId: _orgId, onRowUpdated }: JobDocumentsSectionProps) {
  const [editRow, setEditRow]       = useState<any | null>(null);
  const [saving, setSaving]         = useState(false);
  const [approvingId, setApprovingId] = useState<number | null>(null);

  const handleSaveEdit = async (rowId: number, updates: Record<string, any>) => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('pdf_job_rows')
        .update({ ...updates, doc_status: 'pending_approval' })
        .eq('id', rowId);
      if (error) throw error;
      setEditRow(null);
      onRowUpdated();
    } catch (err) {
      console.error('Error guardando fila:', err);
      alert('Error al guardar. Intentá nuevamente.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndProcess = async (rowId: number, updates: Record<string, any>) => {
    setSaving(true);
    try {
      const { error: updateError } = await supabase
        .from('pdf_job_rows')
        .update({ ...updates, doc_status: 'pending_approval' })
        .eq('id', rowId);
      if (updateError) throw updateError;

      const { data, error: approveError } = await supabase.rpc('approve_document_row', { p_row_id: rowId });
      if (approveError) throw approveError;

      if (data?.job_id && data?.org_id) {
        fetch(`${WORKER_GATEWAY_URL}/api/deposit-row`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WORKER_API_KEY}`,
          },
          body: JSON.stringify({ row_id: rowId, job_id: data.job_id, org_id: data.org_id }),
        }).catch(() => {});
      }

      setEditRow(null);
      onRowUpdated();
    } catch (err) {
      console.error('Error guardando y procesando:', err);
      alert('Error al guardar y procesar. Intentá nuevamente.');
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async (row: any) => {
    setApprovingId(row.id);
    try {
      const { data, error } = await supabase.rpc('approve_document_row', { p_row_id: row.id });
      if (error) throw error;
      if (data?.job_id && data?.org_id) {
        fetch(`${WORKER_GATEWAY_URL}/api/deposit-row`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WORKER_API_KEY}`,
          },
          body: JSON.stringify({ row_id: row.id, job_id: data.job_id, org_id: data.org_id }),
        }).catch(() => {});
      }
      onRowUpdated();
    } catch (err) {
      console.error('Error aprobando fila:', err);
      alert('Error al aprobar. Intentá nuevamente.');
    } finally {
      setApprovingId(null);
    }
  };

  if (rows.length === 0) return null;

  return (
    <>
      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Documentos</h2>
        <div className="rounded-lg border bg-card overflow-hidden">
          {rows.map((row) => {
            const status: string = row.doc_status ?? 'ok';
            const isDup = row.is_duplicate === true;
            const needsAction = status === 'failed' || status === 'warning' || status === 'pending_approval';
            const fileName = row.source_file
              ? baseName(row.source_file)
              : (row.proveedor || 'Documento sin nombre');

            return (
              <div
                key={row.id}
                style={isDup ? DUP_ROW_STYLE : STATUS_ROW_STYLE[status]}
                className="flex items-center gap-3 px-4 py-3 border-b last:border-b-0"
              >
                <span className="text-base shrink-0">📄</span>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" title={fileName}>{fileName}</p>
                  {isDup ? (
                    <div className="flex items-start gap-1.5 mt-0.5 text-orange-700">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-[1px]" />
                      <p className="text-xs">
                        No se generó archivo de salida (CSV): documento <strong>duplicado</strong>. Esta factura ya fue procesada, así que se omitió la salida para no repetir el registro en tus documentos.
                      </p>
                    </div>
                  ) : row.last_error_message && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5" title={row.last_error_message}>
                      {row.last_error_message}
                    </p>
                  )}
                </div>

                <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 ${BADGE_CLASS[status] ?? BADGE_CLASS.ok}`}>
                  {STATUS_LABEL[status] ?? status}
                </span>

                {row.is_duplicate && (
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 border border-orange-400 text-orange-600"
                    title="Documento duplicado: ya existe uno con el mismo CUIT + número de comprobante"
                  >
                    Duplicado
                  </span>
                )}

                {needsAction && (
                  <div className="flex gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => setEditRow(row)}
                      disabled={approvingId === row.id}
                    >
                      Editar
                    </Button>
                    {status === 'pending_approval' && (
                      <Button
                        size="sm"
                        className="h-7 px-2 text-xs bg-green-600 hover:bg-green-700 text-white"
                        onClick={() => handleApprove(row)}
                        disabled={approvingId === row.id}
                      >
                        {approvingId === row.id ? '...' : 'Aprobar'}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <EditRowModal
        row={editRow}
        onClose={() => setEditRow(null)}
        onSave={handleSaveEdit}
        onSaveAndProcess={handleSaveAndProcess}
        saving={saving}
      />
    </>
  );
}
