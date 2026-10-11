// "Talk to Kin" agent config, pushed to ElevenLabs: prompt + first message that use the card's dynamic variables,
// and three server (webhook) tools that call back into /tools/* with the X-Kin-Secret header (stored as an ElevenLabs secret).
import { config } from "./config";
import { kvGet, kvSet } from "./db";
import { log } from "./events";

const API = "https://api.elevenlabs.io/v1/convai";
const SECRET_NAME = "kin_tool_secret";
export const TOOL_NAMES = ["send_reply", "ask_family_to_call", "mark_reminder_done"] as const;

export const AGENT_PROMPT = `You are Kin, a gentle voice helper that {{asha_name}}'s family set up for her. {{asha_name}} is 78 and is a person living with memory loss.
You are talking with her about one card on her phone (card {{card_id}}). Why she opened it: {{reason}}.

What you know about this card:
- From: {{from_name}} (her {{relation}})
- Their message: "{{message_text}}"
- A memory to share: {{memory_line}}
- Replies she can send: {{reply_options}}
- Reminder: {{reminder_text}}

How to talk:
- Say you are Kin, the helper her family set up. Never pretend to be family or anyone else.
- Short, simple sentences. Speak slowly and warmly. Use her name, {{asha_name}}.
- Ask one question at a time. Offer at most two choices.
- Use statements, never quizzes. Never ask "do you remember...?" Just tell her gently.
- Never talk about money, bank details, gift cards, passwords or codes. Never give medical advice; say her family or doctor can help with that.
- No small talk beyond what this card needs. If she drifts, kindly bring it back or offer a call with family.

If reason is "message":
1. Tell her who wrote ({{from_name}}, her {{relation}}) and what they said, in plain words. You may add the memory line as a warm statement.
2. Offer to send a reply. Suggest one or two of these: {{reply_options}}. She may also say her own short words.
3. Before sending, read the exact reply back: "I'll send {{from_name}}: '<reply>'. Shall I send it?"
4. Only call send_reply after she clearly says yes. If she hesitates, says no, or seems unsure, do not send. Send only once.
5. After the tool answers, tell her what happened in one short sentence.

If reason is "reminder":
1. Read the reminder: {{reminder_text}}.
2. If she says she has done it, call mark_reminder_done, then tell her "Well done" warmly.
3. If she hasn't, say that's okay and the card will stay on her phone.

If reason is "safety":
1. Reassure her: she is safe and did nothing wrong. A message came from someone her family doesn't know.
2. Tell her not to reply and not to send anything — no money, no codes, no details.
3. Offer to ask her family to call her. If she says yes, call ask_family_to_call.

Any time she is confused, upset, or asks for a person: say "That's okay. I'll let them know you'd like a call." and call ask_family_to_call (unless reason is "reminder"; then just reassure her that her family will check in).

Tools always take card_id {{card_id}}. Never call a tool she hasn't agreed to. Keep the whole talk short, then say a warm goodbye.`;

// {{opening}} is built per card in talkVariables() so one first message reads naturally for message / reminder / safety.
export const FIRST_MESSAGE = "Hi {{asha_name}}, it's Kin, the helper your family set up. {{opening}}";

const PLACEHOLDERS = {
  asha_name: "Asha", reason: "message", from_name: "Priya", relation: "granddaughter", card_id: "c_demo",
  opening: "Priya, your granddaughter, sent you a message. Would you like me to read it?",
  message_text: "Coming over Sunday with mangoes!", reminder_text: "", reply_options: "Yes, see you Sunday! | Call me later",
  memory_line: "Priya brought you mangoes last summer.",
};

