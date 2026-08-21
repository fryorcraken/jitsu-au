// Shared venue details + map links, reused across Contact, Classes, Home and the
// footer so the address and "Open in Maps" targets stay consistent everywhere.

export const VENUE_NAME = "ActivateFit Gym";

// The address in parts, because every other form below is built from them. The
// street NUMBER is the part that matters: Harris Street runs about 1.8km through
// Ultimo and Pyrmont, so "Harris Street" on its own sends a first-timer to the
// wrong end of it. Anything that states where the club is (page copy, the map
// deep-links, the structured data in `seo.ts`, the default calendar location)
// derives from here rather than restating the address, so they cannot drift.
export const VENUE_STREET_ADDRESS = "745 Harris Street";
/** Which door. "745 Harris St" is a large UTS building, so this earns its place. */
export const VENUE_BUILDING = "UTS Building 4";
export const VENUE_SUBURB = "Ultimo";
export const VENUE_STATE = "NSW";
export const VENUE_POSTCODE = "2007";

/** Everything someone needs to find the door. Footer, contact card, calendar. */
export const VENUE_ADDRESS = `${VENUE_BUILDING}, ${VENUE_STREET_ADDRESS}, ${VENUE_SUBURB} ${VENUE_STATE} ${VENUE_POSTCODE}`;
/** Street and suburb, for running copy where the rest would just be noise. */
export const VENUE_ADDRESS_SHORT = `${VENUE_STREET_ADDRESS}, ${VENUE_SUBURB}`;

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

// Search string behind the map deep-links. It is the street address, not the
// business name: a name has to resolve in whichever map app the visitor uses,
// and Google currently lists this room under a different name from the one the
// site shows. A numbered street address resolves on its own, everywhere.
const VENUE_MAP_QUERY = `${VENUE_STREET_ADDRESS}, ${VENUE_SUBURB} ${VENUE_STATE} ${VENUE_POSTCODE}`;

// Deep-links open the user's map app of choice. They are plain anchors — no
// third-party scripts or cookies load until the visitor taps one.
export const GOOGLE_MAPS_URL = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
  VENUE_MAP_QUERY,
)}`;
export const APPLE_MAPS_URL = `https://maps.apple.com/?q=${encodeURIComponent(VENUE_MAP_QUERY)}`;
