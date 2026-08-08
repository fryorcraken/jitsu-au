# Passwords

What the club asks for when somebody sets a password, why those rules and not
the usual ones, and where each half is enforced.

Passwords are the secondary way into this site. The primary one is the emailed
sign-in link on `/auth`, which needs no password at all, and there is no
self-serve sign-up: an account exists because a manager approved a waiver. So a
password here is a convenience for people who want one, and it can be held to a
real standard without shutting anybody out.

## The rules

Stated in full, on screen, next to the field, before anything is typed:

| Rule                                                     | Where it comes from                             |
| -------------------------------------------------------- | ----------------------------------------------- |
| At least **15 characters**                               | NIST SP 800-63B-4 §3.1.1.2, single factor       |
| Not one character or short pattern repeated              | ours, see below                                 |
| Nothing from your name, your email, or the club's name   | ours, see below                                 |
| Not one of the passwords found in public data breaches   | NIST SP 800-63B-4, OWASP; via Have I Been Pwned |
| No more than **72 characters** (a ceiling, not a demand) | bcrypt, via Supabase                            |

And, just as deliberately, what is **not** asked for: no uppercase, no digit, no
symbol, no character classes of any kind. Every character is allowed, spaces and
emoji included.

## Why these and not "one number, one capital"

NIST SP 800-63B-4 (August 2025) and the OWASP Authentication Cheat Sheet both
now say composition rules must not be imposed. They are not neutral-but-dated,
they are actively harmful: told to add a capital, a digit and a symbol, people
produce `Password1!`, `Summer2026!`, `Jitsu@123`. Those are not rare passwords,
they are the most common shape in every credential-stuffing list, and an
eight-character one with all four character classes has less guessing resistance
than four ordinary words.

The two things that actually decide whether a password survives are:

1. **How long it is.** NIST requires 15 characters where the password is the
   only factor. That is our case: this site has no second factor, and the
   alternative to a password here is the emailed link, not an authenticator app.
   Eight characters is only permitted when a second factor backs it up.
2. **Whether it has already leaked.** Nearly every real account takeover starts
   with a password lifted from someone else's breach. No composition rule
   catches that, and a breach check catches nothing else.

The two middle rules are ours, and each closes a way to satisfy rule 1 without
gaining anything from it: `aaaaaaaaaaaaaaa` is fifteen characters of one
guess, and a password containing the member's own surname or "jitsu" is
guessable by anyone who has met them. Neither asks for a kind of character, so
neither is a composition rule.

The 72 is not a policy at all. bcrypt, which Supabase hashes with, ignores
everything past byte 72, so a longer passphrase would be silently truncated to
something shorter than the person believes they set. It is counted in **bytes**,
so accented or non-Latin characters use it up faster than ASCII.

## Where each half is enforced

**In the browser** (`src/lib/password-policy.ts`, pure and unit tested): length,
variety, and the personal/club words. `passwordProblem()` is what a form calls
before submitting, so somebody hears about a fixable problem without waiting for
a round trip.

**In the browser, advisory** (`src/lib/pwned-passwords.ts`): the breach lookup,
run about half a second after typing stops, against Have I Been Pwned's range
API. That API is a k-anonymity scheme: the password is SHA-1'd, only the first
five hex characters of the hash are sent, and the several hundred matching
suffixes are compared here on the device. The password never leaves the browser
and neither does its full hash. The request carries `Add-Padding: true` so the
response size does not leak which prefix was asked for.

Every failure of that lookup returns `unknown`, which reads as "carry on":
`passwordProblem()` never consults it, and the rule shows as met. Nobody should
be unable to set a password because a third party is down.

**On the server** (Supabase Auth): the breach check again, and this one is the
authority. Supabase's leaked-password protection queries the same corpus when
the password is saved, and refuses with `weak_password`. Its message,
`"Password is known to be weak and easy to guess, please choose a different
one."`, is the one this whole module is a reaction to: it tells you that you
failed without telling you the rule. `describePasswordError()` rewrites it, and
the two screens show it in an alert next to the rules rather than a toast.

> [!IMPORTANT]
> The 15-character minimum is currently enforced **in the browser only**. The
> server-side floor is Supabase's `password_min_length`, which is project
> configuration in the Supabase dashboard (Authentication → Sign In / Providers)
> and cannot be set from this repo. To make the rule real rather than advertised,
> set it to **15**, leave "leaked password protection" **on**, and leave the
> required-characters setting **off**. Until then the client rules are a strong
> default that a determined person could bypass with a direct API call.

## Where it appears

Both screens that set a password use `NewPasswordField`
(`src/components/site/NewPasswordField.tsx`), which renders the input, the
rules, and their live state:

- `/update-password`, reached from the emailed reset link.
- `/account`, the "Change password" card under Sign-in.

`/auth` sign-in is deliberately untouched. It checks nothing: an existing member
holding an older, shorter password keeps signing in with it, because these rules
apply when a password is **set**, never when one is used. Nobody is locked out
by this change, and nobody is asked to rotate. (NIST also says not to force
periodic rotation, and the club does not.)

## Changing the rules

`src/lib/password-policy.ts` is the only place the rules exist. The labels in
that file are the copy shown on screen, so a rule cannot change without its
wording changing with it, and `password-policy.test.ts` pins each one. If you
add a rule, it needs a label a member can read and act on. A rule the form will
not state is a rule the form should not have.

## Sources

- NIST SP 800-63B-4, _Digital Identity Guidelines: Authentication and
  Authenticator Management_ (August 2025), §3.1.1
- OWASP Cheat Sheet Series, _Authentication Cheat Sheet_, password length and
  complexity
- Have I Been Pwned, Pwned Passwords range API (k-anonymity, `Add-Padding`)
