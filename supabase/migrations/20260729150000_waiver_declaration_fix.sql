-- Fix the "Declaration and signatures" section of the application form: it
-- unconditionally prints all three age-branch declarations, regardless of who
-- actually signed.
--
-- This templating system has no conditionals, only {{token}} substitution
-- (see src/lib/waiver-document.ts), so `20260729010000_waiver_application_form`
-- shipped three literal headings ("If the applicant is 18 or over", "If the
-- applicant is under 18 (parent or guardian signs)", "Minor participant's
-- acknowledgement (ages 12 to 17)") that print on EVERY signed waiver, adult
-- or minor alike:
--
--   - An adult's PDF gets a "Parent or guardian full name: N/A / Relationship
--     to minor: N/A / Address: <their own address>" consent paragraph, and a
--     "I, the minor applicant, have had the risks explained to me..."
--     declaration carrying their own adult name.
--   - A minor's PDF gets an "If the applicant is 18 or over" heading printed
--     above their own (minor's) name.
--
-- Both false statements end up baked into a signed liability waiver.
--
-- The fix does not need new template machinery: the renderer already draws a
-- correctly age-gated "Parent / guardian consent" section (guardian name,
-- relationship, and the actual guardian signature) entirely in code — see
-- `is_minor` in src/lib/waiver-pdf.ts and src/components/site/WaiverDocument.tsx
-- — independent of anything in body_md. So the three duplicate/wrong headings
-- in the template's own prose collapse into one age-neutral declaration
-- paragraph below; the real per-audience signature blocks still render
-- exactly as before, just without a mismatched heading over them.
--
-- Everything else (participant type checkboxes, applicant/emergency-contact
-- details, health declaration, acknowledgements, terms and conditions,
-- recreational services notice, minor provisions) is unchanged from the
-- version this replaces.
--
-- Ships as a NEW version, is_current = false (a draft): a manager reads it and
-- promotes it at /manager/waiver-template, same as the version it corrects.
-- Nothing about the live signing page changes when this runs.

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

I acknowledge each of the statements ticked on this form.

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

**MARTIAL ARTS IS DANGEROUS.** I certify that all the information provided is true. I have read and understood the terms. Where the applicant is under 18, the parent or legal guardian named above consents to their participation, confirms they have explained the obvious risks to them, and to the full extent permitted by law agrees to indemnify the providers against claims brought by or on behalf of the minor.

The signature below is the applicant's, or for a participant under 18, the applicant's own signature together with their parent or guardian's, given separately below.

Full name: {{signature_name}}
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
  -- Draft. A manager promotes it after reading it; see the note above.
  false
);
