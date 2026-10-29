// AppearAI scanner worker (Cloudflare Workers, no build step: paste into the dashboard editor).
//
// Endpoints
//   GET  /?url=<site>   technical signal checks (7 checks)
//   POST /prompts       generate 20 buyer-intent prompts, returns a signed scan token
//   POST /ask           ask ONE of those prompts to Claude (with web search) and Gemini (built-in knowledge)
//                       and report whether the brand appeared and which brands were named
//
// Secrets / variables (Settings -> Variables and Secrets)
//   ANTHROPIC_API_KEY   secret, required
//   GEMINI_API_KEY      secret, required
//   SCAN_SECRET         secret, required: any long random string, signs scan tokens
//   GEMINI_MODEL        optional, default below
//   DAILY_SCAN_CAP      optional, max scans per day across all visitors (default 40)
//   PER_IP_DAILY_CAP    optional, max scans per visitor per day (default 3)
//   ALLOWED_ORIGINS     optional, comma-separated (default https://appearai.io,https://www.appearai.io)
// KV binding (optional but recommended, enables the daily limits)
//   SCANS               a KV namespace

const CLAUDE_MODEL = "claude-haiku-5-5";
const CLAUDE_WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 3 };
// Free tier: no Google Search grounding, so Gemini answers from its built-in knowledge.
const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";
const PROMPT_COUNT = 20;
const TOKEN_TTL_MS = 20 * 60 * 1000;
const MAX_ASKS_PER_TOKEN = PROMPT_COUNT + 10; // room for a few retries

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json(await techSignals(url.searchParams.get("url")), 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/prompts") {
        return json(await createScan(await request.json(), request, env), 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/ask") {
        return json(await askPrompt(await request.json(), env), 200, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      const status = e.status || 500;
      return json({ error: e.publicMessage || "Something went wrong. Please try again." }, status, cors);
    }
  },
};

// ---------- helpers ----------

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "https://appearai.io,https://www.appearai.io")
    .split(",").map((s) => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function fail(status, publicMessage) {
  const e = new Error(publicMessage);
  e.status = status;
  e.publicMessage = publicMessage;
  return e;
}

function clean(s, max = 120) {
  return String(s || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function normalizeSiteUrl(raw) {
  let u = clean(raw, 300);
  if (!u) throw fail(400, "Please enter a website URL.");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  let parsed;
  try { parsed = new URL(u); } catch { throw fail(400, "That website URL doesn't look valid."); }
  const host = parsed.hostname.toLowerCase();
  if (!["http:", "https:"].includes(parsed.protocol) || !host.includes(".") ||
      host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) {
    throw fail(400, "That website URL doesn't look valid.");
  }
  return parsed;
}

function bareDomain(host) {
  return host.toLowerCase().replace(/^www\./, "");
}

// ---------- technical signals ----------

const TECH_WEIGHTS = { https: 10, schema: 20, robots: 15, llms: 20, metadesc: 15, title: 10, content: 10 };
const AI_BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"];

async function techSignals(rawUrl) {
  const site = normalizeSiteUrl(rawUrl);
  const base = `https://${site.hostname}`;
  const results = {};
  const grade = (id, status) => {
    const w = TECH_WEIGHTS[id];
    results[id] = { status, score: status === "pass" ? w : status === "warn" ? Math.round(w / 2) : 0 };
  };

  let html = "", finalUrl = "", pageOk = false;
  try {
    const r = await fetch(base + site.pathname, { redirect: "follow", headers: { "User-Agent": "AppearAI-Checker/1.0 (+https://appearai.io)" } });
    finalUrl = r.url;
    pageOk = r.ok;
    html = (await r.text()).slice(0, 500000);
  } catch {
    try {
      const r = await fetch(`http://${site.hostname}${site.pathname}`, { redirect: "follow" });
      finalUrl = r.url;
      pageOk = r.ok;
      html = (await r.text()).slice(0, 500000);
    } catch { /* site unreachable */ }
  }
  // A blocked or failed page (e.g. 403 bot protection) can't be graded: report "couldn't check".
  const unreadable = !pageOk;

  grade("https", finalUrl.startsWith("https://") ? "pass" : finalUrl ? "fail" : "warn");

  const hasJsonLd = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
  const hasMicrodata = /itemscope/i.test(html);
  grade("schema", hasJsonLd ? "pass" : hasMicrodata ? "warn" : "fail");

  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
                html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) || [])[1] || "";
  grade("metadesc", desc.trim().length >= 50 ? "pass" : desc.trim().length > 0 ? "warn" : "fail");

  const title = ((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").trim();
  grade("title", title.length >= 10 ? "pass" : title.length > 0 ? "warn" : "fail");

  const h1 = (html.match(/<h1[\s>]/gi) || []).length;
  const h2 = (html.match(/<h2[\s>]/gi) || []).length;
  const words = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  grade("content", h1 >= 1 && h2 >= 2 && words >= 300 ? "pass" : h1 >= 1 || words >= 300 ? "warn" : "fail");

  if (unreadable) {
    for (const id of ["schema", "metadesc", "title", "content"]) results[id] = { status: "unknown", score: 0 };
  }

  try {
    const r = await fetch(`${base}/robots.txt`, { redirect: "follow" });
    if (!r.ok) {
      grade("robots", "pass"); // no robots.txt means nothing is blocked
    } else {
      const robots = (await r.text()).slice(0, 100000);
      const blocked = AI_BOTS.filter((bot) => robotsBlocks(robots, bot));
      grade("robots", blocked.length === 0 ? "pass" : "fail");
      results.robots.blocked = blocked;
    }
  } catch { grade("robots", "warn"); }

  try {
    const r = await fetch(`${base}/llms.txt`, { redirect: "follow" });
    const body = r.ok ? (await r.text()).slice(0, 2000) : "";
    if (r.status === 401 || r.status === 403 || r.status === 429) results.llms = { status: "unknown", score: 0 };
    else grade("llms", r.ok && body.trim() && !/<html/i.test(body) ? "pass" : "fail");
  } catch { grade("llms", "warn"); }

  return { url: finalUrl || base, unreadable, results };
}

function robotsBlocks(text, bot) {
  const groups = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(val.toLowerCase());
    } else if (current && (key === "disallow" || key === "allow")) {
      current.rules.push({ key, val });
    }
  }
  const specific = groups.filter((g) => g.agents.includes(bot.toLowerCase()));
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = applicable.flatMap((g) => g.rules);
  const disallowRoot = rules.some((r) => r.key === "disallow" && r.val === "/");
  const allowRoot = rules.some((r) => r.key === "allow" && r.val === "/");
  return disallowRoot && !allowRoot;
}

// ---------- scan tokens ----------

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "");
}

