# Club messages

A manager writes one email and sends it to the people they tick, from
`/manager/messages` (or an agent, through the manager agent API). Today there
is one kind, the **club notice**: a closure, a time change, a venue move.
Promotions are the second kind and have not shipped.

> Read this before changing who a message reaches, what it says at the bottom,
> or how it is sent. The code is `src/lib/club-message.ts` (the rules),
> `src/lib/club-message.server.ts` (the sending), `src/lib/club-message.functions.ts`
> (the screen's gates) and `src/routes/_authenticated/manager.messages.tsx`.

## The two kinds, and why there are two

Under Australia's Spam Act, an email that holds **only factual information**
(plus who sent it) is a "designated commercial electronic message": it needs
no consent and no unsubscribe link, only clear sender identification. An email
that promotes anything, even in one line, needs consent and a working
unsubscribe.

- **Club notice** (shipped). Facts about training only. It may not ask anybody
  to buy or join anything; the screen and the agent manifest both say so. It
  reaches members whatever their email switches say: `club_notice` is in
  `UNSWITCHABLE_NOTIFICATION_KINDS`, the same as an invoice.
- **Promotion** (not built). Events, gradings, offers. Members will get a
  "Club promotions" switch, on by default; leads only if they ticked the
  interest form's box (below). It will be sent through Resend on its own
  sending address, not through the club's email service (see "How it is
  sent").

## Who gets one

Each group, and the leads, is a tick box for the whole list with the people
folded away underneath ("Choose who, one by one"), closed by default. Everybody
in a group starts ticked; a manager opens a list only to untick somebody, or to
tick an older lead. The count on the screen is the server's
(`countClubMessageAudience`), asked again on every tick, and it is the number
the confirm repeats.

- **Members**, **Visitors**, **Lapsed members**, **Applicants**: a person's
  group is their funnel phase (`deriveLifecycleStatus`, through
  `aggregateClubUsers`), so the lists agree with the users page. Visitors and
  lapsed members are separate on purpose: somebody whose trial is over and who
  has not joined yet is told something different from somebody who was paying
  and did not renew. The funnel itself calls both "lapsed" once a membership
  has ended, a free trial included, so the message's groups correct it: lapsed
  only counts somebody who ever held a paid membership (`groupForPerson`), and
  a finished trial stays a visitor.
- **What is sent.** A group ticked in full is sent as the group; a group with
  somebody unticked is sent as the people kept (`choiceFromTicks`). So the
  history can say "Members", and a person ticked one by one is still reached
  only while they are in some group: naming the id of a lead, or of somebody
  who has left, reaches nobody.
- **Leads**: everybody who filled in the interest form or wrote in through the
  contact form and has no person record, one row per address across both forms,
  the newest entry standing for it. Those whose newest entry is from the last
  90 days (`LEAD_PRESELECT_DAYS`) start ticked. An address that now belongs to
  a person is not a lead: they get the message as that person if they are
  ticked. The users page lists the same leads, labelling the contact-form ones.
- **One inbox, one email.** A family is one email to the parent, naming the
  children it is about, the same fold the plan announcement makes. A child's
  row in the list says whose inbox it goes to.
- **Nobody who has left.** An archived person is never listed or included, and
  nor is a family whose account holder is archived.

## Sending

- **Test first.** "Send me a test" emails the manager's own address, marked as a
  test. Nothing is recorded.
- **The confirm says the real number**: `Email 23 people about "..."?`, with a
  line per group, and "This can't be undone."
- **One message, one id.** The screen mints the id (`useResilientSubmit`'s
  submission id) and keeps it through automatic retries, "Try again" and "Send
  the rest now", so nobody is emailed twice. The id with different words is
  refused (`submission_conflict`). Editing after a failure starts a new message.
- **The list is frozen by the first call.** It records the message, writes one
  `notifications` row per inbox and one `club_message_lead_recipients` row per
  lead, then stamps `recipients_written_at`. Later calls only send what is
  still unsent, to the same people.
- **Up to 150 a request**, ten at a time (the plan announcement's bounds), people
  first, then leads. Anything left is pending: the screen offers "Send the rest
  now" (on the screen straight after sending, and on the message's own page in
  the history, which finishes it by id with the words on record), and the
  morning summary sends the people's rows under "From the club". Leads have no
  summary, so a lead still pending needs "Send the rest now".
- **A send that reaches nobody is refused before anything is recorded**
  (`no_recipients`), so it never appears in the history.
- **What the email says.** The subject, a greeting (naming the child for a
  parent), the manager's words rendered from markdown with inline styles, a
  reply line (`ReplyOrReachUs`: replies go to the club's reply-to address), and
  a closing line: "This is a club notice from UTS Jitsu about training" for a
  person, "You're getting this because you asked about training at UTS Jitsu"
  for a lead. Raw HTML is dropped and a picture is shown as its words, so a
  notice never makes a mail client fetch anything.
- **The members' copy** is on `/notifications`, linking to `/messages/<id>`, which
  opens only for an inbox the message was sent to.
  An applicant's login is still locked, so they cannot open that page: their
  email carries the whole message, and if it fails to send, the morning
  summary gives them the first 300 characters and a link they cannot use yet.

## How it is sent, and why

Notices go through **Lovable Emails** (`sendEmail`), the same service as every
other club email. Lovable was asked on 2026-11-08 and said, in summary:

- It is meant for one-person emails set off by something the person did.
  Sending to a list is outside its rules, and promotions are not allowed at all.
- The workspace is capped at **100 emails an hour** on Pro, shared with invoices
  and receipts (sign-in emails have their own allowance).
- Every email carries Lovable's own unsubscribe footer, and an address that uses
  it stops getting every app email, invoices included. It does not allow a
  second unsubscribe link of ours.

The club owner chose to send notices this way anyway, because the club is small:
23 people on 2026-11-08, so a full send is a couple of dozen emails and leaves
the hourly allowance for invoices. Two consequences follow:

- **There is no "stop emails" list of ours.** Lovable's footer is the
  unsubscribe, for leads and members alike. A notice says plainly that it is
  about training, to keep that footer from being pressed.
- **If the club grows into hundreds of inboxes, revisit this** before raising
  any limit: a large send would hold invoices up for hours. Promotions, when
  built, go through Resend on a separate address (for example
  `news.utsjitsu.com.au`), so a spam report on one never touches the domain
  invoices and sign-in links come from.

The plan announcement (`docs/notifications.md`, "A plan is announced") sends to
a list through the same service, under the same terms.

## Leads' consent

The interest form and the contact form both carry an optional, unticked box:
"Keep me posted about club events and offers". It is stored as
`promotion_consent` on `interest_registrations` and on `contact_messages`, and
is the lead's own tick, never inferred. Nothing reads it yet: it ships ahead of
promotions so consent builds up in the meantime. `list_message_leads` and the
screen's lead list report it, true when any of the address's entries ticked it.

## Erasure

Deleting a lead (the users page's only erasure, `docs/erasing-personal-data.md`)
deletes every interest-form entry **and every contact message** under their
address: either alone would leave them a lead. The confirm says how many of
each. `club_message_lead_recipients` rows go with them (`ON DELETE CASCADE`,
from whichever form the row points at). Those rows hold no address: it is read
from the entry at send time. A message's own row keeps the subject and body the
manager wrote, and which groups and ids were ticked, never an address.
