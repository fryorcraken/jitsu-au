-- The waiver becomes the club's full application form.
--
-- Two additions, both additive (nothing is dropped or renamed, so the
-- currently-deployed code keeps working):
--
--   1. `emergency_contact_relationship` on `waivers` and `profiles` — the form
--      asks how the emergency contact is related. For a participant under 18
--      that contact IS the parent/guardian who signs, so the same value is the
--      "relationship to minor" on the signed document.
--   2. A new template version carrying the application form text: participant
--      type, applicant details, emergency contact, health declaration, terms
--      and conditions, the Australian Consumer Law s139A recreational services
--      notice, the minor provisions, and the declaration blocks.
--
-- The five health questions get NO columns. They are answered yes/no on the
-- form and printed into the signed PDF, which is the record, exactly like the
-- acknowledgement ticks (docs/waivers.md rule 3). Anything the signer needs to
-- explain goes in the existing `medical_notes`, which the form now requires as
-- soon as any answer is yes.
--
-- No grant changes: adding a column to an existing table inherits that table's
-- privileges, and no new table is created here.

-- ---------- columns ----------

ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS emergency_contact_relationship TEXT;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS emergency_contact_relationship TEXT;

-- ---------- the application form template ----------
--
-- A NEW version, not an edit of the current one: every already-signed waiver
-- keeps pointing at the template version it was actually signed against.

UPDATE public.waiver_templates SET is_current = false WHERE is_current = true;

INSERT INTO public.waiver_templates (version, title, body_md, acknowledgements, is_current)
VALUES (
  (SELECT COALESCE(MAX(version), 0) + 1 FROM public.waiver_templates),
  'UTS Jitsu Application Form',
  $md$# UTS Jitsu Application Form

Affiliated to Sydney Jitsu Inc

## Participant type

{{adult_checkbox}} Adult (18+), primary applicant
{{minor_checkbox}} Minor (under 18), requires guardian consent

## Applicant details

Full name: {{full_name}}
Date of birth: {{date_of_birth}}
Mobile: {{phone}}
Email: {{email}}
Address: {{address}}

## Emergency contact / guardian (required for minors)

Name: {{emergency_contact_name}}
Relationship: {{emergency_contact_relationship}}
Mobile: {{emergency_contact_phone}}

## Health declaration

Is the participant prescribed any drugs which may impair reaction time or judgement?
{{health_drugs}}

Has the participant, within the past 5 years, suffered any blackout, seizure, convulsion, fainting or dizzy spells, or any incapacity that would render it unsafe to participate in martial arts?
{{health_blackouts}}

Is the participant fitted with any electronic device or shunt?
{{health_device}}

Does the participant have any current physical impairment, injuries or medical conditions (for example back injuries, weak ankles)?
{{health_impairments}}

Is there any other medical information or health needs our instructors should be aware of for the participant's safety?
{{health_other}}

Details of anything answered yes:
{{medical_notes}}

**Privacy note:** I consent to the collection and use of the health information provided above solely for the purpose of ensuring my safety (or the safety of the minor) during training.

## Acknowledgement

I acknowledge each of the statements ticked on this form, and I initial them here: {{initials}}

---

# Terms and conditions

**WARNING: MARTIAL ARTS IS A DANGEROUS RECREATIONAL ACTIVITY.** The following conditions must be read carefully.

Applicants are advised that Japanese Jiu-Jitsu involves physical, and at times full body, contact between participants, as well as the use of training weapons. Classes include strenuous physical activity. Accordingly, the school and its instructors advise that anyone enrolling does so at their own risk.

While taking all possible care, neither the school nor its instructors will be held responsible for any damage and/or injury occurring as a result of training. It is the student's (or parent's) responsibility to advise the school of any illness or disability. No students are forced to take part in any activity they do not feel confident performing.

The school reserves the right to refuse admission to any person who poses a danger to themselves or others.

## Contract terms

**1. Interpretation.** "The Applicant" means the individual signing this Contract, and includes a guardian if the individual is under 18.

**2. Acceptance.** The Applicant agrees to be bound by the terms with {{club_name}} and Sydney Jitsu Inc ("the providers").

**(a) Club fees.** The Applicant will pay the prescribed fees as notified by letter, notice, or verbal instruction.

**(b) Invitation-only sessions.** Supplementary sessions are designated as "invitation-only" and:
- are not included in regular membership fee calculations;
- are offered at the sole discretion of the providers;
- may be cancelled without notice, and are not eligible for refunds or credits.

**(c) Session cancellations.**
If a regular session is cancelled, the providers will use reasonable endeavours to offer a makeup session.
Where the number of cancelled regular sessions in a single semester exceeds four (4), the Applicant is entitled to a pro-rata credit toward future fees for each subsequent cancelled session.
Credits must be claimed within 60 days of the end of the semester, and are not redeemable for cash.

