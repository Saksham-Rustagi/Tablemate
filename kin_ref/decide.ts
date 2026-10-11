// Decision engine: plain code decides every action. Gemini only supplies the "assess" fields.
import { config } from "./config";
import type { Person } from "./db";
import type { AssessCompose } from "./ai/gemini";

export type Decision = { action: "card" | "protect" | "quiet" | "hold"; rules: string[]; mentions: string[] };

const SCAM_PATTERNS: [RegExp, string][] = [
  [/gift ?cards?|itunes card|google play card|steam card/i, "gift cards"],
  [/\bwire\b|western union|moneygram|zelle|venmo|cash ?app|paypal/i, "money transfer"],
  [/bitcoin|crypto|\bbtc\b|\busdt\b/i, "crypto"],
  [/\$\s?\d+|\d+\s?(dollars|bucks)\b|send (me )?money|need money|lend me/i, "money"],
  [/new (phone )?number|lost my phone|broke my phone|changed my number/i, "new number claim"],
  [/\bbail\b|\bjail\b|arrested|hospital and need|accident and need/i, "emergency story"],
  [/don'?t tell|keep (this|it) (a )?secret|between us/i, "secrecy"],
  [/verification code|security code|the code (i|we) (just )?sent|one[- ]time code|\bOTP\b/i, "asks for a code"],
  [/https?:\/\/\S+|\b[a-z0-9-]+\.(top|xyz|info|click|link|live|shop)\b/i, "link"],
  [/urgent|right now|immediately|asap|hurry/i, "urgency"],
];

export function scamSignals(text: string): string[] {
  return SCAM_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

/** "Grandma it's Priya", "this is Raj", "it's me, your grandson" → claimed identity. */
export function claimedIdentity(text: string, familyNames: string[]): string | null {
  for (const n of familyNames) {
    if (new RegExp(`\\b(it'?s|this is|i'?m|it is|from)\\s+${n}\\b`, "i").test(text)) return n;
  }
  if (/\b(it'?s me|your (grand)?(son|daughter|grandson|granddaughter|grandchild))\b/i.test(text)) return "a family member";
  return null;
}

const TRIVIAL = /^\s*(ok(ay)?|k|kk|lol|haha+|ha|yes|yep|yeah|no|nope|sure|thanks?|thank you|ty|👍|❤️|😂|🙏|😊|🥰|♥️|💕|love you|ok see you( soon)?!?|see you( soon)?!?)\s*[!.]*\s*$/i;
export function looksTrivial(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (TRIVIAL.test(t)) return true;
  // a single emoji or two
  return /^[\p{Extended_Pictographic}\s\u200d\ufe0f]{1,6}$/u.test(t);
}

export function inQuietHours(d = new Date()): boolean {
  if (!config.quietHoursEnabled) return false;
  const [a, b] = config.quietHours.split("-");
  const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };
  const local = new Date(d.toLocaleString("en-US", { timeZone: config.tz }));
  const now = local.getHours() * 60 + local.getMinutes();
  const s = hm(a), e = hm(b);
  return s > e ? now >= s || now < e : now >= s && now < e;
}

export function daysSince(iso: string | null): number {
  if (!iso) return 999;
  return Math.floor((Date.now() - Date.parse(iso)) / 86400_000);
}

/** Known family member → card or quiet (Product Spec §4.1). */
export function decideFamily(p: { person: Person; text: string; assess: AssessCompose | null; unplaced: string[]; urgent?: boolean; wordCount: number }): Decision {
  const { person, text, assess, unplaced } = p;
  const rules: string[] = [];
  const d = daysSince(person.last_contact_at);
  const trivial = assess ? assess.isTrivial || looksTrivial(text) : looksTrivial(text);
  if (d >= 7 && !person.known_by_asha) rules.push(`R1 ${d} days since last`);
  for (const u of unplaced) rules.push(`R3 ${u}`);
  if (assess?.needsSummary || p.wordCount > 40) rules.push("R4 long message");
  if (assess?.questionForAsha) rules.push("R5 question for her");
  if (assess?.isStressful) rules.push("R6 stressful tone");
  if (person.always_help) rules.push("R7 she asked for help");
  if (!assess) rules.push("fallback: rules only");
  const firing = rules.filter((r) => r.startsWith("R"));
  if (trivial && !firing.some((r) => /^R[3-6]/.test(r))) return { action: "quiet", rules: ["Q2 trivial", ...rules], mentions: unplaced };
  if (!firing.length) return { action: "quiet", rules: [person.known_by_asha ? "Q1 she knows them" : "no trigger", ...rules], mentions: unplaced };
  if (inQuietHours() && !p.urgent) return { action: "hold", rules: ["Q3 quiet hours", ...rules], mentions: unplaced };
  return { action: "card", rules, mentions: unplaced };
}

/** Unknown sender → protect, gentle card, or quiet (Product Spec §4.2). */
export function decideUnknown(p: { text: string; assess: AssessCompose | null; familyNames: string[]; isShortCode: boolean }): Decision & { signals: string[]; claimed: string | null } {
  const signals = scamSignals(p.text);
  const claimed = claimedIdentity(p.text, p.familyNames) ?? (p.assess?.scam.claimsToBe || null);
  const score = p.assess?.scam.score ?? 0;
  const rules: string[] = [];
  for (const s of signals) rules.push(`P1 ${s}`);
  if (score >= 60) rules.push(`P1 AI risk ${score}`);
  if (claimed) rules.push(`P4 claims to be ${claimed}`);
  if (signals.length || score >= 60 || claimed) return { action: "protect", rules, mentions: [], signals, claimed };
  if (p.isShortCode) return { action: "quiet", rules: ["P3 automated sender"], mentions: [], signals, claimed };
  return { action: "card", rules: ["P2 unknown sender, no risk"], mentions: [], signals, claimed };
}

/** Show links as plain, untappable text: usps-help.top → usps-help[.]top */
export function defang(text: string): string {
  return text.replace(/https?:\/\//gi, "").replace(/\b([a-z0-9-]+)\.([a-z]{2,})(\/\S*)?/gi, (_m, a, b) => `${a}[.]${b}`);
}
