// Cuisine helpers for places.ts: emoji per Places primaryType, dislike → excluded types, like → search cuisine.

const EMOJI: [RegExp, string][] = [
  [/^italian_restaurant$/, "🍝"],
  [/^pizza_restaurant$/, "🍕"],
  [/^mexican_restaurant$/, "🌮"],
  [/^indian_restaurant$/, "🍛"],
  [/^(japanese|sushi)_restaurant$/, "🍣"],
  [/^chinese_restaurant$/, "🥡"],
  [/^thai_restaurant$/, "🍜"],
  [/^(mediterranean|greek|middle_eastern)_restaurant$/, "🥙"],
  [/^(american|hamburger)_restaurant$/, "🍔"],
  [/^(bar_and_grill|brewery|bar)$/, "🍺"],
  [/^(cafe|coffee_shop)$/, "☕"],
  [/^bakery$/, "🥐"],
  [/^(vegetarian|vegan)_restaurant$/, "🥗"],
  [/^seafood_restaurant$/, "🦐"],
  [/^steak_house$/, "🥩"],
];

export function cuisineEmoji(primaryType: string | null | undefined): string {
  const t = primaryType ?? "";
  for (const [re, e] of EMOJI) if (re.test(t)) return e;
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
