/** The club's Google listing, where every quote below comes from. */
export const GOOGLE_REVIEWS_URL = "https://maps.app.goo.gl/VhonWy3FDoyBpax59";

/**
 * The club's overall Google rating, as shown on the listing.
 *
 * The badge shows the rating on its own. Issue #8 originally specced a review
 * count next to it ("5.0 on Google · N reviews"); that was dropped on purpose,
 * because a hardcoded count goes stale every time somebody leaves a review and
 * the rating alone carries the same credibility. Do not add it back.
 */
export const GOOGLE_RATING = "5.0";

export type GoogleReview = {
  /** Reviewer's name as it appears on Google, surname abbreviated. */
  name: string;
  text: string;
};

/**
 * Real 5-star reviews left on the listing above, shortened to fit a card.
 *
 * The wording is the reviewer's own. An ellipsis marks where text was cut, and
 * nothing is added or reworded. Swapping one out means copying the new quote
 * from the listing, not writing a fresh one: these are testimonials, so an
 * invented quote would be a fabrication.
 */
export const GOOGLE_REVIEWS: GoogleReview[] = [
  {
    name: "Xinyan W.",
    text: "Absolutely love this club! It's beginner-friendly and the vibe is really welcoming. The coaches are experienced, patient, and super supportive. … Everyone gets to train with people of different levels, this has helped me spot my weaknesses and learn from others.",
  },
  {
    name: "Ed K.",
    text: "Awesome place to train! Great coaches, great vibe, and everyone is really welcoming. Highly recommend this style of Jiu Jitsu … including strikes, throws, submissions and locks. The complete package for you to get fit and/or for self defence.",
  },
  {
    name: "John",
    text: "The club is led by a teacher with experience in a wide range of martial arts, and the training atmosphere is friendly and supportive. It's also a very inclusive environment; nobody is expected to be super fit (although you will definitely get fitter!), physical strength is unimportant and allowances are made for different types of bodily ability.",
  },
];
