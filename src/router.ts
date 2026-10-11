// Router: enrolled-group filter, echo filter, dedupe, 8 s debounce per chat, dispatch. Never awaits handlers inside the stream loop.
import type { Message, Space } from "spectrum-ts";
import { config, isEnrolledChat, isTablemateLine, mask, memberByHandle, normalizeHandle } from "./config";
import { saveMessage, seenMessage, type MsgRow } from "./db";
import { emit, log } from "./events";
import { onGroupTurn } from "./brain";
import type { Transport } from "./transport";

const seen = new Set<string>();
function dedupe(id: string): boolean {
  if (seen.has(id) || seenMessage(id)) return true;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value!);
  return false;
}

type Buf = { msgs: MsgRow[]; timer: ReturnType<typeof setTimeout> | null; first: number };
const buffers = new Map<string, Buf>();
const pending = new Set<Promise<void>>();

function flush(chatId: string) {
  const b = buffers.get(chatId);
  if (!b) return;
  buffers.delete(chatId);
  const p = onGroupTurn(chatId, b.msgs).catch((e) => log.error("group turn failed", e));
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

function buffer(m: MsgRow) {
  let b = buffers.get(m.chat_id);
  if (!b) { b = { msgs: [], timer: null, first: Date.now() }; buffers.set(m.chat_id, b); }
  if (b.timer) clearTimeout(b.timer);
  b.msgs.push(m);
  const debounce = Number(process.env.TM_DEBOUNCE_MS ?? config.debounceMs);
  if (debounce <= 0) { flush(m.chat_id); return; }
  const wait = Math.max(0, Math.min(debounce, 45_000 - (Date.now() - b.first)));
  b.timer = setTimeout(() => flush(m.chat_id), wait);
}

/** Wait until every buffered burst has been handled (tests and /dash/simulate use this). */
export async function drain() {
  for (const k of [...buffers.keys()]) { const b = buffers.get(k); if (b?.timer) clearTimeout(b.timer); flush(k); }
  while (pending.size) await Promise.all([...pending]);
}

export async function route(space: Space | null, message: Message) {
  if (message.direction === "outbound") return;
  const c0: any = message.content;
  if (c0.type === "read" || c0.type === "typing") return;

  if (message.platform === "local_imessage") {
    const chatId = space?.id ?? "";
    // Spec §5.6: anything outside the enrolled group chats is dropped before it is logged or stored.
    if (!isEnrolledChat(chatId)) return;
    const from = normalizeHandle(message.sender?.id);
    if (isTablemateLine(from)) return; // echo of our own cloud line
    if (dedupe(message.id)) return;
    const person = memberByHandle(from);
    if (!person) { log.info(`group message from a non-member ${mask(from)} ignored`); return; }
    const c = c0.type === "reply" ? c0.content : c0;
    if (c.type !== "text" || !String(c.text ?? "").trim()) return;
    const row: MsgRow = { id: message.id, chat_id: chatId, handle: person.handle, name: person.name, text: String(c.text), at: new Date(message.timestamp ?? Date.now()).toISOString() };
    saveMessage(row);
    emit({ kind: "message", chatId, name: person.name, text: row.text });
    buffer(row);
    return;
  }

  if (message.platform === "imessage") {
    // P2: cloud DMs to Tablemate's line are logged only.
    if (dedupe(message.id)) return;
    const from = normalizeHandle(message.sender?.id);
    const person = memberByHandle(from);
    log.info(`cloud DM from ${person ? person.name : mask(from)} (${c0.type}) — not handled (P2)`);
  }
}

/** Build the same Message shape the local provider produces (used by /dash/simulate and tests). */
export function fakeLocalMessage(chatId: string, handle: string, text: string, id = `sim_${crypto.randomUUID().slice(0, 8)}`): [Space, Message] {
  const space = { id: chatId, type: "group" } as unknown as Space;
  const message = { id, platform: "local_imessage", direction: "inbound", sender: { id: handle }, space, timestamp: new Date(), content: { type: "text", text } } as unknown as Message;
  return [space, message];
}

/** Supervisor: restart the merged stream if it ends or throws (a local watcher error can end it). */
export async function runRouter(T: Transport) {
  for (;;) {
    try {
      for await (const [space, message] of T.messages()) {
        void route(space, message).catch((e) => log.error("route failed", e));
      }
      log.warn("message stream ended; restarting in 2s");
    } catch (e) {
      log.error("message stream crashed; restarting in 2s", e);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
