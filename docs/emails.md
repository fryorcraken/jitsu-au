# Emails

Every email the club sends, who it goes to, what sends it, where a reply to it
goes, and whether it could be put back together later from the database alone.

> Read this before adding an email, changing who one goes to, or touching
> `src/lib/send-email.server.ts`. The product rules of each flow stay in that
> flow's own doc (`docs/waivers.md`, `docs/memberships.md`,
> `docs/notifications.md`, `docs/item-invoices.md`, ...); this file is only the
> map.

## One way to send

Every email goes out through **`sendEmail`** in `src/lib/send-email.server.ts`,
and every email is signed by the identity in `src/lib/email-sender.ts`:

- **From:** `UTS Jitsu <noreply@notify.jitsu.au>`. `notify.jitsu.au` is the
  sending domain (Mailgun, via Lovable), and the `From` address has to sit on it
  so DKIM and SPF align under DMARC. It stays on `jitsu.au` even though the site
  itself moved to `utsjitsu.com.au`: it moves only if the sending setup moves
  with it.
- **Name:** `SITE_NAME` ("UTS Jitsu"), used in subjects and greetings.
- **Links:** built on `SITE_ORIGIN` from `src/lib/seo.ts`, the site's one
  canonical origin.
- **Purpose:** always `transactional`. Nothing the club sends is marketing.
- **Manager recipients:** `getManagerEmails` (`manager-recipients.server.ts`), every holder of the `manager`
  role at their login address, shared by the four flows that tell managers
  something.

What an email says, who it is about and its idempotency key stay in the email's
own module, next to the flow that sends it. One transport, not one giant file.

`scripts/email-conventions.test.ts` holds that line: nothing under `src/` but
`send-email.server.ts` may load `@lovable.dev/email-js` (the auth webhook may
load `createAuthEmailHandler` and nothing else), and the sending domain and the
club's email name are each spelled once, in `email-sender.ts`.

**The auth emails are the one exception to `sendEmail`.** Supabase Auth calls
`/lovable/email/auth/webhook`, and Lovable's `createAuthEmailHandler` sends from
inside its own code. That route still takes its `From`, sending domain and name
from `email-sender.ts`. The handler offers no Reply-To option.

**Best-effort, everywhere.** A failed send is caught by its caller and logged,
never thrown into the flow that triggered it: a waiver is saved, a payment is
recorded, a membership is raised whether or not the email about it lands.

**Without `LOVABLE_API_KEY`** each sender logs a skip and sends nothing. Most do
so before any other work; the daily digest reads its pending rows first, on
purpose, so it can still report how much was owed.

## Where a reply goes

Mail comes from `noreply@`, which nobody reads, so a reply reaches a person only
when the send sets `Reply-To`. The rule, stated at the top of
`send-email.server.ts`:

- **A manager's copy of an email about a person** carries that person's address,
  because pressing Reply is how a manager answers them: the contact message, the
  new lead, the signed waiver (the guardian first, then the signer, for a
  minor), the membership awaiting payment. Listed in the table below.
- **An email to a member or visitor carries none.** A reply to an invoice, a
  receipt or a waiver confirmation therefore reaches nobody today, even where the
  email says "reply to this email". That is a known gap, not a decision to keep.
- **Supabase Auth emails carry none**: the handler cannot set one.

## Who an email is addressed to

