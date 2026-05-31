// La clasificación de cada fila (ok / warning / failed) es calculada
// automáticamente por el trigger `trg_classify_pdf_job_row` en PostgreSQL
// y almacenada en la columna `doc_status` de pdf_job_rows.
// El frontend solo la lee — no la recalcula.

export interface RowCountMaps {
  rowCountsMap:  Map<string, number>;
  okCountsMap:   Map<string, number>;
  warnCountsMap: Map<string, number>;
  failedRowsMap: Map<string, number>;
  ocCountsMap:   Map<string, number>;
}

// Construye mapas de conteo usando doc_status que viene de la DB.
export function buildRowCountMaps(rowCountsData: any[]): RowCountMaps {
  const rowCountsMap  = new Map<string, number>();
  const okCountsMap   = new Map<string, number>();
  const warnCountsMap = new Map<string, number>();
  const failedRowsMap = new Map<string, number>();
  const ocCountsMap   = new Map<string, number>();

  rowCountsData.forEach((row) => {
    const jid = row.job_id;
    rowCountsMap.set(jid, (rowCountsMap.get(jid) || 0) + 1);

    // OCs adjuntos en esta fila — siempre se consideran "ok"
    const ocList: any[] = Array.isArray(row.pdf_job_row_oc) ? row.pdf_job_row_oc : [];
    ocCountsMap.set(jid, (ocCountsMap.get(jid) || 0) + ocList.length);

    // Usar doc_status de la DB; si no viene (fila muy vieja), asumir 'ok'
    const status: string = row.doc_status ?? 'ok';
    if (status === 'ok') {
      okCountsMap.set(jid, (okCountsMap.get(jid) || 0) + 1);
    } else if (status === 'warning') {
      warnCountsMap.set(jid, (warnCountsMap.get(jid) || 0) + 1);
    } else {
      failedRowsMap.set(jid, (failedRowsMap.get(jid) || 0) + 1);
    }
  });

  return { rowCountsMap, okCountsMap, warnCountsMap, failedRowsMap, ocCountsMap };
}

// Incluye doc_status para que el frontend no tenga que recalcularlo
export const ROWS_CLASSIFICATION_SELECT =
  'job_id, doc_status, pdf_job_row_oc(numero_oc)';
