// "Read it to me": ElevenLabs eleven_v4 → m4a (afconvert) → voice message in Kin's thread. Cached per card version.
import { existsSync, writeFileSync } from "fs";
import { config } from "./config";
import { log, decision } from "./events";
import { getCard } from "./cards/service";
import type { Transport } from "./transport";

let T: Transport;
export function setVoiceTransport(t: Transport) { T = t; }

export function scriptFor(cardId: string): string | null {
  const c = getCard(cardId);
  if (!c) return null;
  const d = c.data, a = config.ashaName;
  const strip = (s: string) => s.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, "").replace(/\[\.\]/g, " dot ").trim();
  switch (c.row.type) {
    case "context": {
      const parts = [`[warmly] ${a}, this message is from ${d.title}, your ${d.subtitle?.replace(/^your /, "")}.`];
      if (d.line) parts.push(strip(d.line) + ".");
      if (d.summary) parts.push(strip(d.summary) + ".");
      parts.push(`${d.title} wrote: ${strip(d.quote ?? "")}`);
      return parts.join(" ");
    }
    case "protect":
      return `[calmly] ${a}, a number you don't know sent you a message. ${strip(d.line ?? "")} You don't need to reply.`;
    case "reminder":
      return `[warmly] ${a}, ${d.title} asked me to remind you: ${strip(d.line ?? "")}.`;
    default:
      return `[warmly] ${a}, ${strip(d.title)}. ${strip(d.line ?? "")}`;
  }
}

export async function tts(text: string, outBase: string): Promise<{ file: string; duration: number } | null> {
  const m4a = `${outBase}.m4a`;
  if (existsSync(m4a)) return { file: m4a, duration: await durationOf(m4a) };
  const mp3 = await ttsMp3(text, outBase);
  if (!mp3) return null;
  const p = Bun.spawnSync(["afconvert", "-f", "m4af", "-d", "aac", mp3, m4a]);
  if (p.exitCode !== 0) { log.warn("afconvert failed"); return null; }
  return { file: m4a, duration: await durationOf(m4a) };
}

const mp3Inflight = new Map<string, Promise<string | null>>();
/** ElevenLabs eleven_v4 → mp3 file (cached). Concurrent requests for the same file share one TTS call. */
export function ttsMp3(text: string, outBase: string): Promise<string | null> {
  const mp3 = `${outBase}.mp3`;
  if (existsSync(mp3)) return Promise.resolve(mp3);
  const running = mp3Inflight.get(mp3);
  if (running) return running;
  const p = (async () => {
    let voiceId = config.elevenVoice;
    if (!voiceId) {
      const a: any = await (await fetch(`https://api.elevenlabs.io/v1/convai/agents/${config.elevenAgent}`, { headers: { "xi-api-key": config.elevenKey } })).json();
      voiceId = a?.conversation_config?.tts?.voice_id;
      if (voiceId) config.elevenVoice = voiceId;
    }
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST", headers: { "xi-api-key": config.elevenKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_v4" }), signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { log.warn(`TTS HTTP ${res.status}`); return null; }
    writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
    return mp3;
  })().catch((e) => { log.error("TTS", e); return null; }).finally(() => mp3Inflight.delete(mp3));
  mp3Inflight.set(mp3, p);
  return p;
}

/** Audio for the in-card Listen button: cached per card + script, so a re-tap or a state change doesn't cost another TTS call. */
export function cardAudio(cardId: string): Promise<string | null> {
  const script = scriptFor(cardId);
  if (!script) return Promise.resolve(null);
  const h = Bun.hash(script).toString(36);
  return ttsMp3(script, `${config.dataDir}/media/tts_${cardId}_${h}`);
}

async function durationOf(file: string): Promise<number> {
  const p = Bun.spawnSync(["afinfo", file]);
  const m = p.stdout.toString().match(/estimated duration:\s*([\d.]+)/);
  return m ? Math.max(1, Math.round(Number(m[1]))) : 5;
}

const inflight = new Set<string>();
export async function readAloud(cardId: string) {
  const c = getCard(cardId);
  const script = scriptFor(cardId);
  if (!c || !script) return;
  const key = `${cardId}_v${c.row.version}`;
  if (inflight.has(key)) return; // a second tap while the first voice note is on its way does nothing
  inflight.add(key);
  setTimeout(() => inflight.delete(key), 20000);
  const t0 = Date.now();
  try {
    const h = Bun.hash(script).toString(36);
    const out = await tts(script, `${config.dataDir}/media/tts_${cardId}_${h}`);
    if (!out) return;
    await T.sendVoice(config.ashaHandle, out.file, out.duration);
    decision({ from: "Kin", preview: `🔊 read aloud (${out.duration}s)`, rules: ["her tap"], action: "reply", cardId, ms: Date.now() - t0 });
  } catch (e) { log.error("read aloud", e); }
}

export function writeTmp(path: string, data: string) { writeFileSync(path, data); }

/** Make the Listen audio in the background as soon as a card is sent (skipped in replay tests). */
export function prefetchAudio(cardId: string) {
  if (process.env.KIN_NO_PREFETCH === "1") return;
  void cardAudio(cardId).catch(() => {});
}
