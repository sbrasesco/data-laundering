-- =============================================
-- TASK-60: MercadoPago — payments table + billing_plans update
-- =============================================

-- 1. Add flat price column to billing_plans
ALTER TABLE billing_plans ADD COLUMN IF NOT EXISTS price numeric;

-- 2. Deactivate old plans (Entry/Mid/Pro) — no data loss, FKs still valid
UPDATE billing_plans SET active = false WHERE name IN ('entry', 'mid', 'pro');

-- 3. Insert TASK-58 plans (idempotent via ON CONFLICT DO NOTHING)
INSERT INTO billing_plans (name, display_name, docs_included, price_per_doc, price, currency, active)
VALUES
  ('free',         'Gratuito',     20,   0.00, 0,   'USD', true),
  ('basico',       'Básico',       200,  0.30, 60,  'USD', true),
  ('profesional',  'Profesional',  600,  0.27, 162, 'USD', true),
  ('business',     'Business',     1000, 0.22, 220, 'USD', true),
  ('enterprise',   'Enterprise',   0,    0.00, NULL,'USD', true)
ON CONFLICT DO NOTHING;

-- 4. Create payments table
CREATE TABLE IF NOT EXISTS public.payments (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_id               uuid        REFERENCES public.billing_plans(id),
  amount                numeric     NOT NULL,
  currency              text        NOT NULL DEFAULT 'USD',
  gateway               text        NOT NULL DEFAULT 'mercadopago',
  gateway_payment_id    text,
  gateway_preference_id text,
  status                text        NOT NULL DEFAULT 'pending',
  metadata              jsonb,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_gateway_payment_id_idx
  ON payments(gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_gateway_preference_id_idx
  ON payments(gateway_preference_id)
  WHERE gateway_preference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_organization_id_idx
  ON payments(organization_id);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_view_payments" ON payments
  FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM profiles WHERE id = auth.uid()
    )
  );

COMMENT ON TABLE payments IS 'Registro de pagos procesados via pasarela (MercadoPago). TASK-60 (2026-06-04).';
