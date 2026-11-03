-- Additive defaults preserve reservations and payment flows written by the previous release.
ALTER TABLE model_credit_accounts ADD COLUMN "dailyAllowanceMicros" BIGINT
  CHECK ("dailyAllowanceMicros" >= 0);
ALTER TABLE model_credit_entries
  ADD COLUMN "multiplierBps" INTEGER NOT NULL DEFAULT 10000 CHECK ("multiplierBps" BETWEEN 1 AND 1000000),
  ADD COLUMN "providerCostMicros" BIGINT CHECK ("providerCostMicros" >= 0),
  ADD COLUMN "actorId" TEXT,
  ADD COLUMN reason TEXT,
  ADD COLUMN "grantDay" TEXT;
CREATE INDEX "model_credit_entries_grantDay_idx" ON model_credit_entries("grantDay");
CREATE TABLE hosted_credit_policies (
  id TEXT PRIMARY KEY DEFAULT 'deployment' CHECK (id = 'deployment'),
  enabled BOOLEAN NOT NULL DEFAULT false,
  "activatedAt" TIMESTAMP(3),
  "defaultDailyAllowanceMicros" BIGINT NOT NULL DEFAULT 0 CHECK ("defaultDailyAllowanceMicros" >= 0),
  "dailyGrantBudgetMicros" BIGINT NOT NULL DEFAULT 0 CHECK ("dailyGrantBudgetMicros" >= 0),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO hosted_credit_policies(id) VALUES ('deployment');
CREATE TABLE hosted_credit_tariffs (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  "multiplierBps" INTEGER NOT NULL DEFAULT 10000 CHECK ("multiplierBps" BETWEEN 1 AND 1000000),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider,model)
);
GRANT SELECT, INSERT, UPDATE ON hosted_credit_policies,hosted_credit_tariffs TO rakazo_app;
CREATE INDEX "billing_audit_events_daily_grant_day_idx"
 ON billing_audit_events ((details->>'grantDay')) WHERE kind='daily_grant_issued';

-- Attribution and retail terms are immutable even when cost reconciliation changes the debit.
CREATE FUNCTION hosted_credit_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."multiplierBps" IS DISTINCT FROM OLD."multiplierBps"
 OR NEW."actorId" IS DISTINCT FROM OLD."actorId"
 OR NEW.reason IS DISTINCT FROM OLD.reason
 OR NEW."grantDay" IS DISTINCT FROM OLD."grantDay"
 THEN RAISE EXCEPTION 'Hosted credit terms are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hosted_credit_terms_immutable BEFORE UPDATE ON model_credit_entries
 FOR EACH ROW EXECUTE FUNCTION hosted_credit_terms_immutable();

-- Keep operator grants and corrections distinguishable from payment-provider purchases.
CREATE OR REPLACE FUNCTION billing_audit_credit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE delta BIGINT; event_kind TEXT;
BEGIN
 delta := NEW."amountMicros" - CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD."amountMicros" END;
 event_kind := CASE
  WHEN TG_OP='INSERT' AND NEW.pending THEN 'reservation'
  WHEN TG_OP='INSERT' AND NEW.source LIKE 'adjustment:%' THEN 'manual_adjustment'
  WHEN TG_OP='INSERT' AND NEW.source LIKE 'daily:%' THEN 'daily_grant'
  WHEN TG_OP='INSERT' THEN 'purchase'
  WHEN OLD.pending AND NOT NEW.pending THEN 'settlement'
  WHEN NEW.source LIKE 'purchase:%' AND delta < 0 THEN 'refund'
  WHEN delta <> 0 THEN 'correction'
  WHEN NEW.usage IS DISTINCT FROM OLD.usage THEN 'receipt'
  WHEN NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId" THEN 'provider_request'
  ELSE 'reconciliation' END;
 INSERT INTO public.billing_audit_events(source,kind,"organizationId","callId","userId","spaceId",provider,model,"providerRequestId","amountMicros",details)
 VALUES ('credit:'||NEW.id||':'||NEW."auditRevision",event_kind,NEW."organizationId",NEW."callId",NEW."userId",NEW."spaceId",NEW.provider,NEW.model,NEW."providerRequestId",delta,
 jsonb_build_object('entry',to_jsonb(NEW),'previous',CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END));
 RETURN NEW;
END $$;
