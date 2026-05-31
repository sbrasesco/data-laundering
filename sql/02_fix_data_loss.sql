-- =============================================================================
-- MIGRACIÓN: Corregir pérdida de datos en el pipeline PDF → Excel
-- =============================================================================
-- Problema principal: la DB tenía columnas sin usar (ia_extra, document_hash)
-- y le faltaban columnas que la IA sí extrae (source_file, cliente, incompleto).
-- Además la columna importe_neto no coincidía con el nombre que usa el frontend
-- y el export Excel (neto_gravado), causando que el Excel siempre saliera vacío.

-- -----------------------------------------------------------------------------
-- 1. Renombrar importe_neto → neto_gravado
--    El JSON de la IA usa "neto_gravado", el frontend también. Solo el insert n8n
--    apuntaba a "importe_neto". Unificamos con el nombre canónico de la IA.
-- -----------------------------------------------------------------------------
ALTER TABLE public.pdf_job_rows
  RENAME COLUMN importe_neto TO neto_gravado;

-- -----------------------------------------------------------------------------
-- 2. Agregar source_file: nombre del PDF original
--    Permite trazar qué fila vino de qué archivo. Imprescindible para reprocessing.
-- -----------------------------------------------------------------------------
ALTER TABLE public.pdf_job_rows
  ADD COLUMN IF NOT EXISTS source_file text;

-- -----------------------------------------------------------------------------
-- 3. Agregar cliente: dato que la IA extrae pero nunca se guardaba
-- -----------------------------------------------------------------------------
ALTER TABLE public.pdf_job_rows
  ADD COLUMN IF NOT EXISTS cliente text;

-- -----------------------------------------------------------------------------
-- 4. Agregar incompleto: flag calculado por la IA, útil para filtros en frontend
-- -----------------------------------------------------------------------------
ALTER TABLE public.pdf_job_rows
  ADD COLUMN IF NOT EXISTS incompleto boolean DEFAULT false;

-- -----------------------------------------------------------------------------
-- 5. ia_extra YA EXISTE como columna jsonb — solo necesitamos empezar a llenarlo
--    desde el workflow n8n (Fix #2 en el workflow).
-- -----------------------------------------------------------------------------
-- NADA que hacer en SQL — la columna existe, el workflow no la usaba.

-- -----------------------------------------------------------------------------
-- 6. document_hash YA EXISTE — idem, solo faltaba popularlo desde n8n.
-- -----------------------------------------------------------------------------
-- NADA que hacer en SQL — la columna existe.

-- -----------------------------------------------------------------------------
-- 7. Índice en source_file para búsquedas por nombre de archivo
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_pdf_job_rows_source_file
  ON public.pdf_job_rows (source_file);

-- -----------------------------------------------------------------------------
-- 8. Índice en document_hash para deduplicación rápida
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_pdf_job_rows_document_hash
  ON public.pdf_job_rows (document_hash);

-- -----------------------------------------------------------------------------
-- 9. Comentarios descriptivos en columnas (trazabilidad)
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN public.pdf_job_rows.ia_extra        IS 'JSON completo devuelto por la IA (sin modificar). Permite reprocesar sin re-extraer.';
COMMENT ON COLUMN public.pdf_job_rows.document_hash   IS 'SHA-256 del raw_ocr_text. Permite detectar duplicados y reprocessar sin re-OCR.';
COMMENT ON COLUMN public.pdf_job_rows.source_file     IS 'Nombre del archivo PDF/imagen original del que se extrajo esta fila.';
COMMENT ON COLUMN public.pdf_job_rows.neto_gravado    IS 'Importe neto gravado (mapeado desde "neto_gravado" en la IA).';
COMMENT ON COLUMN public.pdf_job_rows.raw_ocr_text    IS 'Texto crudo extraído por OCR (Mistral o pdftotext). Fuente para reprocessing.';
COMMENT ON COLUMN public.pdf_job_rows.cliente         IS 'Campo "cliente" extraído por la IA (puede diferir del receptor_nombre).';
COMMENT ON COLUMN public.pdf_job_rows.incompleto      IS 'True si la IA detectó el tipo de documento pero le faltaron campos clave.';

