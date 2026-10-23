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
when the send sets `Reply-To`. `sendEmail` takes a **required** `replyTo`, so
every call site decides, and the rule is stated at the top of
`send-email.server.ts`:

- **A manager's copy of an email about a person** carries that person's address,
  because pressing Reply is how a manager answers them: the contact message, the
  new lead, the signed waiver (the guardian first, then the signer, for a
  minor), the membership awaiting payment. Listed in the manager table below.
- **An email to a member or visitor** carries the club's **reply-to address**:
  `email_reply_to` in `club_settings`, set by a manager in the "Replies to club
  emails" card on `/manager/settings` (the agent API can read it but not change
  it). The sender reads it once with `clubReplyTo(admin)`,
  **before** rendering, and hands the same value to the template. Every line
  that says "reply to this email" is rendered through `ReplyOrReachUs`
  (`src/lib/email-templates/reply-or-reach-us.tsx`): with an address it prints
  the reply sentence, and without one it points at the contact page, phone and
  WhatsApp. So an email never promises a reply that reaches nobody, and the
  header and the copy cannot disagree. A failed read of the setting sends the
  email anyway, without a reply-to and with the fallback copy.
- **The comment-reply email carries none.** Somebody pressing Reply on "X
  replied to you" means to answer X, and the email cannot reach them; sending
  that to the committee instead would put a message written for another member
  in the club inbox without the writer knowing.
- **Supabase Auth emails carry none**: the handler cannot set one. None of them
  asks for a reply.

The signing page's "your PDF is not ready" screen follows the same rule: it
says "reply to your confirmation email" only when that email actually went out
with the club's reply-to (`reply_to_confirmation` on the submit result), and
links the contact page otherwise. The member's "how to pay" panel always points
at the contact page.

The club's address can be any address on any domain: only the `From` has to sit
on the sending domain. A dependant's reserved address is refused.

| Email to a member or visitor             | `Reply-To` | Has a "reply to this email" line              |
| ---------------------------------------- | ---------- | --------------------------------------------- |
| Contact acknowledgement                  | Club's     | The footer implies one only when it is set    |
| Interest confirmation                    | Club's     | No                                            |
| Waiver confirmation                      | Club's     | Yes, when the PDF failed                      |
| Account activated                        | Club's     | No: always links the contact form             |
| Membership invoice, item invoice         | Club's     | Yes, and in the "account not published" block |
| Membership receipt, item invoice receipt | Club's     | Yes                                           |
| Confirm your email address               | Club's     | No                                            |
| Daily digest                             | Club's     | No                                            |
| Comment reply                            | None       | No                                            |

## Resending

A manager can send some emails again, from a **Resend** button beside the record
the email was about, or with the agent API's `resend_email`. Both go through
`resendEmail` in `src/lib/email-resend.functions.ts`; the rules are in
`src/lib/email-resend.ts`.

| Kind                   | Button where                                                        | Record           |
| ---------------------- | ------------------------------------------------------------------- | ---------------- |
| `membership_invoice`   | an unpaid membership, on `/manager/memberships` and the person page | the membership   |
| `membership_receipt`   | a paid membership, same places                                      | the membership   |
| `item_invoice`         | an unpaid item invoice, on `/manager/items` and the person page     | the item invoice |
| `item_invoice_receipt` | a paid item invoice, same places                                    | the item invoice |
| `waiver_confirmation`  | a waiver signed on the site, on `/manager/waivers`                  | the waiver       |
| `account_activated`    | the person's live (approved) waiver, on `/manager/waivers`          | the waiver       |
| `email_verification`   | the email card on the person page, while unconfirmed                | the person       |

How it behaves, and why:

- **Rebuilt, never replayed.** Each resend composes the email again from today's
  rows through the same function the original send used
  (`emailMembershipRecord`, `emailItemInvoiceRecord`, `sendWaiverConfirmation`,
  `emailAccountActivated`, `sendVerificationEmail`). So a resent invoice carries
  the **amount owed now and the club's current bank details**, not the ones it
  first went out with; a waiver confirmation a fresh seven-day PDF link (and,
  once approved, says so instead of "a manager will review"); the verification
  and code-of-conduct links freshly minted tokens. A raw token is never stored
  or logged to make resending easier.
- **To the household contact, as it is today.** The guardian, for a child, and
  the address on file now, which may be a corrected one rather than the one
  the first email went to. The button's panel names the address before
  anything is sent.
