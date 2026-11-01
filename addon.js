// StreamFree Stremio Addon — single file, zero dependencies
// Requires Node.js 18+ (built-in fetch). Run with: node addon.js
// Set PORT env var if needed (default 3000).
//
// Endpoints:
//   /manifest.json                          -> addon manifest
//   /catalog/tvchannel/live.json            -> live & upcoming events
//   /catalog/tvchannel/live/skip=N.json     -> pagination
//   /catalog/tvchannel/live/search=abc.json -> search
//   /meta/tvchannel/strmfree:KEY.json       -> event details
//   /stream/tvchannel/strmfree:KEY.json     -> available streams
//   /                                       -> landing page with install button

"use strict";

const http = require("http");
const API = "https://strmfree.st/api/v1";
const PORT = process.env.PORT || 3000;
const ID_PREFIX = "strmfree:";
const TYPE = "tvchannel";

// ---------- upstream API with caching (docs ask us not to hammer it) ----------

const cache = new Map(); // url -> { expires, data }
const TTL = 60 * 1000; // 60 seconds

async function apiFetch(path) {
  const url = API + path;
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.data;
  const res = await fetch(url, {
    headers: { "User-Agent": "StremioStreamFreeAddon/1.0", Accept: "application/json" },
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error("upstream " + res.status);
  }
  const data = await res.json();
  cache.set(url, { expires: Date.now() + TTL, data });
  return data;
}

// ---------- helpers ----------

function keyToId(key) {
  return ID_PREFIX + key;
}
function idToKey(id) {
  return id && id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : null;
}
const DIRECT_RE = /\.(m3u8|mpd|mp4|ts|m3u)(\?|#|$)/i;

function toMeta(s) {
  const when = s.match_timestamp
    ? new Date(s.match_timestamp * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "unknown time";
  return {
    id: keyToId(s.stream_key),
    type: TYPE,
    name: s.name,
    poster: s.thumbnail_url || null,
    background: s.thumbnail_url || null,
    logo: s.thumbnail_url || null,
    genres: [s.category, s.league].filter(Boolean),
    description:
      (s.league ? s.league + " — " : "") +
      "Category: " + s.category + ". Scheduled: " + when +
      ". Live bronnen verschijnen automatisch zodra het evenement start.",
    releaseInfo: s.match_timestamp ? String(new Date(s.match_timestamp * 1000).getFullYear()) : undefined,
    runtime: "LIVE",
  };
}

// ---------- addon resources ----------

const manifest = {
  id: "org.strmfree.sports",
  version: "1.0.0",
  name: "StreamFree Live Sports",
  description: "Live en aankomende sportevenementen via de openbare StreamFree API. Direct speelbare bronnen worden in Stremio afgespeeld; embed-pagina's openen in je browser.",
  types: [TYPE],
  resources: ["catalog", "meta", "stream"],
  catalogs: [
    {
      type: TYPE,
      id: "live",
      name: "StreamFree: Live & Upcoming",
      extraSupported: ["search", "skip"],
      extraRequired: [],
    },
  ],
  idPrefixes: [ID_PREFIX],
  behaviorHints: { adult: false, p2p: false },
};

async function getCatalog(args) {
  const data = await apiFetch("/streams");
  let streams = (data && data.streams) || [];
  if (args.search) {
    const q = args.search.toLowerCase();
    streams = streams.filter((s) =>
      (s.name + " " + (s.league || "") + " " + (s.category || "")).toLowerCase().includes(q)
    );
  }
  const skip = parseInt(args.skip || "0", 10) || 0;
  const page = streams.slice(skip, skip + 100);
  return { metas: page.map(toMeta) };
}

async function getMeta(args) {
  const key = idToKey(args.id);
  if (!key) return { meta: null };
  const s = await apiFetch("/streams/" + encodeURIComponent(key));
  if (!s) return { meta: null };
  return { meta: toMeta(s) };
}

async function getStreams(args) {
  const key = idToKey(args.id);
  if (!key) return { streams: [] };
  let data;
  try {
    data = await apiFetch("/sources/" + encodeURIComponent(key));
  } catch (e) {
    data = null;
  }
  if (!data) return { streams: [] };

  const sources = (data.live_sources && data.live_sources.length ? data.live_sources : data.sources) || [];
  const streams = sources.map((src) => {
    if (DIRECT_RE.test(src.url)) {
      return { title: "StreamFree " + src.quality, url: src.url };
    }
    // Embed page: Stremio can't play iframes, so open it in the browser
    return {
      name: "StreamFree",
      title: "StreamFree " + src.quality,
      description: "Opent de StreamFree-speler in je browser",
      externalUrl: src.url,
    };
  });
  if (!streams.length) {
    streams.push({
      name: "StreamFree",
      title: "Nog niet live",
      description: "Dit evenement is momenteel niet live. Probeer het weer rond de aftrap.",
      externalUrl: "https://strmfree.st/",
    });
  }
  return { streams };
}

// ---------- http plumbing ----------

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=60",
  });
  res.end(payload);
}

function landing(req, res) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:" + PORT;
  const proto = req.headers["x-forwarded-proto"] || (String(host).startsWith("localhost") ? "http" : "https");
  const install = "stremio://" + host + "/manifest.json";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>StreamFree Stremio Addon</title>
     <style>body{font-family:system-ui,sans-serif;background:#0e0e10;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
     .card{max-width:560px;padding:40px;text-align:center}h1{color:#7b5cff}a.btn{display:inline-block;margin-top:16px;padding:12px 24px;background:#7b5cff;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}</style></head>
     <body><div class="card"><h1>StreamFree Live Sports</h1>
     <p>Stremio-addon voor live sportevenementen via de openbare StreamFree API.</p>
     <a class="btn" href="${install}">Add to Stremio</a>
     <p style="opacity:.6;font-size:.85em">Of voeg handmatig toe: <code>${proto}://${host}/manifest.json</code></p>
     </div></body></html>`
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "/manifest.json") {
      if (p === "/") return landing(req, res);
      return json(res, 200, manifest);
    }
    let m = p.match(/^\/catalog\/([^/]+)\/([^/]+)\.json$/);
    if (m) {
      const [, type, id] = m;
      const extra = {};
      for (const [k, v] of url.searchParams) extra[k] = v;
      // also support /catalog/type/id/search=.../skip=N.json style
      const rest = p.match(/\/catalog\/([^/]+)\/([^/]+)\/(.+)\.json$/);
      if (rest) {
        const parts = rest[3].split("/");
        for (const part of parts) {
          const [k, v] = part.split("=");
          if (k && v !== undefined) extra[k] = v;
        }
      }
      const out = await getCatalog({ type, id, ...extra });
      return json(res, 200, out);
    }
    m = p.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (m) return json(res, 200, await getMeta({ type: m[1], id: m[2] }));
    m = p.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (m) return json(res, 200, await getStreams({ type: m[1], id: m[2] }));
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 502, { error: "upstream error: " + e.message });
  }
});

server.listen(PORT, () => {
  console.log("StreamFree Stremio addon draait op poort " + PORT);
  console.log("Installeer in Stremio via: stremio://localhost:" + PORT + "/manifest.json");
});