-- TASK-10: Shadow mode validation views
-- Compara pdf_documents (n8n monolito) vs pdf_job_rows (worker)

CREATE OR REPLACE VIEW public.v_shadow_comparison AS
WITH comparison AS (
  SELECT
    COALESCE(pd.job_id, pjr.job_id)           AS job_id,
    COALESCE(pd.organization_id, pjr.org_id)  AS organization_id,
    COALESCE(pd.numero_comprobante, pjr.numero_comprobante) AS numero_comprobante,
    pd.proveedor        AS n8n_proveedor,
    pd.cuit             AS n8n_cuit,
    pd.total            AS n8n_total,
    pd.iva              AS n8n_iva,
    pd.fecha            AS n8n_fecha,
    pd.tipo_documento   AS n8n_tipo,
    pjr.proveedor       AS worker_proveedor,
    pjr.cuit            AS worker_cuit,
    pjr.total           AS worker_total,
    pjr.iva             AS worker_iva,
    pjr.fecha           AS worker_fecha,
    pjr.tipo_documento  AS worker_tipo,
    pd.confidence_score  AS n8n_confidence,
    pjr.confidence_score AS worker_confidence,
    CASE
      WHEN pd.numero_comprobante IS NULL      THEN 'N8N_MISSING'
      WHEN pjr.numero_comprobante IS NULL     THEN 'WORKER_MISSING'
      WHEN pd.total          IS NOT DISTINCT FROM pjr.total
       AND pd.proveedor      IS NOT DISTINCT FROM pjr.proveedor
       AND pd.cuit           IS NOT DISTINCT FROM pjr.cuit
       AND pd.tipo_documento IS NOT DISTINCT FROM pjr.tipo_documento
       AND pd.fecha          IS NOT DISTINCT FROM pjr.fecha
      THEN 'MATCH'
      ELSE 'MISMATCH'
    END AS comparison
  FROM pdf_documents pd
  FULL OUTER JOIN pdf_job_rows pjr
    ON  pjr.job_id = pd.job_id
    AND pjr.numero_comprobante = pd.numero_comprobante
)
SELECT
  c.*,
  pj.created_at AS job_created_at,
  CASE WHEN comparison = 'MISMATCH' THEN
    jsonb_strip_nulls(jsonb_build_object(
      'total',     CASE WHEN c.n8n_total     IS DISTINCT FROM c.worker_total
                   THEN jsonb_build_object('n8n', c.n8n_total,     'worker', c.worker_total)     END,
      'proveedor', CASE WHEN c.n8n_proveedor IS DISTINCT FROM c.worker_proveedor
                   THEN jsonb_build_object('n8n', c.n8n_proveedor, 'worker', c.worker_proveedor) END,
      'cuit',      CASE WHEN c.n8n_cuit      IS DISTINCT FROM c.worker_cuit
                   THEN jsonb_build_object('n8n', c.n8n_cuit,      'worker', c.worker_cuit)      END,
      'tipo',      CASE WHEN c.n8n_tipo      IS DISTINCT FROM c.worker_tipo
                   THEN jsonb_build_object('n8n', c.n8n_tipo,      'worker', c.worker_tipo)      END,
      'fecha',     CASE WHEN c.n8n_fecha     IS DISTINCT FROM c.worker_fecha
                   THEN jsonb_build_object('n8n', c.n8n_fecha,     'worker', c.worker_fecha)     END
    ))
  END AS mismatch_detail
FROM comparison c
JOIN pdf_jobs pj ON pj.id = c.job_id;


CREATE OR REPLACE VIEW public.v_shadow_comparison_summary AS
SELECT
  job_id,
  organization_id,
  job_created_at,
  COUNT(*)                                              AS total_docs,
  COUNT(*) FILTER (WHERE comparison = 'MATCH')          AS match_count,
  COUNT(*) FILTER (WHERE comparison = 'MISMATCH')       AS mismatch_count,
  COUNT(*) FILTER (WHERE comparison = 'WORKER_MISSING') AS worker_missing,
  COUNT(*) FILTER (WHERE comparison = 'N8N_MISSING')    AS n8n_missing,
  ROUND(
    COUNT(*) FILTER (WHERE comparison = 'MATCH')::numeric
    / NULLIF(COUNT(*), 0) * 100, 2
  ) AS match_pct,
  CASE
    WHEN COUNT(*) FILTER (WHERE comparison = 'MISMATCH')::numeric
       / NULLIF(COUNT(*), 0) > 0.01 THEN 'ALERT'
    WHEN COUNT(*) FILTER (WHERE comparison IN ('WORKER_MISSING','N8N_MISSING')) > 0 THEN 'WARNING'
    ELSE 'OK'
  END AS status
FROM v_shadow_comparison
GROUP BY job_id, organization_id, job_created_at
ORDER BY job_created_at DESC;
