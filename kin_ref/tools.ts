// Talk to Kin server side: session variables for the ElevenLabs agent, its webhook tools (/tools/*), and the end-of-talk card note.
// Plain code decides: the agent can only ask; each tool re-checks the card type/state and the text before acting.
import { createHash, timingSafeEqual } from "crypto";
import { config, fmtTime } from "./config";
import { caregiver, personById } from "./db";
import { log, decision } from "./events";
import { getCard, updateCard } from "./cards/service";
import { onCardAction } from "./kin";

const SAID_YES = "🎙️ said yes in Talk to Kin";
const BLOCKED_WORDS = /\$|\b(money|cash|dollars?|gift ?cards?|bank|wire|venmo|zelle|paypal|bitcoin|crypto|password|passcode|code|pin|ssn|social security|account|card number|routing)\b/i;

/** Dynamic variables for the agent, built from the card. */
export function talkVariables(cardId: string): Record<string, string> {
  const c = getCard(cardId);
  const d = c?.data;
  const type = c?.row.type;
  const reason = type === "reminder" ? "reminder" : type === "protect" ? "safety" : "message";
  const person = d?.meta?.personId ? personById(d.meta.personId) : null;
  const today = !!d?.meta?.today; // ☀️ morning card: no sender
  const fromName = today ? "" : reason === "safety" ? "someone she doesn't know" : person?.name ?? d?.title ?? "";
  const relation = today ? "" : person?.relation ?? (reason === "message" ? (d?.subtitle ?? "").replace(/^your /, "") : "");
  const opening = today ? "Good morning. Shall I read you what's happening today?"
    : reason === "reminder" ? `${fromName || "Your family"} asked me to remind you about something. Shall I read it?`
    : reason === "safety" ? "You're safe. A message came from someone I don't know. Can I tell you about it?"
    : relation ? `${fromName}, your ${relation}, sent you a message. Would you like me to read it?`
    : `I'm here to help with your card about ${fromName || "your family"}. Shall we look at it?`;
  return {
    asha_name: config.ashaName, card_id: cardId, reason, opening,
    from_name: fromName, relation,
    message_text: d?.quote ?? "",
    reminder_text: type === "reminder" ? d?.line ?? "" : "",
    reply_options: (d?.buttons ?? []).filter((b) => b.action === "reply").map((b) => b.label).join(" | "),
    memory_line: type === "reminder" ? "" : d?.line ?? "",
  };
}

function secretOk(given: string | null): boolean {
  const want = config.elevenToolSecret;
  if (!want || !given) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(given), h(want));
}

type ToolResult = { status: number; body: { ok: boolean; message: string } };
const say = (ok: boolean, message: string, status = 200): ToolResult => ({ status, body: { ok, message } });

/** POST /tools/:name from the ElevenLabs agent. Exported so tests can call it without HTTP. */
export async function handleTool(name: string, secret: string | null, args: any): Promise<ToolResult> {
  if (!secretOk(secret)) { log.warn(`talk tool ${name}: bad secret`); return say(false, "unauthorized", 401); }
  const cardId = String(args?.card_id ?? "");
  const c = getCard(cardId);
  if (!c) return say(false, "I couldn't find that card.", 404);
  const { row, data } = c;
  log.info(`talk tool: ${name} card ${cardId} (${row.type}/${row.state})`);

  if (name === "send_reply") {
    if (row.type !== "context") return say(false, "There's nothing to reply to on this card.");
    const person = personById(data.meta.personId);
    if (!person) return say(false, "I couldn't find who to send it to.");
    if (row.state === "replied") return say(true, `That was already sent to ${person.name}.`);
    const text = String(args?.text ?? "").trim();
    if (!text || text.length > 120) return say(false, "That reply is too long. Let's pick a short one.");
    if (BLOCKED_WORDS.test(text) || /\d{4,}/.test(text)) return say(false, "I can't send money, codes or personal details. Let's choose a different reply.");
    const r = await onCardAction(cardId, "reply", { text });
    if (!r.ok) return say(false, "I couldn't send it just now. The card is still on your phone.");
    decision({ from: config.ashaName, preview: `→ ${person.name}: ${text}`, rules: [SAID_YES], action: "reply", cardId, highlight: [person.id] });
    return say(true, `Sent to ${person.name}.`);
  }

  if (name === "ask_family_to_call") {
    if (!["protect", "context", "whois"].includes(row.type)) return say(false, "Your family will check in with you soon.");
    const p = personById(data.meta.personId) ?? caregiver();
    if (!p) return say(false, "I couldn't reach your family just now.");
    const r = await onCardAction(cardId, "callme", { personId: p.id });
    if (!r.ok) return say(false, "I couldn't reach your family just now.");
    decision({ from: config.ashaName, preview: `asked ${p.name} to call`, rules: [SAID_YES], action: "alert", cardId, highlight: [p.id] });
    return say(true, `I asked ${p.name} to call you.`);
  }

  if (name === "mark_reminder_done") {
    if (row.type !== "reminder") return say(false, "This card isn't a reminder.");
    if (row.state === "done") return say(true, "It's already marked done.");
    const r = await onCardAction(cardId, "done", {});
    if (!r.ok) return say(false, "I couldn't mark it just now. The card is still on your phone.");
    decision({ from: config.ashaName, preview: `done: ${data.line ?? "reminder"}`, rules: [SAID_YES], action: "reminder", cardId });
    return say(true, "Marked done. Your family will know.");
  }
  return say(false, "unknown tool", 404);
}

/** The talk ended: note it on the card, but never overwrite an existing status like "Sent to Priya ✓". */
export async function onTalkEnded(cardId: string): Promise<boolean> {
  const c = getCard(cardId);
  if (!c || c.data.status) return false;
  log.info(`talk to Kin ended for card ${cardId}`);
  return updateCard(cardId, c.row.state, { status: { text: `🎙️ You talked with Kin at ${fmtTime()}`, tone: "info" } });
}
