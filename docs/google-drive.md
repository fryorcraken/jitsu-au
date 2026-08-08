# Signed waivers in the manager's Google Drive

A manager can connect their Google account on `/account` and have every signed
waiver PDF land in a folder of their Drive, on top of the copy the site keeps in
Supabase Storage. Nothing about signing changes for the member, and a member
never sees any of this.

The card has two things to set: the Google account (Connect / Disconnect) and
the destination folder.

## Choosing the folder

There are two ways, and they are not equivalent.

| Way                 | What it can reach                                                                  |
| ------------------- | ---------------------------------------------------------------------------------- |
| **Type a name**     | A folder in the manager's own My Drive, created by this site if it isn't there yet |
| **Browse in Drive** | Any folder the manager can already see, including one inside a **shared drive**    |

Typing a name cannot find a folder the manager made by hand, even with exactly
that name (see the scope note below), so it will make a second folder alongside
it. Browsing is the only way to point waivers at a folder that already exists or
at a shared drive the committee watches.

**Browsing is disabled until the site is configured for it** (both values under
Setup), and the card points at the name field instead. The button stays visible
because the person reading this page is usually the person who can fix it.

### Using the Google window

Google's picker has no "choose the folder I'm in". Click a folder **once** to
highlight it, then press Select. Opening a folder shows its contents and leaves
Select greyed out, because the thing selected is whatever is highlighted in the
listing, and inside a folder nothing is.

The card says this next to the button, because it is the single most confusing
thing about the flow.

## Setup

Both live in the club's own Google Cloud project, and both must come from the
**same** project as the OAuth client the connector runs on.

| Value                         | What it is                                                          |
| ----------------------------- | ------------------------------------------------------------------- |
| `VITE_GOOGLE_OAUTH_CLIENT_ID` | The OAuth **web** client id. The connector runs on this same client |
| `VITE_GOOGLE_PICKER_API_KEY`  | A browser **API key**, restricted by HTTP referrer to the site      |

The **Picker API** must be enabled on that project. It is a separate API from
the Drive API, and a disabled one fails exactly like a missing key.

Both are read at build time (`import.meta.env`), so adding the key needs a
rebuild and a redeploy, not just a settings change.

> [!NOTE]
> Restrict the key by **referrer** first. An API restriction that allows only
> the Picker API is the tighter setting, but reports differ on whether the
> picker also calls the Drive API with that key, and getting it wrong fails the
> same silent way as having no key at all. If the picker misbehaves with an API
> restriction on, widen it before assuming anything else is wrong.
>
> The claim that `VITE_GOOGLE_OAUTH_CLIENT_ID` is the connector's own client is
> an **assumption nothing in this repo can check**: the site sends the gateway
> only `GOOGLE_DRIVE_APP_USER_CONNECTOR_CLIENT_API_KEY`, and never sees the
> Google client the connector uses. If the two ever diverge, every pick fails
> server-side as a folder that cannot be read, with nothing pointing at why.

Server-side, `GOOGLE_DRIVE_APP_USER_CONNECTOR_CLIENT_API_KEY` authenticates the
site to Lovable's connector gateway, which holds the manager's refresh token and
makes the actual Drive calls (`callAsAppUser`).

## Why the identity is so fussy

The site asks for one Drive scope, `drive.file`, which grants access **per
file**, not to the Drive. Access is recorded against the triple **(Google
account, OAuth client, file)**. Everything below follows from that:

- **The picker is the grant.** Picking a folder is what makes that folder
  reachable by later uploads. There is no other way in: with `drive.file` the
  server cannot list, search or open a folder nobody handed it, which is why a
  pasted Drive link would be useless and why typing a name can only find
  folders this site made itself.
- **The picker must run on the connector's OAuth client.** A grant recorded for
  a different client is invisible to the connector, and the pick fails on the
  server as a folder it cannot read.
- **The account must match.** A manager signed into two Google accounts gets the
  browser's default one in the token popup. `pickDriveFolder` passes the
  connected address as a login hint and checks the account the token came back
  for, naming both addresses rather than letting the pick fail later as an
  unreadable folder id.
- **Never revoke the picker's token.** Revoking an access token revokes the
  whole grant for that (account, client) pair: it would tear up the per-file
  access just recorded, and the connector's refresh token with it, disconnecting
  Drive. The token is short-lived; leave it to expire.

Broadening the scope (`drive.readonly` or `drive`) would let the site render its
own folder browser and drop the picker entirely, but both are Google
**restricted** scopes: the club's OAuth client would need Google verification
and a security assessment first, and the connector would then hold read access
to the manager's whole Drive rather than only the files this site touches.

## When a pick or an upload fails

| What the manager sees                                                | What it means                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Browse in Drive" greyed out                                         | `VITE_GOOGLE_PICKER_API_KEY` (or the client id) is not set on this deploy                                                                                                                                                          |
| "Google signed you in as X, but this site's Drive is connected as Y" | Two Google accounts in one browser. Sign in as Y, or reconnect Drive as X                                                                                                                                                          |
| "Google's sign-in window could not open"                             | The browser blocked the pop-up. It opens a network round trip after the click, which can be long enough to lose the click's activation                                                                                             |
| "Could not access that folder from the server"                       | The grant did not reach the connector: wrong Google account, or a client id/appId mismatch                                                                                                                                         |
| Select greys out and nothing happens                                 | Something on the Cloud project is wrong: the API key, its restrictions, the app id, or the Picker API being disabled. Google reports these in the browser console, never through the callback. Press Cancel on the card to get out |

A folder that later disappears is only recreated when it came from a **typed
name** (`shouldRecreateFolder`). A picked folder is never recreated: its name is
not where it lives, and guessing would quietly redirect waivers into a new
folder in My Drive while the shared drive everyone watches goes silent.

## Files

| File                                           | What it is                                           |
| ---------------------------------------------- | ---------------------------------------------------- |
| `src/routes/_authenticated/account.tsx`        | The Google Drive card (manager-only)                 |
| `src/lib/google-picker.ts`                     | The browser-side picker: token, account check, views |
| `src/lib/google-drive.functions.ts`            | Connect, folder resolution, and the waiver upload    |
| `src/lib/google-drive.constants.ts`            | Folder mime type, and how the folder was chosen      |
| `src/integrations/lovable/appUserConnector.ts` | Gateway calls that carry the manager's connection    |
