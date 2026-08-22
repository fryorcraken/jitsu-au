// Single source of truth for the club's FAQ content.
//
// Consumed by the full FAQ page (`routes/faq.tsx`, which also emits FAQPage
// JSON-LD from this list) and by the compact "Common questions" block on the
// homepage. Keep every question/answer here so the two never drift.

export type FaqItem = {
  /** Stable slug used to select items (e.g. the homepage set) without matching on prose. */
  id: string;
  q: string;
  a: string;
};

export const faqItems: FaqItem[] = [
  {
    id: "trial-offer",
    q: "Is there a trial offer?",
    a: "Yes. Your first two sessions are free. Come along and see what you think.",
  },
  {
    id: "open-to-public",
    q: "Do I need to be a UTS student to join?",
    a: "No. The club is open to everyone. UTS students, UTS staff and people with no connection to the university all train in the same classes. The gym is inside UTS Building 4, which is open to the public, so there's no student card to show at the door. Students pay a lower fee, everyone else pays the public rate.",
  },
  {
    id: "equipment",
    q: "What equipment do I need?",
    a: "For your trial session, no equipment is needed. Once you decide to join, you'll need a mouth guard and a Gi uniform. We can help you source both.",
  },
  {
    id: "what-to-wear",
    q: "What should I wear to my first class?",
    a: "Wear whatever you're comfortable in. We recommend pants and a long-sleeve t-shirt. Bring a water bottle too.",
  },
  {
    id: "experience",
    q: "Do I need prior martial arts experience?",
    a: "No. Plenty of our members had never done a martial art before they walked in. You will be shown the basics from the start.",
  },
  {
    id: "vs-other-martial-arts",
    q: "How is Japanese Jiu-Jitsu different from other martial arts?",
    a: "Japanese Jiu-Jitsu is comprehensive. It includes striking, throws, joint locks and ground work, with a focus on self-defence techniques applicable to real-life situations.",
  },
  {
    id: "jjj-vs-bjj",
    q: "What's the difference between Japanese and Brazilian Jiu-Jitsu?",
    a: "They share roots but have different focuses. Japanese Jiu-Jitsu covers a wide range: strikes, throws, joint locks and ground work. Our focus is on practical self-defence. Brazilian Jiu-Jitsu concentrates on ground fighting and submissions.",
  },
];

// The most reassuring questions to surface on the homepage, where hesitation
// actually strikes. Deliberately chosen to COMPLEMENT the "Your first class"
// page (which already covers gear + what to wear), so the gear / clothing
// questions are intentionally excluded here to avoid redundancy.
//
// "open-to-public" leads because the club's name reads as a university club,
// and someone who assumes they are not eligible leaves without asking. It sits
// second in `faqItems` above, though: /faq renders that array in order (and
// emits its FAQPage JSON-LD from it), and the trial offer keeps that slot.
export const homepageFaqIds = [
  "open-to-public",
  "experience",
  "trial-offer",
  "jjj-vs-bjj",
] as const;

export const homepageFaqItems: FaqItem[] = homepageFaqIds.map((id) => {
  const item = faqItems.find((f) => f.id === id);
  if (!item) throw new Error(`Unknown homepage FAQ id: ${id}`);
  return item;
});