**(d) Summer closure period.** {{club_name}} closes between the end of the Spring exam period and the start of Autumn Orientation (mid-December to early February). No credits or refunds apply to this scheduled closure.

**(e) Medical conditions.** The Applicant warrants that they have not suffered blackouts or seizures in the last 5 years, and are not receiving treatment that makes training unsafe.

**(f) Rights of a consumer.** Under the Australian Consumer Law or the Fair Trading Act 1987 (NSW), certain rights cannot be excluded. Liability for breach of these warranties is limited to re-supplying the service, or paying the cost of having the service supplied again.

**(g) Waiver and indemnity.** Except where inconsistent with the Australian Consumer Law, the Applicant indemnifies the providers from all liability for injury or damage (including negligence) arising from participation or use of the facilities. I acknowledge that martial arts is a "dangerous recreational activity" under Section 5K of the Civil Liability Act 2002 (NSW), and I voluntarily assume the obvious risks inherent in such activity.

**(h) Martial arts not to be taught by the Applicant.** The Applicant is not authorised to teach {{club_name}} publicly or privately for gain without written authorisation.

**(i) Code of conduct.** The Applicant agrees to abide by the {{club_name}} Code of Conduct. Failure to do so may result in expulsion.

**(j) Governing law.** This agreement is governed by the laws of New South Wales.

**(k) Electronic execution.** This agreement is executed in accordance with the Electronic Transactions Act 2000 (NSW).

**(l) Personal property.** The providers are not liable for damage to clothing or jewellery (which should not be worn), or for the loss of personal items left on the premises.

---

# Recreational services notice

Australian Consumer Law, section 139A.

**Your rights.** The supplier must ensure services are rendered with due care and skill, and are reasonably fit for purpose. Under section 139A, the supplier is entitled to ask you to agree that these statutory guarantees do not apply to you. By signing this form, you agree that your rights to sue the supplier if you are killed or injured (because the services were not provided with due care and skill) are excluded, restricted or modified as set out below.

**Exclusion of liability.** By signing, I agree that the liability of {{club_name}} and Sydney Jitsu Inc for death, physical or mental injury, or disease resulting from the supply of recreational services is excluded to the full extent permitted by law.

**Limitation.** This exclusion does not apply to "reckless conduct", defined as conduct where the supplier was aware (or should have been aware) of a significant risk and engaged in it without justification.

## Additional provisions for minor participants

Where the Applicant is under 18, the parent or legal guardian:
- consents to the minor participating;
- acknowledges that they have explained the obvious risks to the minor;
- to the full extent permitted by law, agrees to indemnify the providers against claims brought by or on behalf of the minor.

---

# Declaration and signatures

**MARTIAL ARTS IS DANGEROUS.** I certify that all the information provided is true. I have read and understood the terms.

## If the applicant is 18 or over

Full name: {{signature_name}}
Date: {{signed_date}}

## If the applicant is under 18 (parent or guardian signs)

I, the undersigned, am the parent or legal guardian of the minor applicant named above. I have read this document, explained the risks to the minor, and I sign this agreement for and on behalf of the minor and as a personal guarantee of the minor's obligations.

Parent or guardian full name: {{guardian_name}}
Relationship to minor: {{guardian_relationship}}
Address: {{address}}
Date: {{signed_date}}

## Minor participant's acknowledgement (ages 12 to 17)

I, the minor applicant, have had the risks of martial arts explained to me. I agree to follow the club rules and the Code of Conduct, and I understand that training involves physical contact and risks.

Name: {{full_name}}
Date: {{signed_date}}
$md$,
  $json$[
    {
      "id": "read",
      "label": "I have been given a reasonable opportunity to read this document in full before signing.",
      "required": true
    },
    {
      "id": "legal_advice",
      "label": "I have been advised that I may seek independent legal advice before signing.",
      "required": true
    },
    {
      "id": "questions",
      "label": "I have had the opportunity to ask questions about any terms I do not understand.",
      "required": true
    },
    {
      "id": "voluntary",
      "label": "I am signing this document freely and voluntarily.",
      "required": true
    },
    {
      "id": "health_privacy",
      "label": "I consent to the collection and use of the health information I have given above, solely to keep me (or the minor) safe during training.",
      "required": true
    },
    {
      "id": "recreational_services",
      "label": "I have read and understood the Recreational Services Notice, and I agree that my rights to sue {{club_name}} and Sydney Jitsu Inc are excluded, restricted or modified as set out in it.",
      "required": true
    },
    {
      "id": "truth",
      "label": "I certify that everything I have provided is true, and I have read and understood the terms of this agreement.",
      "required": true
    }
  ]$json$::jsonb,
  true
);