type Prop = Record<string, unknown>;
function toolConfig(name: (typeof TOOL_NAMES)[number], base: string, secretId: string, cardIdAsVar: boolean) {
  const cardId: Prop = cardIdAsVar
    ? { type: "string", dynamic_variable: "card_id" }
    : { type: "string", description: "Always pass the card id exactly: {{card_id}}" };
  const spec = {
    send_reply: {
      description: "Send a reply to the family member AS her. Only call after you read the exact reply back to her and she clearly said yes. Text must be one of the reply options or her own short words.",
      props: { card_id: cardId, text: { type: "string", description: "The exact reply she agreed to, under 120 characters." } } as Record<string, Prop>,
    },
    ask_family_to_call: {
      description: "Text her family that she would like a call. Use when she is confused, upset, asks for a person, or after a safety warning if she wants a call.",
      props: { card_id: cardId } as Record<string, Prop>,
    },
    mark_reminder_done: {
      description: "Mark this reminder as done. Only call when she says she has done it.",
      props: { card_id: cardId } as Record<string, Prop>,
    },
  }[name];
  return {
    type: "webhook", name, description: spec.description, response_timeout_secs: 20,
    api_schema: {
      url: `${base}/tools/${name}`, method: "POST", content_type: "application/json",
      request_headers: { "X-Kin-Secret": { secret_id: secretId } },
      request_body_schema: { type: "object", description: `Arguments for ${name}`, properties: spec.props, required: Object.keys(spec.props) },
    },
  };
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${API}${path}`, {
    method, headers: { "xi-api-key": config.elevenKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}
const err = (json: any) => JSON.stringify(json?.detail ?? json).slice(0, 300);

/** Workspace secret holding ELEVENLABS_TOOL_SECRET (the value is never logged). */
async function ensureSecret(): Promise<string> {
  const list = await api("GET", "/secrets");
  const found = (list.json?.secrets ?? []).find((s: any) => s.name === SECRET_NAME);
  if (found) {
    const up = await api("PATCH", `/secrets/${found.secret_id}`, { type: "update", name: SECRET_NAME, value: config.elevenToolSecret });
    if (up.status >= 300) log.warn(`agent sync: secret update ${up.status} (keeping existing)`);
    return found.secret_id;
  }
  const r = await api("POST", "/secrets", { type: "new", name: SECRET_NAME, value: config.elevenToolSecret });
  if (r.status >= 300 || !r.json?.secret_id) throw new Error(`secret create ${r.status} ${err(r.json)}`);
  return r.json.secret_id;
}

/** Create or update each webhook tool in the workspace; returns tool ids. */
async function upsertTools(base: string, secretId: string): Promise<{ ids: string[]; results: string[] }> {
  const list = await api("GET", "/tools");
  const existing = new Map<string, string>();
  for (const t of list.json?.tools ?? []) if (t?.tool_config?.name) existing.set(t.tool_config.name, t.id);
  const ids: string[] = [], results: string[] = [];
  for (const name of TOOL_NAMES) {
    const id = existing.get(name);
    let r: { status: number; json: any } = { status: 0, json: {} };
    // Prefer binding card_id to the {{card_id}} dynamic variable; fall back to an LLM param if the API rejects it.
    for (const asVar of [true, false]) {
      const body = { tool_config: toolConfig(name, base, secretId, asVar) };
      r = id ? await api("PATCH", `/tools/${id}`, body) : await api("POST", "/tools", body);
      if (r.status < 300) break;
      log.warn(`agent sync: tool ${name} ${r.status} (card_id ${asVar ? "as dynamic var" : "as LLM param"}): ${err(r.json)}`);
    }
    if (r.status >= 300) throw new Error(`tool ${name} ${r.status}`);
    ids.push(id ?? r.json.id);
    results.push(`${name} ${id ? "PATCH" : "POST"} ${r.status}`);
  }
  return { ids, results };
}

/** Push prompt, first message, placeholders and tools to the agent. Idempotent (tools are upserted by name). */
export async function syncAgent(): Promise<{ status: number; agentName?: string; tools: string[] }> {
  if (!config.elevenKey || !config.elevenAgent) throw new Error("ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID missing");
  if (!config.publicBase) throw new Error("PUBLIC_BASE_URL missing");
  if (!config.elevenToolSecret) throw new Error("ELEVENLABS_TOOL_SECRET missing");
  const secretId = await ensureSecret();
  const { ids, results } = await upsertTools(config.publicBase, secretId);

  const cur = await api("GET", `/agents/${config.elevenAgent}`);
  if (cur.status >= 300) throw new Error(`agent get ${cur.status}`);
  const prompt = cur.json?.conversation_config?.agent?.prompt ?? {};
  const keep: string[] = (prompt.tool_ids ?? []).filter((x: string) => !ids.includes(x));
  // Drop any inline tools with our names (older config style) so they don't shadow the workspace tools.
  const inline = (prompt.tools ?? []).filter((t: any) => !TOOL_NAMES.includes(t?.name));

  const patch: any = {
    conversation_config: {
      agent: {
        first_message: FIRST_MESSAGE,
        dynamic_variables: { dynamic_variable_placeholders: PLACEHOLDERS },
        prompt: { prompt: AGENT_PROMPT, tool_ids: [...keep, ...ids] },
      },
    },
  };
  if ((prompt.tools ?? []).length !== inline.length) patch.conversation_config.agent.prompt.tools = inline;
  const r = await api("PATCH", `/agents/${config.elevenAgent}`, patch);
  if (r.status >= 300) throw new Error(`agent patch ${r.status} ${err(r.json)}`);
  log.info(`agent sync: "${r.json?.name ?? cur.json?.name}" PATCH ${r.status} · ${results.join(", ")}`);
  return { status: r.status, agentName: r.json?.name ?? cur.json?.name, tools: results };
}

/** Re-sync only when the public base URL changed (the quick-tunnel URL changes on every restart). */
export async function ensureAgentSynced(): Promise<void> {
  if (!config.publicBase || !config.elevenKey || !config.elevenAgent || !config.elevenToolSecret) {
    log.warn("agent sync skipped (PUBLIC_BASE_URL / ElevenLabs agent / ELEVENLABS_TOOL_SECRET not set)");
    return;
  }
  if (kvGet("agent_tools_base") === config.publicBase) return;
  await syncAgent();
  kvSet("agent_tools_base", config.publicBase);
}
