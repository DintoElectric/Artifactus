// DM Table API: one function, stored in Netlify Blobs (no external database).
//   POST   /api/table             create a table                 { pin }
//   POST   /api/login/CODE        DM sign-in                     { pin }
//   GET    /api/state/CODE        players poll (hidden info stripped)
//   PUT    /api/state/CODE        DM saves state                 header x-pin
//   PUT    /api/map/CODE          DM uploads map image           header x-pin
//   GET    /api/map/CODE          map image
//   PUT    /api/fog/CODE          DM uploads fog mask (PNG)      header x-pin
//   GET    /api/fog/CODE          fog mask
//   PUT    /api/img/CODE/ID       DM uploads a token image       header x-pin
//   GET    /api/img/CODE/ID       token image
//   DELETE /api/img/CODE/ID       remove a token image           header x-pin
//   POST   /api/initiative/CODE   a player sends their initiative { id, init }
//   GET    /api/subs/CODE         DM reads submitted initiatives header x-pin
import { getStore } from "@netlify/blobs";

const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fail = (status, error) => reply({ error }, status);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => ALPHABET[b % ALPHABET.length]).join("");
const cleanId = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 24);

async function hash(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const blankState = () => ({
  rev: 1,
  mapRev: 0,
  mapW: 0,
  mapH: 0,
  mapOn: false,
  subT: 0,
  grid: { on: false, size: 60, snap: false },
  fog: { on: false, rev: 0 },
  ents: [],
  inv: { stash: [], dm: [] },
  init: { list: [], turnId: null, round: 1, on: false },
});

// What players are allowed to see: no hidden tokens, no enemy/NPC HP, no DM-only items.
function publicView(s) {
  const visible = new Set();
  const ents = (s.ents || [])
    .filter((e) => !e.hidden)
    .map((e) => {
      visible.add(e.id);
      return e.type === "pc" ? e : { ...e, hp: null, maxHp: null };
    });
  const inv = { stash: s.inv?.stash || [] };
  for (const e of ents) if (e.type === "pc") inv[e.id] = s.inv?.[e.id] || [];
  const init = s.init || {};
  return {
    ...s,
    ents,
    inv,
    init: {
      ...init,
      list: (init.list || []).filter((i) => visible.has(i.id)),
      turnId: visible.has(init.turnId) ? init.turnId : null,
    },
  };
}

const KB = 1024;
const MAX_MAP = 4.6 * KB * KB;
const MAX_FOG = 600 * KB;
const MAX_IMG = 400 * KB;

const imageResponse = (r, fallbackType) =>
  new Response(r.data, {
    headers: {
      "content-type": r.metadata?.type || fallbackType,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });

export default async (req) => {
  const store = getStore({ name: "dm-tables", consistency: "strong" });
  const url = new URL(req.url);
  const [route, rawRoom, rawId] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const room = (rawRoom || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  try {
    if (route === "table" && req.method === "POST") {
      const { pin } = await req.json().catch(() => ({}));
      if (typeof pin !== "string" || pin.length < 4 || pin.length > 32) {
        return fail(400, "Choose a DM PIN with at least 4 characters.");
      }
      let code = "";
      for (let i = 0; i < 6; i++) {
        const c = makeCode();
        if (!(await store.get(`meta/${c}`))) { code = c; break; }
      }
      if (!code) return fail(500, "Could not make a table code. Try again.");
      const state = blankState();
      await store.setJSON(`meta/${code}`, { pinHash: await hash(pin), created: Date.now() });
      await store.setJSON(`state/${code}`, state);
      return reply({ room: code, state });
    }

    if (!room) return fail(400, "Missing table code.");
    const meta = await store.get(`meta/${room}`, { type: "json" });
    if (!meta) return fail(404, "No table with that code.");
    const isDm = async (pin) => !!pin && (await hash(pin)) === meta.pinHash;
    const dmOnly = async () => ((await isDm(req.headers.get("x-pin"))) ? null : fail(401, "Wrong PIN."));

    if (route === "login" && req.method === "POST") {
      const { pin } = await req.json().catch(() => ({}));
      if (!(await isDm(pin))) return fail(401, "Wrong PIN.");
      const state = await store.get(`state/${room}`, { type: "json" });
      return reply({ state: state || blankState() });
    }

    if (route === "state" && req.method === "GET") {
      const state = await store.get(`state/${room}`, { type: "json" });
      if (!state) return fail(404, "No table with that code.");
      const rev = url.searchParams.get("rev");
      if (rev && Number(rev) === state.rev) return reply({ unchanged: true });
      return reply({ state: publicView(state) });
    }

    if (route === "state" && req.method === "PUT") {
      const denied = await dmOnly();
      if (denied) return denied;
      const text = await req.text();
      if (text.length > 400000) return fail(413, "Table data is too large.");
      let s;
      try { s = JSON.parse(text); } catch { return fail(400, "Bad data."); }
      if (!s || !Array.isArray(s.ents)) return fail(400, "Bad data.");
      await store.setJSON(`state/${room}`, s);
      return reply({ ok: true, rev: s.rev });
    }

    // Binary assets: map, fog mask, token images
    const assets = {
      map: { key: `map/${room}`, max: MAX_MAP, type: /^image\// , fallback: "image/jpeg" },
      fog: { key: `fog/${room}`, max: MAX_FOG, type: /^image\/png/, fallback: "image/png" },
      img: { key: `img/${room}/${cleanId(rawId)}`, max: MAX_IMG, type: /^image\//, fallback: "image/jpeg" },
    }[route];

    if (assets) {
      if (route === "img" && !cleanId(rawId)) return fail(400, "Missing token id.");
      if (req.method === "GET") {
        const r = await store.getWithMetadata(assets.key, { type: "arrayBuffer" });
        if (!r) return fail(404, "Not found.");
        return imageResponse(r, assets.fallback);
      }
      if (req.method === "PUT") {
        const denied = await dmOnly();
        if (denied) return denied;
        const type = req.headers.get("content-type") || "";
        if (!assets.type.test(type)) return fail(400, "Wrong file type.");
        const buf = await req.arrayBuffer();
        if (buf.byteLength > assets.max) return fail(413, "That file is too large.");
        await store.set(assets.key, buf, { metadata: { type } });
        return reply({ ok: true });
      }
      if (req.method === "DELETE" && route === "img") {
        const denied = await dmOnly();
        if (denied) return denied;
        await store.delete(assets.key);
        return reply({ ok: true });
      }
    }

    // Players send their own initiative; the DM picks it up and merges it into the tracker.
    if (route === "initiative" && req.method === "POST") {
      const { id, init } = await req.json().catch(() => ({}));
      const n = Number(init);
      if (!Number.isFinite(n) || n < -10 || n > 60) return fail(400, "Initiative must be a number from -10 to 60.");
      const state = await store.get(`state/${room}`, { type: "json" });
      const e = state?.ents?.find((x) => x.id === id);
      if (!e || e.type !== "pc" || e.hidden) return fail(400, "Pick one of the player characters.");
      await store.setJSON(`sub/${room}/${cleanId(id)}`, { id, init: Math.round(n), t: Date.now() });
      return reply({ ok: true });
    }

    if (route === "subs" && req.method === "GET") {
      const denied = await dmOnly();
      if (denied) return denied;
      const { blobs } = await store.list({ prefix: `sub/${room}/` });
      const subs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
      return reply(subs.filter(Boolean));
    }

    return fail(404, "Not found.");
  } catch (err) {
    console.error(err);
    return fail(500, "Something went wrong on the server.");
  }
};

export const config = { path: "/api/*" };
