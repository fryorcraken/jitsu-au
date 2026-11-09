-- Contact-form senders become leads a club message can reach.
-- Product rules: docs/club-messages.md ("Who gets one").
--
-- WHAT CHANGES, all additive:
--
-- 1. `contact_messages.promotion_consent`: the contact form gains the same
--    optional, unticked "Keep me posted about club events and offers" box the
--    interest form has (20261108000000_club_messages.sql). Nothing sends
--    promotions yet. The anon insert policy is untouched: the column is a plain
--    boolean the visitor chooses, defaulting to false, and the existing INSERT
--    grant covers it.
--
-- 2. `club_message_lead_recipients` can now point at a contact message instead
--    of an interest registration. Exactly one of the two is set (a CHECK), each
--    with its own unique index per message, and each foreign key CASCADES, so
--    deleting the lead (which now deletes their contact messages too) takes
--    the record of what they were sent with it. Still no address stored here.
--
-- GRANTS. Unchanged: both tables keep exactly what they had, and nothing here
-- touches `anon` or `authenticated`.
--
-- SEQUENCING. Additive, so it goes live BEFORE the code that uses it
-- (docs/database-changes.md). The code running today never writes either new
-- column, and every existing recipient row has its registration set, so the new
-- CHECK holds for them.

ALTER TABLE public.contact_messages
  ADD COLUMN promotion_consent BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.club_message_lead_recipients
  ALTER COLUMN interest_registration_id DROP NOT NULL,
  ADD COLUMN contact_message_id UUID
    REFERENCES public.contact_messages(id) ON DELETE CASCADE,
  ADD CONSTRAINT club_message_lead_recipients_one_source CHECK (
    (interest_registration_id IS NULL) <> (contact_message_id IS NULL)
  ),
  ADD CONSTRAINT club_message_lead_recipients_message_contact_key
    UNIQUE (message_id, contact_message_id);

CREATE INDEX club_message_lead_recipients_contact_idx
  ON public.club_message_lead_recipients (contact_message_id);
