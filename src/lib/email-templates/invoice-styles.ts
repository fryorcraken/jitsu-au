// Styles shared by the emails that ask for money (`club-account-section.tsx`
// and the two invoice emails), kept apart from the components so a component
// file exports only components.

export const emailRowLabel = {
  fontSize: "11px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "#999999",
  margin: "8px 0 0",
};
export const emailRowValue = {
  fontSize: "16px",
  color: "#222222",
  fontWeight: "bold" as const,
  margin: "2px 0 0",
};
export const emailHr = { borderColor: "#e0e6e8", margin: "14px 0" };
