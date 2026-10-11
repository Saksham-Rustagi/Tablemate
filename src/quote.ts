// Quote verification shared by brain.ts and memory.ts: a fact's quote must really appear in the member's message.
const norm = (s: string) =>
  s.normalize("NFKC").replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

/** Removes a leading "Speaker:" the model may copy from the prompt format, plus wrapping quotes. */
export function cleanQuote(quote: string, speakerName?: string): string {
  let q = (quote ?? "").trim().replace(/^["'\u201C\u2018]+|["'\u201D\u2019]+$/g, "").trim();
  if (speakerName) {
    const p = new RegExp("^" + speakerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:\\s*", "i");
    q = q.replace(p, "");
  }
  return q.trim();
}

/** True when the (cleaned) quote is a contiguous run of the message's words, ignoring case, punctuation and curly quotes. */
export function quoteIn(quote: string, text: string, speakerName?: string): boolean {
  const q = norm(cleanQuote(quote, speakerName));
  if (q.length < 2) return false;
  return (" " + norm(text) + " ").includes(" " + q + " ");
}
