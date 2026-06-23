import { getDocDiscrepancy, type JobForStatus } from '../../utils/jobStatusUtils';

/**
 * Aviso a nivel de proceso cuando los documentos detectados no coinciden con los
 * contabilizados (procesados + fallidos). No se muestra nada si el job está sano
 * o si todavía no terminó. Ver getDocDiscrepancy para la definición.
 */
export function JobDiscrepancyNotice({ job }: { job: JobForStatus }) {
  const d = getDocDiscrepancy(job);
  if (d.kind === 'none') return null;

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

  // anomaly
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
