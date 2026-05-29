-- Migration: 20260529000003_create_tenant_feature_flags
-- TASK-13: Feature flags por tenant (Fase 2 — Modo Sombra)
-- Corrección vs plan original: tenant_id → organization_id, tenants → organizations
--
-- Rollback: UPDATE tenant_feature_flags SET use_worker_pipeline = false (< 30 segundos)
-- No requiere deploy de código.

CREATE TABLE IF NOT EXISTS public.tenant_feature_flags (
  organization_id       uuid        PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  use_worker_pipeline   boolean     NOT NULL DEFAULT false,
  use_billing_credits   boolean     NOT NULL DEFAULT false,
  worker_concurrency    integer     NOT NULL DEFAULT 3,
  updated_at            timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE tenant_feature_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_flags_select_by_org" ON tenant_feature_flags
  FOR SELECT TO authenticated
  USING (
    organization_id = (SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid())
  );

CREATE POLICY "tenant_flags_update_by_org" ON tenant_feature_flags
  FOR UPDATE TO authenticated
  USING (
    organization_id = (SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid())
  )
  WITH CHECK (
    organization_id = (SELECT p.organization_id FROM profiles p WHERE p.id = auth.uid())
  );

-- Insertar todas las organizaciones existentes con flags desactivados (safe default)
INSERT INTO public.tenant_feature_flags (organization_id)
SELECT id FROM public.organizations
ON CONFLICT (organization_id) DO NOTHING;
