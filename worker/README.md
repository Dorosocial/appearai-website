# AppearAI scanner worker

Runs the free scan behind appearai.io. It asks real buyer questions to Claude
(with web search) and Gemini (from its built-in knowledge; Google Search grounding needs paid billing) and checks whether the brand
appears in their answers. No results are simulated.

## Deploy (Cloudflare dashboard)

1. Workers & Pages → `appearai-checker` → **Edit code**.
2. Replace everything with the contents of `worker.js` → **Deploy**.
3. Settings → **Variables and Secrets** → add these as type **Secret**:
   - `ANTHROPIC_API_KEY`: from console.anthropic.com
   - `GEMINI_API_KEY`: from aistudio.google.com
   - `SCAN_SECRET`: any long random string (it signs scan tokens)
4. Optional variables (type Text):
   - `DAILY_SCAN_CAP`: scans per day for everyone (default 40)
   - `PER_IP_DAILY_CAP`: scans per visitor per day (default 3)
   - `GEMINI_MODEL`: default `gemini-flash-lite-latest`
5. Recommended: Storage & Databases → **KV** → create a namespace, then in the
   worker's Settings → **Bindings** → add a KV binding named `SCANS`. Without it
   the daily limits are switched off.

## Cost

Each scan makes 20 Claude Haiku calls with web search (about $0.20–0.25 per scan,
mostly search fees) plus 21 small Claude calls (prompt writing and brand
extraction). Gemini calls use the free tier. `DAILY_SCAN_CAP` bounds daily spend.