function b64(obj) { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
function unb64(s) { return JSON.parse(decodeURIComponent(escape(atob(s)))); }

async function signToken(payload, env) {
  const body = b64(payload);
  return `${body}.${await hmac(env.SCAN_SECRET, body)}`;
}

async function verifyToken(token, env) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || sig !== await hmac(env.SCAN_SECRET, body)) throw fail(401, "This scan has expired. Please start a new scan.");
  const payload = unb64(body);
  if (Date.now() > payload.exp) throw fail(401, "This scan has expired. Please start a new scan.");
  return payload;
}

// ---------- rate limits ----------

async function bump(env, key, limit, ttl) {
  if (!env.SCANS) return true; // no KV bound: limits are off
  const n = parseInt((await env.SCANS.get(key)) || "0", 10);
  if (n >= limit) return false;
  await env.SCANS.put(key, String(n + 1), { expirationTtl: ttl });
  return true;
}

// ---------- POST /prompts ----------

async function createScan(body, request, env) {
  if (!env.ANTHROPIC_API_KEY || !env.GEMINI_API_KEY || !env.SCAN_SECRET) throw fail(503, "The scanner is not configured yet.");
  const mode = body.mode === "local" ? "local" : "enterprise";
  const brand = clean(body.name, 80);
  const site = normalizeSiteUrl(body.url);
  const category = clean(body.category, 100);
  const market = clean(body.market || body.city, 80) || "Global";
  const industry = clean(body.industry, 80);
  if (!brand || !category) throw fail(400, "Please fill in all required fields.");

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await bump(env, `ip:${day}:${ip}`, parseInt(env.PER_IP_DAILY_CAP || "3", 10), 172800))) {
    throw fail(429, "You've reached today's free scan limit. Please try again tomorrow.");
  }
  if (!(await bump(env, `all:${day}`, parseInt(env.DAILY_SCAN_CAP || "40", 10), 172800))) {
    throw fail(429, "Today's free scans are used up. Please try again tomorrow.");
  }

  const where = mode === "local" ? `in ${market}` : `for buyers in ${market}`;
  const ask = `Write ${PROMPT_COUNT} different questions a real person might type into an AI assistant when looking for a ${category} ${where}${industry ? ` (industry: ${industry})` : ""}.
Rules:
- Do NOT mention any specific brand, company or business name.
- Mix intents: best options, comparisons, recommendations for a specific need, budget, alternatives, trust/reviews.
- Write them the way people actually ask, one sentence each.`;

  const data = await claude(env, {
    max_tokens: 2000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { prompts: { type: "array", items: { type: "string" } } },
          required: ["prompts"],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: "user", content: ask }],
  });
  const text = data.content.find((b) => b.type === "text")?.text || "{}";
  const prompts = (JSON.parse(text).prompts || []).map((p) => clean(p, 200)).filter(Boolean).slice(0, PROMPT_COUNT);
  if (prompts.length < PROMPT_COUNT) throw fail(502, "Couldn't prepare the scan. Please try again.");

  const scanId = crypto.randomUUID();
  const token = await signToken({
    id: scanId, brand, domain: bareDomain(site.hostname), prompts, exp: Date.now() + TOKEN_TTL_MS,
  }, env);
  return { token, prompts, engines: ["claude", "gemini"] };
}

