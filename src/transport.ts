// Transport: one Spectrum process, two providers. Cloud = Kin's own line; local = Asha's Mac (send AS Asha).
import { Spectrum, app, edit, voice, type AppLayout, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { localIMessage } from "@spectrum-ts/imessage-local";
import { readFileSync } from "fs";
import { config, mask, normalizeHandle } from "./config";
import { log } from "./events";

export type CardRef = { id: string; msg?: Message; session?: unknown };

export interface Transport {
  sendText(to: string, text: string): Promise<string | undefined>;
  sendCard(to: string, url: string, layout: AppLayout): Promise<CardRef | undefined>;
  editCard(to: string, ref: CardRef, url: string, layout: AppLayout): Promise<boolean>;
  sendVoice(to: string, file: string, durationSec: number): Promise<boolean>;
  sendAsAsha(handle: string, chatId: string | null, text: string): Promise<boolean>;
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
  const local = localIMessage(sp);
  const cloudSpaces = new Map<string, Space>();
  const localSpaces = new Map<string, Space>();
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
    async sendVoice(to, file, durationSec) {
      try {
        await (await cloudSpace(to)).send(voice(readFileSync(file), { name: "kin.m4a", mimeType: "audio/mp4", duration: durationSec } as any));
        return true;
      } catch (e) { log.error("voice send failed", e); return false; }
    },
    async sendAsAsha(handle, chatId, text) {
      try {
        const h = normalizeHandle(handle);
        let s = (chatId && localSpaces.get(chatId)) || localSpaces.get(h);
        if (!s) {
          s = chatId ? await local.space.get(chatId).catch(() => undefined as any) : undefined;
          if (!s) s = await local.space.create(await local.user(h));
          localSpaces.set(h, s!);
        }
        await s!.send(text);
        health.local = true;
        return true;
      } catch (e) { log.error(`send as Asha to ${mask(handle)} failed`, e); return false; }
    },
    messages() {
      return (async function* () {
        for await (const [space, message] of sp.messages) {
          if (message.platform === "local_imessage") localSpaces.set(space.id, space);
          yield [space, message] as [Space, Message];
        }
      })();
    },
    health: () => health,
    async stop() { await sp.stop(); },
  };
}

/** Fake transport for replay tests: records everything, never touches the network. */
export function createFakeTransport() {
  const sent: { kind: string; to: string; text?: string; url?: string; layout?: AppLayout }[] = [];
  let n = 0;
  const t: Transport & { sent: typeof sent } = {
    sent,
    async sendText(to, text) { sent.push({ kind: "text", to, text }); return `fake-${++n}`; },
    async sendCard(to, url, layout) { sent.push({ kind: "card", to, url, layout }); return { id: `fake-card-${++n}` }; },
    async editCard(to, _ref, url, layout) { sent.push({ kind: "edit", to, url, layout }); return true; },
    async sendVoice(to) { sent.push({ kind: "voice", to }); return true; },
    async sendAsAsha(handle, _chat, text) { sent.push({ kind: "as_asha", to: handle, text }); return true; },
    messages() { return (async function* () { /* replay pushes directly into the router */ })(); },
    health: () => ({ local: true, cloud: true }),
    async stop() {},
  };
  return t;
}
