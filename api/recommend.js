// Vercel serverless function: AI WEEK speech recommender.
// Proxies to Cerebras (GLM-4.7). API key stays server-side (env CEREBRAS_API_KEY).
const catalog = require("../data/ai_catalog.json");

const TZ = "Europe/Rome";
const MODEL = process.env.CEREBRAS_MODEL || "zai-glm-4.7";
const ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";

// "2026-05-19T11:15:00" treated as Rome wall-clock -> epoch ms (Rome is +02:00 CEST in May)
function romeToMs(naive) {
  return new Date(naive.replace(" ", "T") + "+02:00").getTime();
}
function nowRome(override) {
  if (override) {
    const t = new Date(override).getTime();
    if (!isNaN(t)) return t;
  }
  // current instant; comparisons use absolute epoch so TZ-correct regardless of server TZ
  return Date.now();
}
function fmt(ms) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit"
  }).format(new Date(ms));
}

const SYSTEM_PROMPT = `You are "AI WEEK Concierge", the on-site personal program advisor for AI WEEK 2026 — Europe's #1 AI event, held 19–20 May 2026 at Milano Fiera Rho (timezone Europe/Rome). Over 530 sessions run in parallel across ~18 stages. Attendees are overwhelmed; your single job is to tell THIS attendee exactly which talks to walk to, and why, as a clean time-ordered itinerary.

NON-NEGOTIABLE RULES:
1. TIME IS SACRED. You are given the current local time (Europe/Rome) and every session's start/end. NEVER recommend a session that has already ended. Strongly prefer sessions starting at least 10 minutes from now so the attendee can walk there; you may include a session that is on right now only if it is still useful (more than 15 minutes remaining) and clearly flag it as "happening now".
2. ONLY recommend sessions that appear in the provided CATALOG, referenced by their exact "id". Never invent a session, speaker, time, or room. If unsure, omit it.
3. NO CONFLICTS. Do not recommend two sessions whose times overlap. Build a coherent, walkable schedule ordered by start time.
4. BE SELECTIVE. Recommend between 3 and 7 sessions total — the best fits only. Quality over coverage. If little matches, return fewer and say so honestly.
5. PERSONALIZE. Weigh the attendee's self-description, role, chosen interest tags, desired depth level, and free-text notes. Match on substance (the hook / who-it's-for / tags), not just keywords. Respect their seniority preference.
6. Each recommendation needs a SPECIFIC reason (max 28 words) that references THEIR profile ("As a <role> focused on <interest>, this gives you …"). No generic filler.
7. Output MUST be strict minified JSON, no markdown, matching exactly:
{"summary":"<=40 words, warm, direct, references their goal","picks":[{"id":"<catalog id>","reason":"<=28 words, personalized"}],"closing":"<=25 words, one practical tip (e.g. arrive early to a popular stage)"}
Order "picks" by session start time (earliest first). Return only JSON.`;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.CEREBRAS_API_KEY;
  if (!key) return res.status(500).json({ error: "Server missing CEREBRAS_API_KEY" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const { profile = "", role = "", interests = [], level = "any", days = [], notes = "", nowOverride = "" } = body;

  const now = nowRome(nowOverride);

  // Deterministic time + day filter BEFORE the model sees anything.
  let pool = catalog.sessions.filter(s => {
    const endMs = romeToMs(s.d + "T" + s.e + ":00");
    if (endMs <= now) return false;                       // already finished -> never
    if (days && days.length && !days.includes(s.d)) return false;
    return true;
  });
  // Light pre-rank: boost overlap with chosen interest tags, keep it broad enough for the model.
  if (interests && interests.length) {
    pool.sort((a, b) => {
      const sc = x => x.tags.filter(t => interests.includes(t)).length;
      return sc(b) - sc(a);
    });
  }
  pool.sort((a, b) => (a.d + a.s).localeCompare(b.d + b.s));
  // Cap to keep latency/cost sane (still plenty for a 2-day program).
  const trimmed = pool.slice(0, 220).map(s => ({
    id: s.id, day: s.d, start: s.s, end: s.e, room: s.room,
    title: s.t, tags: s.tags, level: s.lvl, who: s.who, hook: s.hook, speakers: s.spk
  }));

  if (!trimmed.length) {
    return res.status(200).json({
      summary: "Every remaining session for the selected day has already ended — check back tomorrow or pick the other day.",
      picks: [], closing: ""
    });
  }

  const userPrompt = [
    `CURRENT LOCAL TIME (Europe/Rome): ${fmt(now)} — epoch ${now}.`,
    `Event days: ${catalog.days.join(", ")}. Venue: ${catalog.event.venue}.`,
    ``,
    `ATTENDEE PROFILE:`,
    `- Self-description: ${profile || "(none given)"}`,
    `- Role: ${role || "(unspecified)"}`,
    `- Interest tags: ${interests.length ? interests.join(", ") : "(none selected)"}`,
    `- Desired depth: ${level}`,
    `- Days they will attend: ${days.length ? days.join(", ") : "any"}`,
    `- Free-text notes: ${notes || "(none)"}`,
    ``,
    `CATALOG (only future sessions, already filtered; pick by exact id):`,
    JSON.stringify(trimmed)
  ].join("\n");

  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_completion_tokens: 100000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ]
      })
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: "LLM error", detail: data });
    }
    let parsed;
    try { parsed = JSON.parse(data.choices[0].message.content); }
    catch { return res.status(502).json({ error: "Bad LLM JSON", raw: data.choices?.[0]?.message?.content }); }

    // Server-side safety net: drop anything not in catalog or already ended.
    const byId = {};
    catalog.sessions.forEach(s => (byId[s.id] = s));
    const picks = (parsed.picks || []).filter(p => {
      const s = byId[p.id];
      if (!s) return false;
      return romeToMs(s.d + "T" + s.e + ":00") > now;
    }).slice(0, 7).map(p => {
      const s = byId[p.id];
      return {
        id: s.id, reason: String(p.reason || "").slice(0, 220),
        title: s.t, day: s.d, start: s.s, end: s.e, room: s.room,
        tags: s.tags, speakers: s.spk, hook: s.hook
      };
    });
    return res.status(200).json({
      summary: String(parsed.summary || "").slice(0, 320),
      picks,
      closing: String(parsed.closing || "").slice(0, 200),
      generatedAt: now
    });
  } catch (e) {
    return res.status(500).json({ error: "Proxy failure", detail: String(e) });
  }
};