// ---------- POST /ask ----------

async function askPrompt(body, env) {
  const scan = await verifyToken(body.token, env);
  const i = parseInt(body.index, 10);
  if (!(i >= 0 && i < scan.prompts.length)) throw fail(400, "Invalid prompt.");
  if (!(await bump(env, `tok:${scan.id}`, MAX_ASKS_PER_TOKEN, 3600))) throw fail(429, "This scan has already finished.");
  const prompt = scan.prompts[i];

  const [c, g] = await Promise.allSettled([askClaude(env, prompt), askGemini(env, prompt)]);
  const answers = {
    claude: c.status === "fulfilled" ? c.value : { error: true },
    gemini: g.status === "fulfilled" ? g.value : { error: true },
  };

  for (const a of Object.values(answers)) {
    if (!a.error) a.appeared = mentions(a, scan.brand, scan.domain);
  }

  let brands = { claude: [], gemini: [] };
  try { brands = await extractBrands(env, answers); } catch { /* competitor list is best-effort */ }

  const out = { index: i, prompt };
  for (const [engine, a] of Object.entries(answers)) {
    out[engine] = a.error
      ? { ok: false }
      : { ok: true, appeared: a.appeared, excerpt: a.text.slice(0, 600), brands: brands[engine] || [] };
  }
  return out;
}

function mentions(answer, brand, domain) {
  const hay = (answer.text + " " + answer.sources.join(" ")).toLowerCase();
  const name = brand.toLowerCase();
  const root = domain.split(".")[0];
  if (hay.includes(domain)) return true;
  if (name.length >= 3 && new RegExp(`(^|[^a-z0-9])${escapeRe(name)}([^a-z0-9]|$)`).test(hay)) return true;
  return root.length >= 4 && new RegExp(`(^|[^a-z0-9])${escapeRe(root)}([^a-z0-9]|$)`).test(hay);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ---------- engines ----------

async function claude(env, body, attempt = 0) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, ...body }),
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 2) {
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    return claude(env, body, attempt + 1);
  }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Claude ${r.status}`);
  return data;
}

async function askClaude(env, prompt) {
  const data = await claude(env, {
    max_tokens: 2000,
    output_config: { effort: "low" },
    tools: [CLAUDE_WEB_SEARCH],
    messages: [{ role: "user", content: prompt }],
  });
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const sources = [];
  for (const b of data.content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const s of b.content) if (s.url) sources.push(s.url);
    }
    if (b.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c.url) sources.push(c.url);
    }
  }
  if (!text) throw new Error("Empty Claude answer");
  return { text, sources };
}

async function askGemini(env, prompt, attempt = 0) {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 3) {
    await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)));
    return askGemini(env, prompt, attempt + 1);
  }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Gemini ${r.status}`);
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("").trim();
  // Grounding links are Google redirect URLs; the title carries the source domain.
  const sources = (cand?.groundingMetadata?.groundingChunks || [])
    .map((c) => `${c.web?.title || ""} ${c.web?.uri || ""}`.trim());
  if (!text) throw new Error("Empty Gemini answer");
  return { text, sources };
}

async function extractBrands(env, answers) {
  const parts = Object.entries(answers)
    .filter(([, a]) => !a.error)
    .map(([engine, a]) => `<answer engine="${engine}">\n${a.text.slice(0, 6000)}\n</answer>`);
  if (!parts.length) return {};
  const data = await claude(env, {
    max_tokens: 1500,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            claude: { type: "array", items: { type: "string" } },
            gemini: { type: "array", items: { type: "string" } },
          },
          required: ["claude", "gemini"],
          additionalProperties: false,
        },
      },
    },
    messages: [{
      role: "user",
      content: `List the brand, company, product or business names that each AI answer below recommends or names as an option. Use each name as written in the answer, without duplicates. Use an empty list for an engine with no answer or no names.\n\n${parts.join("\n\n")}`,
    }],
  });
  const text = data.content.find((b) => b.type === "text")?.text || "{}";
  const parsed = JSON.parse(text);
  const tidy = (arr) => (Array.isArray(arr) ? arr : []).map((s) => clean(s, 60)).filter(Boolean).slice(0, 15);
  return { claude: tidy(parsed.claude), gemini: tidy(parsed.gemini) };
}
