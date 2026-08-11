-- Business-number sequences.
--
-- Drizzle has no sequence primitive, so these are hand-written. Repositories
-- read them with `SELECT nextval(...)` in nextTicketNo() / nextApplicationNo() /
-- nextInterviewNo() / nextOfferNo().
--
-- WHY: the legacy implementation read a counter from a settings row, added one
-- in JavaScript, and wrote it back — three statements, no lock, no transaction.
-- It survived only because the old data layer accidentally serialised every
-- query. The moment two requests overlapped it produced duplicate offer numbers
-- on documents sent to candidates (Audit #1 F-09). A sequence cannot collide.
--
-- Sequences are intentionally NOT transactional: a rolled-back transaction still
-- consumes its number. A gap in ticket numbers is harmless; a duplicate is not.

CREATE SEQUENCE IF NOT EXISTS "seq_requisition_ticket_no" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "seq_application_no" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "seq_interview_no" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "seq_offer_no" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint

-- Seed the configurable compensation components.
--
-- Taken from the real Arabtec offer letters. These are CONFIGURATION, not
-- policy: HR may add, rename, reorder or deactivate them without a code change.
-- No ratio or derivation is encoded anywhere — the 40/30/30 pattern observed in
-- three sample letters was explicitly rejected as company policy, so every
-- amount is entered by hand and the total is a plain sum.
--
-- `footnote_key` binds a conditional footnote in the letter template: the Area
-- Allowance line and its "linked to service outside Cairo" note appear together
-- or not at all (verified against a letter that omits both).

INSERT INTO "offer_compensation_component"
  ("code", "tenant_id", "label_en", "label_ar", "display_order", "footnote_key", "active")
VALUES
  ('BASIC_SALARY',   1, 'Basic Salary',   'الراتب الأساسي', 10, NULL,             true),
  ('ACCOMMODATION',  1, 'Accommodation',  'بدل سكن',        20, NULL,             true),
  ('TRANSPORTATION', 1, 'Transportation', 'بدل انتقالات',   30, NULL,             true),
  ('OTHERS',         1, 'Others',         'أخرى',           40, 'others',         true),
  ('AREA_ALLOWANCE', 1, 'Area Allowance', 'بدل موقع',       50, 'area_allowance', true)
ON CONFLICT ("code") DO NOTHING;
