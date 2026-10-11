// Transport: one Spectrum process, two providers. Cloud = Tablemate's own line (cards, edits, effects, attachments).
// Local = Saksham's Mac, READ ONLY: Tablemate never sends through it (there is no local send method at all).
import { Spectrum, app, attachment, edit, type AppLayout, type Message, type Space } from "spectrum-ts";
import { imessage, effect } from "spectrum-ts/providers/imessage";
import { localIMessage } from "@spectrum-ts/imessage-local";
import { config, isEnrolledChat, mask, normalizeHandle } from "./config";
import { log } from "./events";

export type CardRef = { id: string; msg?: Message; session?: unknown };

export interface Transport {
  sendText(to: string, text: string): Promise<string | undefined>;
  sendCard(to: string, url: string, layout: AppLayout): Promise<CardRef | undefined>;
  editCard(to: string, ref: CardRef, url: string, layout: AppLayout): Promise<boolean>;
  sendEffect(to: string, text: string): Promise<boolean>;
  sendAttachment(to: string, bytes: Uint8Array, name: string, mimeType: string): Promise<boolean>;
  messages(): AsyncIterable<[Space | null, Message]>;
  health(): { local: boolean; cloud: boolean };
  stop(): Promise<void>;
}

export async function createSpectrumTransport(): Promise<Transport> {
  const sp = await Spectrum({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    providers: [imessage.config(), localIMessage.config()],
    options: { logLevel: (process.env.SPECTRUM_LOG as any) || "warn" },
  });
  const im = imessage(sp);
  const cloudSpaces = new Map<string, Space>();
  const health = { local: true, cloud: true };

  async function cloudSpace(to: string): Promise<Space> {
    const h = normalizeHandle(to);
    let s = cloudSpaces.get(h);
    if (!s) { s = await im.space.create(await im.user(h)); cloudSpaces.set(h, s); }
    return s;
  }

  return {
    async sendText(to, text) {
      try {
        const m = await (await cloudSpace(to)).send(text);
        health.cloud = true;
        return m?.id;
      } catch (e) { health.cloud = false; log.error(`cloud send to ${mask(to)} failed`, e); return undefined; }
    },
    async sendCard(to, url, layout) {
      try {
        const m = await (await cloudSpace(to)).send(app(url, { live: true, layout }));
        if (!m) return undefined;
        health.cloud = true;
        return { id: m.id, msg: m, session: imessage.is(m) ? (m as any).miniAppCardSession : undefined };
      } catch (e) { health.cloud = false; log.error(`card send to ${mask(to)} failed`, e); return undefined; }
    },
    async editCard(to, ref, url, layout) {
      try {
        const target = ref.msg ?? ({ id: ref.id, content: { type: "app" }, direction: "outbound", miniAppCardSession: ref.session } as unknown as Message);
        await (await cloudSpace(to)).send(edit(app(url, { live: true, layout }), target));
        if (ref.msg && imessage.is(ref.msg)) ref.session = (ref.msg as any).miniAppCardSession;
        return true;
      } catch (e) { log.error(`card edit failed (${ref.id})`, e); return false; }
    },
    async sendEffect(to, text) {
      try {
        await (await cloudSpace(to)).send(effect(text, imessage.effect.message.celebration));
        return true;
      } catch (e) { log.error(`effect send to ${mask(to)} failed`, e); return false; }
    },
    async sendAttachment(to, bytes, name, mimeType) {
      try {
        await (await cloudSpace(to)).send(attachment(Buffer.from(bytes), { name, mimeType }));
        return true;
      } catch (e) { log.error(`attachment send to ${mask(to)} failed`, e); return false; }
    },
    messages() {
      return (async function* () {
        for await (const [space, message] of sp.messages) {
          // Privacy (spec §5.6): the Mac is Saksham's real Apple ID. Drop every local message outside the
          // enrolled group chats BEFORE anything logs it.
          if (message.platform !== "imessage" && !isEnrolledChat(space?.id)) continue; // fail closed: anything not from the cloud line must be an enrolled group
          yield [space, message] as [Space, Message];
        }
      })();
    },
    health: () => health,
    async stop() { await sp.stop(); },
  };
}

export type FakeSend = { provider: "cloud"; kind: "text" | "card" | "edit" | "effect" | "attachment"; to: string; text?: string; url?: string; layout?: AppLayout; name?: string };

/** Fake transport for replay tests: records every send, never touches the network. */
export function createFakeTransport() {
  const sent: FakeSend[] = [];
  let n = 0;
  const t: Transport & { sent: FakeSend[] } = {
    sent,
    async sendText(to, text) { sent.push({ provider: "cloud", kind: "text", to, text }); return `fake-${++n}`; },
    async sendCard(to, url, layout) { sent.push({ provider: "cloud", kind: "card", to, url, layout }); return { id: `fake-card-${++n}` }; },
    async editCard(to, _ref, url, layout) { sent.push({ provider: "cloud", kind: "edit", to, url, layout }); return true; },
    async sendEffect(to, text) { sent.push({ provider: "cloud", kind: "effect", to, text }); return true; },
    async sendAttachment(to, _bytes, name) { sent.push({ provider: "cloud", kind: "attachment", to, name }); return true; },
    messages() { return (async function* () { /* replay pushes directly into the router */ })(); },
    health: () => ({ local: true, cloud: true }),
    async stop() {},
  };
  return t;
}
