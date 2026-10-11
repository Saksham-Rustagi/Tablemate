// Cuisine helpers for places.ts: emoji per Places primaryType, dislike → excluded types, like → search cuisine.

// Keywords are matched as whole "_"-separated tokens (optional plural s), first entry wins.
const EMOJI: [string[], string][] = [
  [["italian"], "🍝"],
  [["pizza", "pizzeria"], "🍕"],
  [["mexican", "taco", "taqueria"], "🌮"],
  [["nepalese", "nepali", "himalayan", "tibetan", "momo"], "🥟"],
  [["indian"], "🍛"],
  [["japanese", "sushi"], "🍣"],
  [["chinese"], "🥡"],
  [["korean"], "🍲"],
  [["thai", "vietnamese", "pho", "ramen"], "🍜"],
  [["turkish", "mediterranean", "middle_eastern", "greek", "lebanese", "kebab", "falafel"], "🥙"],
  [["bbq", "barbecue"], "🍖"],
  [["chicken", "wing"], "🍗"],
  [["american", "hamburger", "burger"], "🍔"],
  [["breakfast", "brunch", "pancake"], "🥞"],
  [["ice_cream"], "🍦"],
  [["sandwich", "deli"], "🥪"],
  [["bar_and_grill", "brewery", "bar", "pub"], "🍺"],
  [["cafe", "coffee_shop", "coffee"], "☕"],
  [["bakery"], "🥐"],
  [["vegetarian", "vegan"], "🥗"],
  [["seafood"], "🦐"],
  [["steak_house", "steakhouse", "steak"], "🥩"],
];
const EMOJI_RE: [RegExp, string][] = EMOJI.map(([kws, e]) => [new RegExp(`(^|_)(${kws.join("|")})s?(_|$)`), e]);

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "_");

/** Cuisine emoji: matched on primaryType, then cuisineLabel ("Lebanese Restaurant"), then keywords in the name ("Momo's Master"). */
export function cuisineEmoji(primaryType: string | null | undefined, cuisineLabel?: string | null, name?: string | null): string {
  for (const s of [primaryType, cuisineLabel, name]) {
    const t = norm(s);
    if (!t) continue;
    for (const [re, e] of EMOJI_RE) if (re.test(t)) return e;
  }
  return "🍽️";
}

const DISLIKE_TYPES: Record<string, string[]> = {
  sushi: ["sushi_restaurant", "japanese_restaurant"],
  japanese: ["sushi_restaurant", "japanese_restaurant"],
  pizza: ["pizza_restaurant"],
  mexican: ["mexican_restaurant"],
  indian: ["indian_restaurant"],
  burgers: ["hamburger_restaurant"],
  burger: ["hamburger_restaurant"],
  bars: ["bar", "bar_and_grill", "brewery"],
  bar: ["bar", "bar_and_grill", "brewery"],
};

/** True if a place of `primaryType` is excluded by a dislike of `value` (map first, then generic substring on primaryType). */
export function dislikeMatches(primaryType: string | null | undefined, value: string): boolean {
  const t = (primaryType ?? "").toLowerCase();
  const v = value.trim().toLowerCase();
  if (!t || !v) return false;
  const mapped = DISLIKE_TYPES[v];
  if (mapped) return mapped.includes(t);
  const key = v.replace(/\s+/g, "_").replace(/s$/, "");
  return key.length >= 3 && t.includes(key);
}

const CUISINES = ["italian", "pizza", "mexican", "indian", "japanese", "sushi", "chinese", "thai", "mediterranean", "greek",
  "middle eastern", "korean", "vietnamese", "ramen", "bbq", "barbecue", "seafood", "steak", "burgers", "tacos", "french", "turkish"];

/** The cuisine named by a `like` fact value, or null if it isn't a cuisine ("thai food" → "thai"). */
export function likeCuisine(value: string): string | null {
  const v = value.trim().toLowerCase();
  return CUISINES.find((c) => new RegExp(`\\b${c}\\b`).test(v)) ?? null;
}
