// Router: dedupe, echo filter, TEST_SENDERS allowlist, debounce, dispatch. Never awaits handlers inside the stream loop.
import type { Message, Space } from "spectrum-ts";
import { config, isAllowedLocalSender, isAsha, isKinLine, mask, normalizeHandle } from "./config";
import { personByHandle, seenMessage } from "./db";
import { log } from "./events";
import { onFamilyToAsha, onUnknownToAsha, onAshaToKin, onFamilyToKin, onFamilyPhotoToKin, onAshaVoiceToKin, type Turn } from "./kin";
import { isAudio, isImage, type InPhoto } from "./photos";
import type { Transport } from "./transport";

const seen = new Set<string>();
function dedupe(id: string): boolean {
  if (seen.has(id) || seenMessage(id)) return true;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value!);
  return false;
}

type Buf = { turn: Turn; timer: ReturnType<typeof setTimeout>; first: number };
const buffers = new Map<string, Buf>();
export let ignoredCount = 0;

function flush(key: string) {
  const b = buffers.get(key);
  if (!b) return;
  buffers.delete(key);
  const person = isAsha(b.turn.from) ? null : personByHandle(b.turn.from);
  const p = person ? onFamilyToAsha(person, b.turn) : onUnknownToAsha(b.turn);
  p.catch((e) => log.error("turn handler failed", e));
}

function buffer(from: string, chatId: string | null, isGroup: boolean, id: string, text: string, att?: Turn["attachments"][number]) {
  const key = `${from}|${chatId ?? ""}`;
  let b = buffers.get(key);
  if (!b) {
    b = { turn: { from, chatId, isGroup, texts: [], ids: [], at: new Date(), attachments: [] }, timer: setTimeout(() => {}, 0), first: Date.now() };
    buffers.set(key, b);
  }
  clearTimeout(b.timer);
  if (text) b.turn.texts.push(text);
  if (att) b.turn.attachments.push(att);
  b.turn.ids.push(id);
  const waited = Date.now() - b.first;
  const wait = Math.max(0, Math.min(config.debounceMs, 45_000 - waited));
  b.timer = setTimeout(() => flush(key), wait);
}

export async function route(space: Space | null, message: Message) {
  if (message.direction === "outbound") return;
  const c0: any = message.content;
  if (c0.type === "read" || c0.type === "typing") return;
  if (dedupe(message.id)) return;
  const from = normalizeHandle(message.sender?.id);

  if (message.platform === "local_imessage") {
    if (isKinLine(from)) return; // echo: Kin's own cloud messages also land in Asha's chat.db
    if (!isAllowedLocalSender(from)) { ignoredCount++; log.info(`(ignored a local message from a non-test sender ${mask(from)}; ${ignoredCount} so far${config.allowSenders.length ? "" : " · TEST_SENDERS is empty, so nobody is let through"})`); return; }
    const isGroup = (space as any)?.type === "group";
    if (isGroup) { log.info(`group message from ${mask(from)}: G1 group mode not enabled in v1`); return; }
    const c = c0.type === "reply" ? c0.content : c0;
    if (c.type === "text") buffer(from, space?.id ?? null, false, message.id, c.text);
    // Keep a read() handle so onFamilyToAsha can look at photos (throws if not downloaded to the Mac; handled there).
    else if (c.type === "attachment" || c.type === "voice") buffer(from, space?.id ?? null, false, message.id, "", { name: c.name ?? "file", mimeType: c.mimeType ?? "", read: typeof c.read === "function" ? () => c.read() : undefined });
    return;
  }

  if (message.platform === "imessage") {
    const unwrap = (c: any): any[] => c.type === "group" ? c.items.flatMap(unwrap) : c.type === "reply" ? unwrap(c.content) : [c];
    const items = unwrap(c0);
    const handle = async (c: any): Promise<void> => {
      if (isAsha(from)) {
        if (c.type === "voice" || (c.type === "attachment" && isAudio(c.mimeType, c.name))) {
          return onAshaVoiceToKin(await c.read(), c.mimeType ?? "audio/x-caf", message.id);
        }
        return onAshaToKin({ type: c.type, text: c.text, emoji: c.emoji, targetId: c.target?.id });
      }
      const person = personByHandle(from);
      if (!person) { log.info(`cloud message from unknown ${mask(from)} ignored`); return; }
      if (c.type === "text") return onFamilyToKin(person, from, c.text, message.id);
      log.info(`cloud ${c.type} from ${person.name} (not handled yet)`);
    };
    const run = async () => {
      // Family photo(s), alone or grouped with a caption → ONE photo-memory call.
      const person = isAsha(from) ? null : personByHandle(from);
      const imgs = items.filter((c) => c.type === "attachment" && isImage(c.mimeType, c.name));
      if (person && imgs.length) {
        const caption = items.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        const photos: InPhoto[] = [];
        for (const c of imgs) {
          try { photos.push({ bytes: await c.read(), mimeType: c.mimeType ?? "", name: c.name ?? "photo" }); }
          catch (e) { log.warn(`photo from ${person.name} unreadable: ${(e as any)?.message ?? e}`); }
        }
        return onFamilyPhotoToKin(person, from, photos, caption, message.id);
      }
      for (const it of items) await handle(it);
    };
    run().catch((e) => log.error("cloud handler failed", e));
  }
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