A dependant (somebody on another person's account, usually a child) has no
mailbox. Their login address is a reserved, non-deliverable
`<uuid>@dependant.jitsu.au`, and nothing may ever send to it. Every email about
a dependant goes to their **guardian**, greets the guardian and names the child
(`forName` / `dependantName`). The one place that rule is resolved is
`src/lib/household-email.ts` (`deliveryRecipientFor`, `deliveryEmailFor`);
never resolve an address any other way. "Person (household contact)" below
means exactly that.

## Inventory

**Rebuildable** answers one question: could this exact email be composed again
later, from database rows alone? "Yes" means everything in it is stored.
"With fresh tokens" means it carries something that only existed at send time
(a raw token whose hash is all we store, or a signed URL that has since
expired), so composing it again means minting a new one. "No" means it carries
something we never stored at all.

### Member and visitor emails

| Email                      | Template                    | Sender function                                             | Recipient                                                       | Trigger                                                                                                                                                                                                                                                                             | `idempotency_key`                  | Rebuildable                                                                                                                                                             |
| -------------------------- | --------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contact acknowledgement    | `contact-confirmation.tsx`  | `sendContactEmails` (`contact-email.server.ts`)             | Whoever wrote in, at the address they typed (never verified)    | Visitor submits `/contact` (`submitContact`)                                                                                                                                                                                                                                        | `contact-sender-<messageId>`       | Yes, from the `contact_messages` row                                                                                                                                    |
| Interest confirmation      | `interest-confirmation.tsx` | `sendInterestEmails` (`interest-email.server.ts`)           | The applicant, at the address they typed                        | Visitor submits `/register-interest` (`submitInterest`)                                                                                                                                                                                                                             | `interest-applicant-<id>`          | With fresh tokens: the waiver link carries a raw `interest` verification token                                                                                          |
| Waiver confirmation        | `waiver-confirmation.tsx`   | `sendWaiverEmails` (`waiver-email.server.ts`)               | The signer; for a child's waiver, the guardian address typed in | Somebody signs `/waiver` (`submitWaiverWithPdf`). A paper waiver filed by a manager or `file_waiver` sends nothing                                                                                                                                                                  | `waiver-member-<waiverId>`         | With fresh tokens: a signed PDF URL that expires, a `waiver` verification token (only while unverified) and a `code_of_conduct` token (never for a child's waiver)      |
| Account activated          | `account-activated.tsx`     | `sendAccountActivatedEmail` (`waiver-email.server.ts`)      | Person (household contact): the guardian, for a child           | A manager approves somebody's **first** waiver at `/manager/waivers` (`setWaiverApproval`), only while their login is still locked. No agent API action approves                                                                                                                    | `account-activated-<waiverId>`     | Yes: nothing in it is single-use                                                                                                                                        |
| Membership invoice         | `membership-payment.tsx`    | `sendMembershipPaymentEmail` (`membership-email.server.ts`) | Person (household contact)                                      | A member picks a plan (`startMembership`); a manager adds one on the person page (`createMembershipForUser`); agent `create_membership` (unless `send_email: false`); a casual credit spent at check-in with no invoice yet (`ensureCasualInvoiceEmailed`). Free plans send nothing | `membership-payment-<id>`          | Yes, and already rebuilt today by `ensureCasualInvoiceEmailed`. Reads the bank details **at send time**, so a rebuild shows the current account, not the one first sent |
| Membership receipt         | `membership-paid.tsx`       | `sendMembershipPaidEmail` (`membership-email.server.ts`)    | Person (household contact)                                      | "Mark as paid" on `/manager/memberships` or the person page; agent `mark_invoice_paid`; bank statement import at `/manager/reconciliation`; check-in guarantee on a paid casual credit. Sent once per payment (`recordMembershipPayment` is compare-and-swap)                       | `membership-paid-<id>`             | Yes                                                                                                                                                                     |
| Item invoice               | `item-invoice.tsx`          | `sendItemInvoiceEmail` (`membership-email.server.ts`)       | Person (household contact)                                      | A manager raises an item invoice on the person page (`PersonCharges`); agent `create_item_invoice`                                                                                                                                                                                  | `item-invoice-<id>`                | Yes. Same bank-details caveat as the membership invoice                                                                                                                 |
| Item invoice receipt       | `item-invoice-paid.tsx`     | `sendItemInvoicePaidEmail` (`membership-email.server.ts`)   | Person (household contact)                                      | "Mark as paid" on the person page; agent `mark_item_invoice_paid`; bank statement import                                                                                                                                                                                            | `item-invoice-paid-<id>`           | Yes                                                                                                                                                                     |
| Confirm your email address | `verify-email.tsx`          | `sendVerificationEmail` (`email-verification.server.ts`)    | The person's own login address. Refused for a dependant         | A manager presses "Resend verification" on `/manager/users/<id>` (`manager_resend`); a member presses it on `/account` (`self_resend`); a manager corrects somebody's address (`email_change`)                                                                                      | `verify-<sha256 of the token>`     | With fresh tokens, by design: every send mints a new token, so every send has a new key                                                                                 |
| Comment reply              | `comment-reply.tsx`         | `sendReplyNotification` (`notification-email.server.ts`)    | Person (household contact) who was replied to                   | Somebody replies to their blog comment or knowledge base note (`notification-events.server.ts`), if their preferences allow                                                                                                                                                         | `reply-<notificationId>`           | Mostly: the `notifications` row holds the link, and the settings link is a stored token                                                                                 |
| Daily digest               | `notification-digest.tsx`   | `sendDailyDigests` (`notification-email.server.ts`)         | Person (household contact), one per inbox                       | pg_cron at 22:00 UTC → `POST /api/notifications/digest`                                                                                                                                                                                                                             | `digest-<contact>-<day>-<n><hash>` | Yes, from unstamped `notifications` rows; `docs/notifications.md` owns the rules                                                                                        |

The **code of conduct** link has no email of its own. It rides in the waiver
confirmation, as a `code_of_conduct` token that identifies the signer but, by
design, never proves the mailbox (`mailboxProvingPurposes` in
`src/lib/email-verification.ts`).

### Manager notifications

Each goes to every manager (`getManagerEmails`), one send per manager, and
carries the person it is about as `Reply-To` (see "Where a reply goes" above).

| Email                  | Template                      | Sender function              | Trigger                        | `Reply-To`                                                      | `idempotency_key`                  | Rebuildable                 |
| ---------------------- | ----------------------------- | ---------------------------- | ------------------------------ | --------------------------------------------------------------- | ---------------------------------- | --------------------------- |
| New contact message    | `contact-notification.tsx`    | `sendContactEmails`          | `/contact` submitted           | Whoever wrote in                                                | `contact-manager-<messageId>-<to>` | Yes                         |
| New free-trial lead    | `interest-notification.tsx`   | `sendInterestEmails`         | `/register-interest` submitted | The lead                                                        | `interest-manager-<id>-<to>`       | Yes                         |
| New waiver signed      | `waiver-notification.tsx`     | `sendWaiverEmails`           | `/waiver` signed               | The guardian then the signer, for a minor; the signer otherwise | `waiver-manager-<waiverId>-<to>`   | With a fresh signed PDF URL |
| New membership pending | `membership-notification.tsx` | `sendMembershipPaymentEmail` | Every membership invoice above | The invoiced address (the guardian's, for a child)              | `membership-pending-<id>-<to>`     | Yes                         |

### Supabase Auth emails

Sent by `src/routes/lovable/email/auth/webhook.ts` when Supabase Auth asks:
`signup.tsx`, `invite.tsx`, `magic-link.tsx`, `recovery.tsx`,
`email-change.tsx`, `reauthentication.tsx`. To whoever Supabase names. The SDK
owns retries and idempotency. **Not rebuildable**: each carries a one-time link
or code that only Supabase holds, and a person who needs another asks for it
again (`/auth`).
