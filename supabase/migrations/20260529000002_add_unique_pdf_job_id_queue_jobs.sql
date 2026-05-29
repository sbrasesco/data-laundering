-- Migration: 20260529000002_add_unique_pdf_job_id_queue_jobs
-- TASK-28: UNIQUE constraint en queue_jobs.pdf_job_id
-- Necesario para hacer UPSERT por pdf_job_id desde el Worker (1:1 con pdf_jobs)

ALTER TABLE public.queue_jobs
  ADD CONSTRAINT queue_jobs_pdf_job_id_unique UNIQUE (pdf_job_id);