- **Only the member's copy.** Manager notifications are not resent: the
  manager pressing the button already knows.
- **A key of its own.** The original key plus `:resend:` plus the id of the
  click (`useResilientSubmit`'s `client_submission_id`). Under the original key
  the provider would silently drop it as a duplicate; per click, an automatic
  retry of one press still cannot deliver two copies.
- **The email the button names, or nothing.** The record is checked again at
  the send: if an invoice was paid or cancelled between the panel opening and
  Send (a bank import, another manager), "Resend invoice" sends nothing and
  says why, rather than following the row into a receipt or a "pay this" for
  something cancelled.
- **A membership invoice folds in only its bundled insurance.** The same
  rule as the original enrolment email: this person's active, unpaid,
  charged insurance on the same reference. An undated plan's reference is per
  person, so it also sits on their free trial and any older plan; those are
  never added in.
- **Once a minute per email per record** (per login, for the account email).
  A second press inside the minute is refused and told how long to wait; a
  retry of the same press is let through, and "Try again" after a failure is
  let through however long ago. The one exception is a press whose email
  already went more than a minute ago: the same click id again would go out
  under the same key and be dropped by the provider while reporting "sent",
  so it is refused (`already_sent`) with "press Resend again".
  The marker lives in `club_settings` under `email_resend:<kind>:<record>` (no
  migration), claimed by compare-and-swap so two presses landing together
  cannot both win. It is not given back when a send fails: "Try again" retries
  the same press, which the marker lets through.
- **Refused, with a reason, when it cannot be rebuilt or would be untrue:** no
  address on file (or a child whose guardian has none), a waiver filed from
  paper (no confirmation was ever sent), an invoice since paid or cancelled
  (resend the receipt instead), a receipt with no payment, a free membership,
  an account email for a waiver not approved or a login still locked, a
  verification for an address already confirmed or for a dependant.
- **The account email is about the login.** It says "your account is open,
  sign in with this address", which is true whichever approval opened it, for
  as long as the login is open. So it is offered once per person, on their
  current approved waiver; no record says which waiver's approval sent the
  original, because approving a re-sign while the account is open sends
  nothing.
- **Logged.** `[email-resend] audit` with the kind, record, manager and whether
  it went. No address and no token in the log.

The **code of conduct** link has no email of its own to resend. It rides in the
waiver confirmation, so resending that (for an adult's waiver) sends a fresh
link. For a child, the guardian agrees from the member area.

**Not resendable, deliberately:** emails a person triggers and can simply ask
for again (the contact acknowledgement, the interest confirmation, password
reset and magic link), the daily digest, comment replies, and every manager
notification.

**Proposed, not built:** a "last sent" line on invoices, so a manager can see
an invoice went out (and when) before chasing. That needs somewhere durable to
record every send, original and resend, which is a table and a migration
(`docs/database-changes.md`); the resend markers above are a rate limit, not a
history, and only cover resends.

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

| Email                      | Template                    | Sender function                                             | Recipient                                                       | Trigger                                                                                                                                                                                                                                                                             | `idempotency_key`                                                                      | Rebuildable                                                                                                                                                             |
| -------------------------- | --------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contact acknowledgement    | `contact-confirmation.tsx`  | `sendContactEmails` (`contact-email.server.ts`)             | Whoever wrote in, at the address they typed (never verified)    | Visitor submits `/contact` (`submitContact`)                                                                                                                                                                                                                                        | `contact-sender-<messageId>`                                                           | Yes, from the `contact_messages` row                                                                                                                                    |
| Interest confirmation      | `interest-confirmation.tsx` | `sendInterestEmails` (`interest-email.server.ts`)           | The applicant, at the address they typed                        | Visitor submits `/register-interest` (`submitInterest`)                                                                                                                                                                                                                             | `interest-applicant-<id>`                                                              | With fresh tokens: the waiver link carries a raw `interest` verification token                                                                                          |
| Waiver confirmation        | `waiver-confirmation.tsx`   | `sendWaiverEmails` (`waiver-email.server.ts`)               | The signer; for a child's waiver, the guardian address typed in | Somebody signs `/waiver` (`submitWaiverWithPdf`). A paper waiver filed by a manager or `file_waiver` sends nothing                                                                                                                                                                  | `waiver-member-<waiverId>`                                                             | With fresh tokens: a signed PDF URL that expires, a `waiver` verification token (only while unverified) and a `code_of_conduct` token (never for a child's waiver)      |
| Account activated          | `account-activated.tsx`     | `sendAccountActivatedEmail` (`waiver-email.server.ts`)      | Person (household contact): the guardian, for a child           | A manager approves somebody's **first** waiver at `/manager/waivers` (`setWaiverApproval`), only while their login is still locked. No agent API action approves                                                                                                                    | `account-activated-<waiverId>`                                                         | Yes: nothing in it is single-use                                                                                                                                        |
| Membership invoice         | `membership-payment.tsx`    | `sendMembershipPaymentEmail` (`membership-email.server.ts`) | Person (household contact)                                      | A member picks a plan (`startMembership`); a manager adds one on the person page (`createMembershipForUser`); agent `create_membership` (unless `send_email: false`); a casual credit spent at check-in with no invoice yet (`ensureCasualInvoiceEmailed`). Free plans send nothing | `membership-payment-<id>`                                                              | Yes, and already rebuilt today by `ensureCasualInvoiceEmailed`. Reads the bank details **at send time**, so a rebuild shows the current account, not the one first sent |
| Membership receipt         | `membership-paid.tsx`       | `sendMembershipPaidEmail` (`membership-email.server.ts`)    | Person (household contact)                                      | "Mark as paid" on `/manager/memberships` or the person page; agent `mark_invoice_paid`; bank statement import at `/manager/reconciliation`; check-in guarantee on a paid casual credit. Sent once per payment (`recordMembershipPayment` is compare-and-swap)                       | `membership-paid-<id>`                                                                 | Yes                                                                                                                                                                     |
| Item invoice               | `item-invoice.tsx`          | `sendItemInvoiceEmail` (`membership-email.server.ts`)       | Person (household contact)                                      | A manager raises an item invoice on the person page (`PersonCharges`); agent `create_item_invoice`                                                                                                                                                                                  | `item-invoice-<id>`                                                                    | Yes. Same bank-details caveat as the membership invoice                                                                                                                 |
| Item invoice receipt       | `item-invoice-paid.tsx`     | `sendItemInvoicePaidEmail` (`membership-email.server.ts`)   | Person (household contact)                                      | "Mark as paid" on the person page; agent `mark_item_invoice_paid`; bank statement import                                                                                                                                                                                            | `item-invoice-paid-<id>`                                                               | Yes                                                                                                                                                                     |
| Confirm your email address | `verify-email.tsx`          | `sendVerificationEmail` (`email-verification.server.ts`)    | The person's own login address. Refused for a dependant         | A manager presses "Resend verification" on `/manager/users/<id>` (`manager_resend`); a member presses it on `/account` (`self_resend`); a manager corrects somebody's address (`email_change`)                                                                                      | `verify-<sha256 of the token>`; a manager's resend `verify-<userId>:resend:<click id>` | With fresh tokens, by design: every send mints a new token, so every send has a new key                                                                                 |
| Comment reply              | `comment-reply.tsx`         | `sendReplyNotification` (`notification-email.server.ts`)    | Person (household contact) who was replied to                   | Somebody replies to their blog comment or knowledge base note (`notification-events.server.ts`), if their preferences allow                                                                                                                                                         | `reply-<notificationId>`                                                               | Mostly: the `notifications` row holds the link, and the settings link is a stored token                                                                                 |
| Daily digest               | `notification-digest.tsx`   | `sendDailyDigests` (`notification-email.server.ts`)         | Person (household contact), one per inbox                       | pg_cron at 22:00 UTC → `POST /api/notifications/digest`                                                                                                                                                                                                                             | `digest-<contact>-<day>-<n><hash>`                                                     | Yes, from unstamped `notifications` rows; `docs/notifications.md` owns the rules                                                                                        |
| Insurance reminder         | `insurance-reminder.tsx`    | `sendInsuranceReminders` (`insurance-reminders.server.ts`)  | Person (household contact), one per inbox per end day; names each child | The same morning run, before the digest: 14 days before yearly insurance ends, and on the day it ends. No switch can stop it                                                                                                                                                        | `insurance-<kind>-<contact>-<endDay>-<n><hash>` | Yes, from the `notifications` rows and the membership; `docs/memberships.md`, "When yearly insurance ends", owns the rules                                              |

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
