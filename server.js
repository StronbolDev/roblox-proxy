import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { LRUCache } from "lru-cache";
import { request as urequest } from "undici";

const PORT = process.env.PORT || 3000;
const PROXY_KEY = process.env.PROXY_KEY || "change-me";

const ALLOWED = [
  { mount: "/catalog", target: "https://catalog.roblox.com" },
  { mount: "/games",   target: "https://games.roblox.com"   }
];

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(compression());
app.use(rateLimit({ windowMs: 60_000, max: 300 }));

const cache = new LRUCache({ max: 1000, ttl: 30_000 });

app.get("/healthz", (_, res) => res.status(200).send("ok"));

app.use((req, res, next) => {
  if (req.path === "/healthz") return next();
  const key = req.header("x-proxy-key");
  if (key !== PROXY_KEY) return res.status(403).send("Forbidden");
  next();
});

function mapTarget(req) {
  const match = ALLOWED.find(a => req.path.startsWith(a.mount));
  if (!match) return null;
  const rest = req.path.slice(match.mount.length) || "";
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return match.target + rest + qs;
}

app.all(["/catalog/*", "/games/*"], async (req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).send("Method Not Allowed");

  const target = mapTarget(req);
  if (!target) return res.status(404).send("Not allowed");

  const cacheKey = req.method + ":" + target;
  if (req.method === "GET") {
    const cached = cache.get(cacheKey);
    if (cached) {
      for (const [k, v] of Object.entries(cached.headers)) res.setHeader(k, v);
      return res.status(cached.status).send(cached.body);
    }
  }

  const attempt = async () => {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 15000);

    try {
      const resp = await urequest(target, {
        method: req.method,
        headers: {
          "accept": req.get("accept") || "*/*",
          "user-agent": "roblox-proxy/1.2"
        },
        maxRedirections: 2,
        signal: ac.signal
      });
      clearTimeout(tm);

      const text = await resp.body.text();
      const ct = resp.headers.get ? resp.headers.get("content-type") : (resp.headers["content-type"] || null);

      const headers = {
        "content-type": ct || "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "cache-control": "public, max-age=30"
      };

      if (resp.statusCode >= 200 && resp.statusCode < 300 && req.method === "GET") {
        cache.set(cacheKey, { status: resp.statusCode, headers, body: text });
      }

      res.status(resp.statusCode);
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      return res.send(text);
    } catch (e) {
      clearTimeout(tm);
      console.error("[UPSTREAM ERR]", target, e?.message);
      throw e;
    }
  };

  const waits = [0, 200, 400].map(ms => ms + Math.floor(Math.random() * 150));
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await new Promise(r => setTimeout(r, waits[i]));
    try { return await attempt(); } catch {}
  }
  return res.status(502).send("Upstream error");
});

app.use((_, res) => res.status(404).send("Not found"));

app.listen(PORT, () => console.log(`Proxy listening on :${PORT}`));
