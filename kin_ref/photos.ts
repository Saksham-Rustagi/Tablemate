// Photos + voice notes: save to data/media, convert with macOS built-ins (sips, afconvert), one Gemini multimodal call each.
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, readFileSync, existsSync, copyFileSync } from "fs";
import { config } from "./config";
import { newId } from "./db";
import { log } from "./events";
import { gen, photoMemorySchema, voiceIntentSchema, type PhotoMemory, type VoiceIntent } from "./ai/gemini";

const run = promisify(execFile);
const media = () => `${config.dataDir}/media`;

export type InPhoto = { bytes: Buffer; mimeType: string; name: string };

export const isImage = (mimeType?: string, name?: string) => /^image\//i.test(mimeType ?? "") || /\.(heic|heif|jpe?g|png|gif|webp|tiff?)$/i.test(name ?? "");
export const isAudio = (mimeType?: string, name?: string) => /^audio\//i.test(mimeType ?? "") || /\.(caf|m4a|wav|aiff?|mp3|amr)$/i.test(name ?? "");

function ext(mimeType: string, name: string, fallback: string): string {
  const fromName = name.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  const sub = mimeType.split("/")[1]?.replace(/^x-/, "").replace("jpeg", "jpg").replace("mpeg", "mp3");
  return sub && /^[a-z0-9]{2,5}$/.test(sub) ? sub : fallback;
}

/** Save the original and a ≤800 px JPEG next to it. Returns the JPEG filename (in data/media) + bytes, or null. */
export async function saveImage(p: InPhoto): Promise<{ file: string; jpeg: Buffer } | null> {
  const id = newId("p");
  const orig = `${media()}/${id}_orig.${ext(p.mimeType, p.name, "img")}`;
  const file = `${id}.jpg`;
  const out = `${media()}/${file}`;
  try {
    writeFileSync(orig, p.bytes);
    await run("sips", ["-s", "format", "jpeg", "-Z", "800", orig, "--out", out], { timeout: 20_000 });
  } catch (e) {
    log.warn(`photo convert failed (${(e as any)?.message ?? e})`);
    if (/jpe?g/i.test(p.mimeType) && existsSync(orig)) copyFileSync(orig, out);
  }
  if (!existsSync(out)) return null;
  return { file, jpeg: readFileSync(out) };
}

/** Any audio (CAF voice notes, m4a, aiff) → 16 kHz mono WAV for Gemini. */
export async function toWav(bytes: Buffer, mimeType: string, name = ""): Promise<Buffer | null> {
  if (/audio\/(wav|x-wav|wave)/i.test(mimeType)) return bytes;
  const id = newId("v");
  const inp = `${media()}/${id}_in.${ext(mimeType, name, "caf")}`;
  const out = `${media()}/${id}.wav`;
  try {
    writeFileSync(inp, bytes);
    await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", inp, out], { timeout: 20_000 });
    return readFileSync(out);
  } catch (e) {
    log.warn(`audio convert failed (${(e as any)?.message ?? e})`);
    return null;
  }
}

const inline = (mimeType: string, data: Buffer) => ({ inlineData: { mimeType, data: data.toString("base64") } });

/** One Gemini call: image + the family's caption → a grounded photo memory. Never names people from faces. */
export async function understandPhoto(jpeg: Buffer, caption: string, sender: { name: string; relation: string }, known: string, todayStr: string, ashaName: string, calledBy: string): Promise<PhotoMemory | null> {
  const prompt = `Today is ${todayStr}. ${sender.name} (${ashaName}'s ${sender.relation}) sent Kin this photo for the family memory.
Caption from ${sender.name}: """${caption || "(no caption)"}"""
"${calledBy}", "Mom", "Grandma" mean ${ashaName}. If the caption says "I" or "me", that is ${sender.name}. Known people and things: ${known}.
IMPORTANT: never identify anyone from their face or looks. Only the caption may name people, pets or places.
Fill the schema:
- description: max 15 words, plain, what is visible, for an older reader (no names unless the caption gives them).
- who_in_photo: names written in the CAPTION only (exact words). Empty if the caption names nobody.
- about: the main person, pet, place or event the caption is about (a name from the caption; "${sender.name}" if it is about the sender or there is no caption).
- about_kind: what "about" is.
- memory_text: one third-person sentence combining the caption and what is visible (e.g. "Biscuit played fetch at the park on a sunny day").
- happened_on: YYYY-MM-DD if the caption gives a date or relative day (resolve against today), else null.
- use_as_profile: true only if the caption says this is their picture ("this is me", "use this as my picture").
- confirmation: a short warm reply to ${sender.name} in Kin's voice starting with "Got it 📸", saying what was saved and that Kin will show it to ${calledBy} when it helps.`;
  return gen<PhotoMemory>("photo_memory", [{ text: prompt }, inline("image/jpeg", jpeg)], photoMemorySchema, { timeoutMs: 20_000 });
}

/** One Gemini call: Asha's voice note → transcript + what she wants. */
export async function understandVoice(wav: Buffer, familyNames: string[], ashaName: string): Promise<VoiceIntent | null> {
  const prompt = `${ashaName}, 78, living with memory loss, sent Kin (her helper) this voice message. Her family: ${familyNames.join(", ")}.
Fill the schema:
- transcript: exactly what she said.
- intent: "reply" if she wants a message sent to a family member ("tell Priya I can't wait to see her"); "call_me" if she wants someone to call her; "question" if she asks who someone is; else "other".
- to_person: the family name she means (one of: ${familyNames.join(", ")}), or null.
- text: for "reply", the message to send in HER words, first person, addressed to that person, cleaned up, max 120 characters (e.g. "I can't wait to see you!"). For "question", the name she asked about. Else "".`;
  return gen<VoiceIntent>("voice_intent", [{ text: prompt }, inline("audio/wav", wav)], voiceIntentSchema, { timeoutMs: 20_000 });
}

export const inlineImage = (jpeg: Buffer) => inline("image/jpeg", jpeg);
