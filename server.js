app.all(["/catalog/*", "/games/*"], async (req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).send("Method Not Allowed");
  const target = resolveTarget(req);
  if (!target) return res.status(404).send("Not allowed");

  const cacheKey = req.method + ":" + target;
  if (req.method === "GET") {
    const cached = cache.get(cacheKey);
    if (cached) {
      for (const [k, v] of Object.entries(cached.headers)) res.setHeader(k, v);
      return res.status(cached.status).send(cached.body);
    }
  }

  const tryOnce = async () => {
    const { request: ureq } = await import("undici");
    const controller = new AbortController();
    const tm = setTimeout(() => controller.abort(), 15000); // 15s
    try {
      const resp = await ureq(target, {
        method: req.method,
        headers: {
          "accept": req.get("accept") || "*/*",
          "user-agent": "roblox-proxy/1.2"
        },
        signal: controller.signal,
        maxRedirections: 2
      });
      clearTimeout(tm);
      const text = await resp.body.text();

      // Log non-2xx to Render logs for debugging
      if (resp.status < 200 || resp.status >= 300) {
        console.warn("[UPSTREAM]", resp.status, target, text.slice(0, 200));
      }

      const headers = {
        "content-type": resp.headers["content-type"] || "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "cache-control": "public, max-age=30"
      };
      if (req.method === "GET" && resp.status === 200) {
        cache.set(cacheKey, { status: resp.status, headers, body: text });
      }
      res.status(resp.status);
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      return res.send(text);
    } catch (e) {
      clearTimeout(tm);
      console.error("[UPSTREAM ERR]", target, e && e.message);
      throw e;
    }
  };

  // 3 attempts with jittered backoff
  const sleeps = [0, 200, 400].map(ms => ms + Math.floor(Math.random()*150));
  for (let i = 0; i < sleeps.length; i++) {
    if (i) await new Promise(r => setTimeout(r, sleeps[i]));
    try { return await tryOnce(); } catch {}
  }
  return res.status(502).send("Upstream error");
});
