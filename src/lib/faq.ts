// Single source of truth for the club's FAQ content.
//
// Consumed by the full FAQ page (`routes/faq.tsx`, which also emits FAQPage
// JSON-LD from this list) and by the compact "Common questions" block on the
// homepage. Keep every question/answer here so the two never drift.

export type FaqItem = {
  /** Stable slug used to select items (e.g. the homepage trio) without matching on prose. */
  id: string;
  q: string;
  a: string;
};

export const faqItems: FaqItem[] = [
  {
    id: "trial-offer",
    q: "Is there a trial offer?",
    a: "Absolutely. Your first two sessions are on us. It's a great opportunity to experience our training firsthand and see if it's the right fit.",
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
    a: "Not at all. Our training is structured for every skill level, from complete beginner to experienced practitioner. We support your progress at your own pace.",
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

// The three most reassuring questions to surface on the homepage, where
// hesitation actually strikes. Deliberately chosen to COMPLEMENT the "Your
// first class" page (which already covers gear + what to wear), so the gear /
// clothing questions are intentionally excluded here to avoid redundancy.
export const homepageFaqIds = ["experience", "trial-offer", "jjj-vs-bjj"] as const;

export const homepageFaqItems: FaqItem[] = homepageFaqIds.map((id) => {
  const item = faqItems.find((f) => f.id === id);
  if (!item) throw new Error(`Unknown homepage FAQ id: ${id}`);
  return item;
});
