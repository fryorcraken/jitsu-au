// Shared venue details + map links, reused across Contact, Classes, Home and the
// footer so the address and "Open in Maps" targets stay consistent everywhere.

export const VENUE_NAME = "ActivateFit Gym";
export const VENUE_ADDRESS = "Harris Street, Ultimo NSW";

// Full search string used to build the map deep-links. Kept specific enough
// (name + street + suburb) to drop a pin on the right building.
const VENUE_MAP_QUERY = "ActivateFit Gym, Harris Street, Ultimo NSW 2007";

// Deep-links open the user's map app of choice. They are plain anchors — no
// third-party scripts or cookies load until the visitor taps one.
export const GOOGLE_MAPS_URL = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
  VENUE_MAP_QUERY,
)}`;
export const APPLE_MAPS_URL = `https://maps.apple.com/?q=${encodeURIComponent(VENUE_MAP_QUERY)}`;
