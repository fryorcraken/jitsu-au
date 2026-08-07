// Shared venue details + map links, reused across Contact, Classes, Home and the
// footer so the address and "Open in Maps" targets stay consistent everywhere.

export const VENUE_NAME = "ActivateFit Gym";
export const VENUE_ADDRESS = "Harris Street, Ultimo NSW";

// The club's mobile. One literal, in local dialling form; every other shape the
// site needs is derived from it below, so there is no way for the number the
// page prints, the number it dials, the WhatsApp deep-link and the number in the
// structured data to disagree. `seo.ts` re-exports the E.164 form as
// `CLUB_PHONE_E164` for the schema.org markup.
//
// It also reaches the contact-form auto-reply, which is why it had to stop being
// four copies of a string literal across the pages: an email telling someone to
// ring a number the site no longer lists would be worse than not mentioning it.
const VENUE_PHONE_LOCAL = "0493631759";

/** International form, for structured data and the WhatsApp link. */
export const VENUE_PHONE_E164 = `+61${VENUE_PHONE_LOCAL.slice(1)}`;
/** How the number is written on screen and in emails: "0493 631 759". */
export const VENUE_PHONE_DISPLAY = VENUE_PHONE_LOCAL.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");
/** `href` for a tap-to-call link. */
export const VENUE_PHONE_TEL = `tel:${VENUE_PHONE_LOCAL}`;
/** wa.me wants the international number with no leading `+`. */
export const WHATSAPP_URL = `https://wa.me/${VENUE_PHONE_E164.slice(1)}`;

// Full search string used to build the map deep-links. Kept specific enough
// (name + street + suburb) to drop a pin on the right building.
const VENUE_MAP_QUERY = "ActivateFit Gym, Harris Street, Ultimo NSW 2007";

// Deep-links open the user's map app of choice. They are plain anchors — no
// third-party scripts or cookies load until the visitor taps one.
export const GOOGLE_MAPS_URL = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
  VENUE_MAP_QUERY,
)}`;
export const APPLE_MAPS_URL = `https://maps.apple.com/?q=${encodeURIComponent(VENUE_MAP_QUERY)}`;
