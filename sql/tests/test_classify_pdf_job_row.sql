-- ============================================================================
-- TEST-CLASSIFY-TRIGGER — Tests del trigger classify_pdf_job_row (DEC-017)
-- ============================================================================
-- Red de seguridad para la clasificacion de doc_status (ok/warning/failed).
-- El trigger es PL/pgSQL (propenso a errores sutiles: ya aparecio el bug
-- NULL IN(...) en TASK-92), por eso conviene tener tests reproducibles.
--
-- USO:
--   SELECT * FROM test_classify_pdf_job_row();   -- 16 casos, columna `pass`
-- Es seguro correrlo en prod: cada caso inserta una fila en una subtransaccion
-- que se REVIERTE (no persiste datos) y el job de prueba se borra al final.
-- Aplicado en DB via migracion add_test_classify_pdf_job_row (2026-06-24).
--
-- Reglas que cubre (orden del trigger):
--   1. approved_at != NULL                      -> ok  (aprobacion manual gana)
--   2. last_error_message real (no LOW_CONFIDENCE/DATOS_INCOMPLETOS) -> failed
--   3. sin tipo_documento y 0 campos clave       -> failed (leyo sin dato util)
--   4. ORDEN_COMPRA/SOLICITUD_COTIZACION: numero + buena confianza -> ok / else warning
--   5. facturas/notas: 4 campos clave + confianza >= 0.70 -> ok / else warning
--   campos clave: cuit, COALESCE(total,neto_gravado), proveedor, numero_comprobante
--   baja calidad: LOW_CONFIDENCE/DATOS_INCOMPLETOS o confidence_score < 0.70
-- ============================================================================

-- Helper: evalua el trigger para un set de campos y devuelve el doc_status (sin persistir).
CREATE OR REPLACE FUNCTION public.test_clt_eval(
  p_job uuid, p_org uuid,
  p_tipo text, p_cuit text, p_total numeric, p_neto numeric,
  p_prov text, p_num text, p_conf numeric, p_err text, p_appr timestamptz
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE v_got text;
BEGIN
  BEGIN
    INSERT INTO pdf_job_rows(
      job_id, org_id, tipo_documento, cuit, total, neto_gravado,
      proveedor, numero_comprobante, confidence_score, last_error_message, approved_at
    ) VALUES (
      p_job, p_org, p_tipo, p_cuit, p_total, p_neto,
      p_prov, p_num, p_conf, p_err, p_appr
    )
    RETURNING doc_status INTO v_got;
    RAISE EXCEPTION 'test_rollback';  -- revierte el INSERT; v_got conserva el valor
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN v_got;
END $$;

CREATE OR REPLACE FUNCTION public.test_classify_pdf_job_row()
RETURNS TABLE(case_name text, expected text, got text, pass boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid;
  v_job uuid;
BEGIN
  SELECT id INTO v_org FROM organizations ORDER BY created_at LIMIT 1;
  IF v_org IS NULL THEN RAISE EXCEPTION 'No hay organizaciones para el test'; END IF;
  INSERT INTO pdf_jobs(organization_id) VALUES (v_org) RETURNING id INTO v_job;

  RETURN QUERY
  WITH r(case_name, expected, got) AS (
    VALUES
      ('01 aprobado manual (gana sobre todo)', 'ok',
        public.test_clt_eval(v_job, v_org, 'FACTURA_A', NULL, NULL, NULL, NULL, NULL, NULL, 'TIMEOUT', now())),
      ('02 error real de proceso -> failed', 'failed',
        public.test_clt_eval(v_job, v_org, 'FACTURA_A', '20-1', 100, NULL, 'Prov', '0001-1', 0.98, 'TIMEOUT', NULL)),
      ('03 LOW_CONFIDENCE no es error real (4 campos) -> warning', 'warning',
        public.test_clt_eval(v_job, v_org, 'FACTURA_A', '20-1', 100, NULL, 'Prov', '0001-1', 0.98, 'LOW_CONFIDENCE', NULL)),
      ('04 leyo sin tipo ni campos -> failed', 'failed',
        public.test_clt_eval(v_job, v_org, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)),
      ('05 factura 4 campos + conf 0.98 -> ok', 'ok',
        public.test_clt_eval(v_job, v_org, 'FACTURA_A', '20-1', 100, NULL, 'Prov', '0001-1', 0.98, NULL, NULL)),
      ('06 factura 3 campos (falta numero) -> warning', 'warning',
        public.test_clt_eval(v_job, v_org, 'FACTURA_A', '20-1', 100, NULL, 'Prov', NULL, 0.98, NULL, NULL)),
      ('07 factura 4 campos + conf 0.50 -> warning', 'warning',
        public.test_clt_eval(v_job, v_org, 'FACTURA_A', '20-1', 100, NULL, 'Prov', '0001-1', 0.50, NULL, NULL)),
      ('08 factura 4 campos + conf NULL -> ok (edge)', 'ok',
        public.test_clt_eval(v_job, v_org, 'FACTURA_A', '20-1', 100, NULL, 'Prov', '0001-1', NULL, NULL, NULL)),
      ('09 OC con numero + conf 0.98 -> ok', 'ok',
        public.test_clt_eval(v_job, v_org, 'ORDEN_COMPRA', NULL, NULL, NULL, NULL, 'OC-123', 0.98, NULL, NULL)),
      ('10 OC sin numero -> warning', 'warning',
        public.test_clt_eval(v_job, v_org, 'ORDEN_COMPRA', NULL, NULL, NULL, NULL, NULL, 0.98, NULL, NULL)),
      ('11 OC con numero + conf 0.50 -> warning', 'warning',
        public.test_clt_eval(v_job, v_org, 'ORDEN_COMPRA', NULL, NULL, NULL, NULL, 'OC-123', 0.50, NULL, NULL)),
      ('12 DATOS_INCOMPLETOS (4 campos) -> warning', 'warning',
        public.test_clt_eval(v_job, v_org, 'FACTURA_A', '20-1', 100, NULL, 'Prov', '0001-1', 0.98, 'DATOS_INCOMPLETOS', NULL)),
      ('13 sin tipo pero con 1 campo -> warning', 'warning',
        public.test_clt_eval(v_job, v_org, NULL, '20-1', NULL, NULL, NULL, NULL, NULL, NULL, NULL)),
      ('14 conf exactamente 0.70 (4 campos) -> ok (boundary)', 'ok',
        public.test_clt_eval(v_job, v_org, 'FACTURA_A', '20-1', 100, NULL, 'Prov', '0001-1', 0.70, NULL, NULL)),
      ('15 SOLICITUD_COTIZACION con numero -> ok', 'ok',
        public.test_clt_eval(v_job, v_org, 'SOLICITUD_COTIZACION', NULL, NULL, NULL, NULL, 'COT-9', 0.90, NULL, NULL)),
      ('16 factura con solo neto (sin total) cuenta el campo -> ok', 'ok',
        public.test_clt_eval(v_job, v_org, 'FACTURA_A', '20-1', NULL, 50, 'Prov', '0001-1', 0.98, NULL, NULL))
  )
  SELECT r.case_name, r.expected, r.got, (r.expected = r.got) FROM r;

  -- Limpieza: borrar el job de prueba (CASCADE a filas, aunque ya se revirtieron)
  DELETE FROM pdf_jobs WHERE id = v_job;
END $$;
