import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { LRUCache } from "lru-cache";
import { request as undiciRequest } from "undici";

// ----- Config (edit in Render env later; defaults here are safe) -----
const PORT = process.env.PORT || 3000;
const PROXY_KEY = process.env.PROXY_KEY || "change-me";
const ALLOWED_PREFIXES = [
  { base: "https://catalog.roblox.com", mount: "/catalog" },
  { base: "https://games.roblox.com",   mount: "/games"  },
];
// Cache ~1000 GETs for 30s to reduce upstream load
const cache = new LRUCache({ max: 1000, ttl: 30_000 });

// ----- App hardening -----
const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(compression());

// Global rate limit (per IP) as a safety belt; tune if needed
app.use(rateLimit({ windowMs: 60_000, max: 300 })); // 300 req/min/IP

// Health endpoint for Render
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// Auth middleware (API key)
app.use((req, res, next) => {
  if (req.path === "/healthz") return next();
  const key = req.header("x-proxy-key");
  if (key !== PROXY_KEY) return res.status(403).send("Forbidden");
  next();
});

// Helper: maps incoming path to target Roblox URL and forwards query string
function resolveTarget(req) {
  const match = ALLOWED_PREFIXES.find(p => req.path.startsWith(p.mount));
  if (!match) return null;
  const remainder = req.path.slice(match.mount.length); // keep leading slash
  const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return match.base + remainder + search;
}

// Main proxy (GET/HEAD only for safety)
app.all(["/catalog/*", "/games/*"], async (req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).send("Method Not Allowed");
  const target = resolveTarget(req);
  if (!target) return res.status(404).send("Not allowed");

  // Cache key is method + full target url
  const cacheKey = req.method + ":" + target;
  if (req.method === "GET") {
    const cached = cache.get(cacheKey);
    if (cached) {
      for (const [k, v] of Object.entries(cached.headers)) res.setHeader(k, v);
      return res.status(cached.status).send(cached.body);
    }
  }

  // Forward request with header cleanup, timeout & one retry
  const forward = async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000); // 8s timeout
    try {
      const resp = await undiciRequest(target, {
        method: req.method,
        headers: {
          // Pass minimal headers
          "accept": req.get("accept") || "*/*",
          "user-agent": "roblox-proxy/1.0"
        },
        body: undefined,
        signal: controller.signal,
        maxRedirections: 2
      });
      clearTimeout(t);
      const body = await resp.body.text();

      // CORS so Roblox HttpService is happy
      const headers = {
        "content-type": resp.headers["content-type"] || "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "cache-control": "public, max-age=30" // mirrors our 30s cache
      };

      if (req.method === "GET" && resp.status === 200) {
        cache.set(cacheKey, { status: resp.status, headers, body });
      }

      res.status(resp.status);
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      return res.send(body);
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  };

  try {
    try {
      return await forward();
    } catch {
      // one retry after brief wait
      await new Promise(r => setTimeout(r, 150));
      return await forward();
    }
  } catch (e) {
    return res.status(502).send("Upstream error");
  }
});

app.use((req, res) => res.status(404).send("Not found"));

app.listen(PORT, () => console.log(`Proxy listening on :${PORT}`));
