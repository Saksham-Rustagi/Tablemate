// HTTP: card pages + taps (public, via tunnel), talk, media, and the localhost-only dashboard.
import { existsSync } from "fs";
import { config } from "./config";
import { caregiver, db, graph, personById } from "./db";
import { createReminder } from "./reminders";
import { sendTodayCard } from "./today";
import { log, subscribe, recentEvents, emit, type DashEvent } from "./events";
import { checkToken, getCard, renderCardHtml, cardToken } from "./cards/service";
import { renderTalk } from "./cards/talk";
import { renderDashboard } from "./dash/page";
import { onCardAction } from "./kin";
import { geminiUsed } from "./ai/gemini";
import { cardAudio } from "./voice";
import { talkVariables, handleTool, onTalkEnded } from "./tools";

const html = (b: string, status = 200) => new Response(b, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const isLocal = (req: Request) => !req.headers.get("cf-connecting-ip") && !req.headers.get("x-forwarded-for");
const enc = new TextEncoder();

export function startServer(opts: { health: () => { local: boolean; cloud: boolean }; onReset?: () => void }) {
  return Bun.serve({
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      try {
        // ---------- card page ----------
        let m = p.match(/^\/card\/([\w-]+)$/);
        if (m && req.method === "GET") {
          if (!checkToken(m[1], u.searchParams.get("t"))) return html("<h1>This card has expired.</h1>", 403);
          const h = renderCardHtml(m[1]);
          return h ? html(h) : html("<h1>Not found</h1>", 404);
        }
        m = p.match(/^\/card\/([\w-]+)\/act$/);
        if (m && req.method === "POST") {
          const body: any = await req.json().catch(() => ({}));
          if (!checkToken(m[1], body.t)) return Response.json({ ok: false }, { status: 403 });
          return Response.json(await onCardAction(m[1], String(body.action || ""), body.payload ?? {}));
        }
        m = p.match(/^\/card\/([\w-]+)\/audio$/);
        if (m && req.method === "GET") {
          if (!checkToken(m[1], u.searchParams.get("t"))) return new Response("expired", { status: 403 });
          const file = await cardAudio(m[1]);
          if (!file) return new Response("no audio", { status: 503 });
          log.info(`listen: playing card ${m[1]} in the card`);
          const buf = new Uint8Array(await Bun.file(file).arrayBuffer());
          const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
          const head = { "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "no-store" };
          if (range) {
            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
            return new Response(buf.slice(start, end + 1), { status: 206, headers: { ...head, "content-range": `bytes ${start}-${end}/${buf.length}`, "content-length": String(end - start + 1) } });
          }
          return new Response(buf, { headers: { ...head, "content-length": String(buf.length) } });
        }
        // ---------- talk to Kin ----------
        m = p.match(/^\/talk\/([\w-]+)$/);
        if (m && req.method === "GET") {
          if (!checkToken(m[1], u.searchParams.get("t"))) return html("<h1>Expired</h1>", 403);
          const c = getCard(m[1]);
          return html(renderTalk({ cardId: m[1], token: cardToken(m[1]), base: config.publicBase, title: c?.data.title ?? "your family" }));
        }
        m = p.match(/^\/talk\/([\w-]+)\/session$/);
        if (m && req.method === "POST") {
          if (!checkToken(m[1], u.searchParams.get("t"))) return Response.json({ ok: false }, { status: 403 });
          const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${config.elevenAgent}`, { headers: { "xi-api-key": config.elevenKey } });
          const j: any = await r.json();
          log.info(`talk to Kin: session for card ${m[1]} (token ${r.status})`);
          return Response.json(r.ok ? { ok: true, conversationToken: j.token, dynamicVariables: talkVariables(m[1]) } : { ok: false, error: `token ${r.status}` });
        }
        m = p.match(/^\/talk\/([\w-]+)\/end$/);
        if (m && req.method === "POST") {
          if (!checkToken(m[1], u.searchParams.get("t"))) return Response.json({ ok: false }, { status: 403 });
          return Response.json({ ok: await onTalkEnded(m[1]) });
        }
        // ---------- Talk to Kin webhook tools (called by the ElevenLabs agent, X-Kin-Secret) ----------
        m = p.match(/^\/tools\/(send_reply|ask_family_to_call|mark_reminder_done)$/);
        if (m && req.method === "POST") {
          const args: any = await req.json().catch(() => ({}));
          const r = await handleTool(m[1], req.headers.get("x-kin-secret"), args);
          return Response.json(r.body, { status: r.status });
        }
        if (p === "/diag" && req.method === "POST") {
          const d: any = await req.json().catch(() => ({}));
          log.info(`device: ${d.page ?? "?"} ${d.ev ?? "load"} ${d.id ?? ""} ${d.w ? `${d.w}x${d.h}` : ""}${d.msg ? " " + d.msg : ""}`);
          return new Response("ok");
        }
        // ---------- media (photos for cards) ----------
        m = p.match(/^\/media\/([\w.-]+\.(?:jpg|jpeg|png))$/);
        if (m && req.method === "GET") {
          const f = `${config.dataDir}/media/${m[1]}`;
          return existsSync(f) ? new Response(Bun.file(f)) : new Response("not found", { status: 404 });
        }
        if (p === "/health") return Response.json({ ok: true, ...opts.health(), gemini: geminiUsed() });

        // ---------- dashboard (localhost only) ----------
        if (p.startsWith("/dash")) {
          if (!isLocal(req)) return new Response("not found", { status: 404 });
          if (p === "/dash") return html(renderDashboard({}));
          if (p === "/dash/graph.json") return Response.json(graph());
          if (p === "/dash/reset" && req.method === "POST") { opts.onReset?.(); return Response.json({ ok: true }); }
          if (p === "/dash/test-reminder" && req.method === "POST") {
            const priya = personById("priya") ?? caregiver();
            if (!priya) return Response.json({ ok: false, error: "no caregiver" }, { status: 409 });
            const r = await createReminder(priya, { text: "Take your 2pm pill 💊", due_local: null, daily: true, in_minutes: 0.25 });
            // Always 15 s from now, even if DEMO_REMINDER_SEC is set.
            const due = new Date(Date.now() + 15_000).toISOString();
            db.query("UPDATE reminder SET due_at = ? WHERE id = ?").run(due, r.id);
            log.info(`dashboard: test reminder ${r.id} from ${priya.name}, due in 15 s`);
            return Response.json({ ok: true, id: r.id, due });
          }
          if (p === "/dash/today" && req.method === "POST") {
            const c = await sendTodayCard();
            log.info(`dashboard: ☀️ Today card ${c.id}${c.sent ? "" : " (not sent)"}`);
            return Response.json({ ok: true, id: c.id, sent: c.sent });
          }
          if (p === "/dash/events") {
            let unsub = () => {};
            const stream = new ReadableStream({
              start(ctrl) {
                const send = (e: DashEvent) => { try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { unsub(); } };
                for (const e of recentEvents()) send(e);
                const h = opts.health();
                send({ kind: "health", local: h.local, cloud: h.cloud, tunnel: !!config.publicBase, gemini: { used: geminiUsed(), limit: config.geminiDailyLimit } });
                unsub = subscribe(send);
                const ka = setInterval(() => { try { ctrl.enqueue(enc.encode(`: ka\n\n`)); } catch { clearInterval(ka); } }, 15000);
              },
              cancel() { unsub(); },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
          }
        }
        return new Response("not found", { status: 404 });
      } catch (e) {
        log.error(`HTTP ${p}`, e);
        return Response.json({ ok: false }, { status: 500 });
      }
    },
  });
}

/** Push a health event every 10 s for the dashboard. */
export function startHealthTicker(health: () => { local: boolean; cloud: boolean }) {
  setInterval(() => {
    const h = health();
    emit({ kind: "health", local: h.local, cloud: h.cloud, tunnel: !!config.publicBase, gemini: { used: geminiUsed(), limit: config.geminiDailyLimit } });
  }, 10000);
}
