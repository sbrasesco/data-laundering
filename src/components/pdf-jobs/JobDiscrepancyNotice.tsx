import { getDocDiscrepancy, type JobForStatus } from '../../utils/jobStatusUtils';

/**
 * Aviso a nivel de proceso cuando los documentos detectados no coinciden con los
 * contabilizados (procesados + fallidos). No se muestra nada si el job está sano
 * o si todavía no terminó. Ver getDocDiscrepancy para la definición.
 */
const STATUS_LABEL: Record<string, string> = {
  failed: 'error de lectura',
  upload_failed: 'no se pudo subir',
  omitted: 'no procesado',
  unsupported: 'formato no soportado',
};

export function JobDiscrepancyNotice({ job }: { job: JobForStatus }) {
  const d = getDocDiscrepancy(job);
  const notProcessed = (job.file_manifest ?? []).filter((f) => f.status !== 'processed');

  // Anomalía de conteo (procesados/fallidos > detectados): aviso naranja informativo.
  if (d.kind === 'anomaly') {
    return (
      <div
        role="alert"
        className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800"
      >
        <span className="font-medium">Aviso:</span> el conteo de documentos es inconsistente ({d.accounted} procesados/fallidos
        sobre {d.total} detectados). Estamos revisándolo; los datos extraídos no se ven afectados.
      </div>
    );
  }

  // Si hay manifiesto con archivos no procesados (incluye formatos no soportados como .doc),
  // los nombramos — aunque el conteo no muestre hueco.
  if (notProcessed.length > 0) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800"
      >
        <span className="font-medium">Atención:</span> {notProcessed.length} archivo{notProcessed.length === 1 ? '' : 's'} no se
        procesó{notProcessed.length === 1 ? '' : 'aron'}. Si los necesitás, volvé a subirlos en un formato soportado (PDF, JPG, PNG).
        <ul className="list-disc list-inside mt-2 space-y-0.5">
          {notProcessed.map((f) => (
            <li key={f.name} className="break-all">
              {f.name} <span className="text-yellow-700">— {STATUS_LABEL[f.status] ?? f.status}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // Jobs viejos sin manifiesto pero con hueco de conteo: aviso por número (backward-compat).
  if (d.kind === 'gap') {
    return (
      <div
        role="alert"
        className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800"
      >
        <span className="font-medium">Atención:</span> de {d.total} documento{d.total === 1 ? '' : 's'} detectado
        {d.total === 1 ? '' : 's'}, {d.missing} no se procesó{d.missing === 1 ? '' : 'aron'}. Puede deberse a un
        formato no soportado o a un error de lectura. Si necesitás esos documentos, volvé a subirlos.
      </div>
    );
  }

  return null;
}
