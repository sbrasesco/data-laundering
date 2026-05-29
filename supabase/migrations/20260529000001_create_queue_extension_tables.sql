-- Migration: 20260529000001_create_queue_extension_tables
-- TASK-5: Tablas de extensión para arquitectura de cola
-- Fase 1 — Infraestructura Cola
--
-- Correcciones vs plan original en Notion:
--   - tenant_id → organization_id (consistencia con schema existente)
--   - tenants(id) → organizations(id)
--   - RLS usa patrón estándar con subquery en profiles
--   - worker_events incluye organization_id (requerido por Architecture Rules)
--   - Escrituras solo vía service_role (Worker); SELECT disponible para authenticated

-- ─── queue_jobs ─────────────────────────────────────────────────────────────
-- Espejo persistente en DB de los jobs encolados en BullMQ/Redis.
-- El Worker escribe aquí para trazabilidad. El frontend puede leer el estado.

CREATE TABLE IF NOT EXISTS public.queue_jobs (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pdf_job_id      uuid        REFERENCES pdf_jobs(id) ON DELETE SET NULL,

  status          text        NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued','processing','completed','failed','dead')),
  priority        integer     NOT NULL DEFAULT 5,
  attempts        integer     NOT NULL DEFAULT 0,
  max_attempts    integer     NOT NULL DEFAULT 3,

  worker_id       text,
  worker_version  text,

  payload         jsonb       NOT NULL,  -- snapshot del QueueJob de BullMQ
  result          jsonb,                 -- output del sub-workflow n8n
  last_error      text,

  queued_at       timestamptz DEFAULT now() NOT NULL,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS queue_jobs_org_status   ON queue_jobs (organization_id, status);
CREATE INDEX IF NOT EXISTS queue_jobs_pdf_job_id   ON queue_jobs (pdf_job_id);
CREATE INDEX IF NOT EXISTS queue_jobs_queued_at    ON queue_jobs (queued_at DESC);
CREATE INDEX IF NOT EXISTS queue_jobs_status       ON queue_jobs (status);

ALTER TABLE queue_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "queue_jobs_select_by_org" ON queue_jobs
  FOR SELECT TO authenticated
  USING (
    organization_id = (SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid())
  );

-- ─── worker_events ───────────────────────────────────────────────────────────
-- Log estructurado de eventos emitidos por el Worker.
-- Complementa workflow_logs (eventos de n8n) con eventos del lado del Worker.

CREATE TABLE IF NOT EXISTS public.worker_events (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  queue_job_id    uuid        REFERENCES queue_jobs(id) ON DELETE CASCADE,
  organization_id uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  event           text        NOT NULL,  -- e.g. 'job.dequeued', 'job.calling_n8n', 'job.retry'
  duration_ms     integer,
  metadata        jsonb,
  error           text,

  created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS worker_events_queue_job_id  ON worker_events (queue_job_id);
CREATE INDEX IF NOT EXISTS worker_events_org_created   ON worker_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS worker_events_event         ON worker_events (event);

ALTER TABLE worker_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "worker_events_select_by_org" ON worker_events
  FOR SELECT TO authenticated
  USING (
    organization_id = (SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid())
  );
