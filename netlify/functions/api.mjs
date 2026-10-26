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
//   POST   /api/roll/CODE         add a roll to the feed         { label, total, detail, nat, pid | dm }
//   GET    /api/feed/CODE         DM reads the whole feed        header x-pin
//   DELETE /api/feed/CODE         DM clears the feed             header x-pin
//   GET    /api/sheet/CODE/PID    a player's notes, spell slots and spells
//   PUT    /api/sheet/CODE/PID    save them (compare-and-set on rev) { rev, sheet }
//   GET    /api/sheets/CODE       DM reads every player's sheet  header x-pin
//   POST   /api/hp/CODE           a player sends an HP change to the DM  { id, hp, maxHp }
//   GET    /api/campdoc/CODE      DM reads the campaign details and session log  header x-pin
//   PUT    /api/campdoc/CODE      DM saves them                  { doc }
//   GET    /api/campaign/CODE     what the DM has chosen to share with players
//   GET    /api/locs/CODE         DM reads the saved locations (maps, grid, fog, token spots)  header x-pin
//   PUT    /api/locs/CODE         DM saves them                  { doc }
//   PUT|GET|DELETE /api/map/CODE/LOC, /api/fog/CODE/LOC, /api/thumb/CODE/LOC   a location's own files
//   POST   /api/playerlogin/CODE  player logs into a character   { pid, pin } -> { token }
//   GET    /api/logins/CODE       DM: which characters have a PIN  header x-pin
//   PUT    /api/logins/CODE/PID   DM sets a character's PIN      { pin }
//   DELETE /api/logins/CODE/PID   DM removes it
//   GET    /api/library/CODE      the table's spell library
//   PUT    /api/library/CODE      DM replaces the spell library  { spells }
// Player requests for a locked character carry the header x-player (the login token).
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
  feedOn: false,
  campRev: 0,
  locId: "",
  locName: "",
  objectives: [],
  grid: { on: false, size: 60, snap: false, opacity: 0.3, dark: false, ox: 0, oy: 0, areas: [] },
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
    objectives: (s.objectives || []).filter((o) => !o.hidden),
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
const MAX_THUMB = 150 * KB;

/* Roll feed. Each roll is its own blob whose KEY carries the data, so one list call reads
   the whole feed and two rolls at the same moment can never overwrite each other. */
const FEED_MAX = 60;
const feedPrefix = (room) => `roll/${room}/`;
const feedKeys = async (store, room) =>
  (await store.list({ prefix: feedPrefix(room) })).blobs.map((b) => b.key).sort();
const keyTime = (key, room) => {
  const n = feedPrefix(room).length;
  return Number(key.slice(n, n + 13)) || 0;
};
function decodeRoll(key, room) {
  try {
    const o = JSON.parse(Buffer.from(key.slice(feedPrefix(room).length + 14), "base64url").toString("utf8"));
    return { ...o, t: keyTime(key, room) };
  } catch { return null; }
}
const readFeed = (keys, room, limit) =>
  keys.slice(-limit).reverse().map((k) => decodeRoll(k, room)).filter(Boolean);

/* Player logins: the DM gives a character a PIN. Only a salted hash is stored. The login token is
   derived from that hash, so changing the PIN signs the old devices out. */
const loginKey = (room, pid) => `login/${room}/${pid}`;
const pinHash = (room, pid, pin) => hash(`${room}|${pid}|${pin}`);
const tokenOf = (login) => hash(`tok|${login.pinHash}`);
const WINDOW = 10 * 60 * 1000;

/* Spell library */
const cleanLib = (list) =>
  (Array.isArray(list) ? list : []).slice(0, 1500).map((p) => ({
    name: str(p?.name, 80).trim(),
    level: int(p?.level, 0, 9),
    school: str(p?.school, 30),
    time: str(p?.time, 40),
    range: str(p?.range, 40),
    comp: str(p?.comp, 60),
    dur: str(p?.dur, 40),
    classes: str(p?.classes, 60),
    desc: str(p?.desc, 4000),
  })).filter((p) => p.name);

/* Player sheets: notes, spell slots and known spells. One blob per character, saved with a
   revision check so the DM and the player can both edit without overwriting each other. */
const ABIL = ["str", "dex", "con", "int", "wis", "cha"];
const SKILL_KEYS = ["acrobatics", "animal", "arcana", "athletics", "deception", "history", "insight", "intimidation", "investigation",
  "medicine", "nature", "perception", "performance", "persuasion", "religion", "sleight", "stealth", "survival"];
const num = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const rid = () => Math.random().toString(36).slice(2, 9);

/* The character sheet proper: identity, abilities, saves, skills, combat numbers, attacks, text. */
function cleanChar(c) {
  c = c && typeof c === "object" ? c : {};
  const info = c.info || {}, ab = c.abilities || {}, sv = c.saves || {}, sk = c.skills || {};
  const cb = c.combat || {}, tx = c.text || {}, co = c.coins || {};
  const abilities = {}, saves = {};
  for (const k of ABIL) { abilities[k] = num(ab[k], 1, 30, 10); saves[k] = !!sv[k]; }
  const skills = {};
  for (const k of SKILL_KEYS) { const v = num(sk[k], 0, 2, 0); if (v) skills[k] = v; }
  return {
    info: {
      class: str(info.class, 40), race: str(info.race, 40), background: str(info.background, 40),
      alignment: str(info.alignment, 40), player: str(info.player, 40), xp: str(info.xp, 20), level: num(info.level, 1, 20, 1),
    },
    abilities, saves, skills,
    combat: {
      ac: num(cb.ac, 0, 40, 10), speed: cb.speed === undefined ? "30 ft" : str(cb.speed, 30), initMisc: num(cb.initMisc, -10, 20, 0),
      hitDice: str(cb.hitDice, 30), deathS: num(cb.deathS, 0, 3, 0), deathF: num(cb.deathF, 0, 3, 0),
      inspiration: !!cb.inspiration, tempHp: num(cb.tempHp, 0, 999, 0),
    },
    cast: ABIL.includes(c.cast) ? c.cast : "",
    attacks: (Array.isArray(c.attacks) ? c.attacks : []).slice(0, 12)
      .map((a) => ({ id: cleanId(a?.id) || rid(), name: str(a?.name, 40), bonus: str(a?.bonus, 10), damage: str(a?.damage, 40) })),
    text: {
      features: str(tx.features, 3000), profs: str(tx.profs, 1500), traits: str(tx.traits, 600), ideals: str(tx.ideals, 600),
      bonds: str(tx.bonds, 600), flaws: str(tx.flaws, 600), backstory: str(tx.backstory, 4000),
    },
    coins: { cp: num(co.cp, 0, 9999999, 0), sp: num(co.sp, 0, 9999999, 0), ep: num(co.ep, 0, 9999999, 0), gp: num(co.gp, 0, 9999999, 0), pp: num(co.pp, 0, 9999999, 0) },
  };
}

const blankSheet = () => ({ rev: 0, notes: [], slots: {}, spells: [], char: cleanChar({}) });
// Sheets saved before the character sheet existed get filled in with defaults when read.
const readSheet = (raw) => (raw ? { ...cleanSheet(raw), rev: raw.rev || 0 } : blankSheet());
const str = (v, n) => String(v ?? "").slice(0, n);
const int = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || 0));
function cleanSheet(s) {
  const id = (v) => cleanId(v) || Math.random().toString(36).slice(2, 9);
  const notes = (Array.isArray(s.notes) ? s.notes : []).slice(0, 30)
    .map((n) => ({ id: id(n?.id), title: str(n?.title, 80), body: str(n?.body, 6000) }));
  const slots = {};
  for (let l = 1; l <= 9; l++) {
    const x = s.slots?.[l];
    const max = int(x?.max, 0, 20);
    if (max > 0) slots[l] = { max, used: int(x?.used, 0, max) };
  }
  const spells = (Array.isArray(s.spells) ? s.spells : []).slice(0, 200)
    .map((p) => ({ id: id(p?.id), name: str(p?.name, 60).trim(), level: int(p?.level, 0, 9), note: str(p?.note, 160), prepared: !!p?.prepared }))
    .filter((p) => p.name);
  return { notes, slots, spells, char: cleanChar(s.char) };
}

/* Campaign details and session log. DM-only document; players only ever receive the parts the DM shared. */
const CAMP_SHARE = ["overview", "premise", "themes", "setting", "factions", "rules", "notes"];
const CAMP_ALL = [...CAMP_SHARE, "secrets"];                       // "secrets" can never be shared
const SESS_SHARE = ["recap", "accomplished", "learned", "earned", "npcs", "threads"];
const SESS_ALL = [...SESS_SHARE, "dmnotes"];                       // "dmnotes" can never be shared
const campField = (f, shareable) => ({ text: str(f?.text, 20000), shared: shareable && !!f?.shared });
function cleanCamp(d) {
  d = d && typeof d === "object" ? d : {};
  const c = d.campaign || {};
  const campaign = { name: str(c.name, 80), fields: {} };
  for (const k of CAMP_ALL) campaign.fields[k] = campField(c.fields?.[k], CAMP_SHARE.includes(k));
  const sessions = (Array.isArray(d.sessions) ? d.sessions : []).slice(0, 300).map((x) => {
    const fields = {};
    for (const k of SESS_ALL) fields[k] = campField(x?.fields?.[k], SESS_SHARE.includes(k));
    return { id: cleanId(x?.id) || Math.random().toString(36).slice(2, 9), number: Math.min(9999, Math.max(0, Math.round(Number(x?.number)) || 0)), title: str(x?.title, 120), date: str(x?.date, 20), fields };
  });
  return { campaign, sessions };
}
const readCamp = (raw) => (raw ? { ...cleanCamp(raw), rev: raw.rev || 0 } : { ...cleanCamp({}), rev: 0 });
function sharedCamp(d) {
  const fields = {};
  for (const k of CAMP_SHARE) { const f = d.campaign.fields[k]; if (f.shared && f.text.trim()) fields[k] = f.text; }
  const sessions = d.sessions.map((x) => {
    const sf = {};
    for (const k of SESS_SHARE) { const f = x.fields[k]; if (f.shared && f.text.trim()) sf[k] = f.text; }
    return Object.keys(sf).length ? { id: x.id, number: x.number, title: x.title, date: x.date, fields: sf } : null;
  }).filter(Boolean);
  return { rev: d.rev, campaign: { name: d.campaign.name, fields }, sessions };
}

/* Saved locations: each remembers its map, grid, fog and where the tokens stood. DM-only document. */
const flt = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
function cleanGrid(g) {
  g = g && typeof g === "object" ? g : {};
  const areas = (Array.isArray(g.areas) ? g.areas : []).slice(0, 12)
    .map((poly) => (Array.isArray(poly) ? poly : []).slice(0, 80)
      .map((p) => [flt(p?.[0], 0, 1, 0), flt(p?.[1], 0, 1, 0)]))
    .filter((poly) => poly.length >= 3);
  return { on: !!g.on, size: flt(g.size, 8, 2000, 60), snap: !!g.snap, opacity: flt(g.opacity, 0.03, 1, 0.3), dark: !!g.dark,
    ox: flt(g.ox, -5000, 5000, 0), oy: flt(g.oy, -5000, 5000, 0), areas };
}
function cleanLocs(d) {
  const locations = (Array.isArray(d?.locations) ? d.locations : []).slice(0, 80).map((l) => {
    const tokens = {};
    for (const [k, v] of Object.entries(l?.tokens && typeof l.tokens === "object" ? l.tokens : {}).slice(0, 300)) {
      const id = cleanId(k);
      if (id) tokens[id] = { x: flt(v?.x, 0, 1, 0.5), y: flt(v?.y, 0, 1, 0.5), hidden: !!v?.hidden };
    }
    return {
      id: cleanId(l?.id) || Math.random().toString(36).slice(2, 9),
      name: str(l?.name, 80).trim() || "Untitled",
      notes: str(l?.notes, 1500),
      mapRev: num(l?.mapRev, 0, 9e15, 0), mapW: num(l?.mapW, 0, 20000, 0), mapH: num(l?.mapH, 0, 20000, 0),
      thumbRev: num(l?.thumbRev, 0, 9e15, 0),
      grid: cleanGrid(l?.grid),
      fog: { on: !!l?.fog?.on, rev: num(l?.fog?.rev, 0, 9e15, 0) },
      tokens,
    };
  });
  return { locations };
}

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
    // Is this request allowed to act as the character? Open characters (no PIN set) always are.
    const mayActAs = async (pid) => {
      const login = await store.get(loginKey(room, pid), { type: "json" });
      if (!login) return true;
      if (await isDm(req.headers.get("x-pin"))) return true;
      const tok = req.headers.get("x-player");
      return !!tok && tok === (await tokenOf(login));
    };
    const needLogin = () => fail(401, "Log in as this character first.");

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
      const ft = Number(url.searchParams.get("ft") || 0);
      const keys = state.feedOn ? await feedKeys(store, room) : null;
      const latest = keys && keys.length ? keyTime(keys[keys.length - 1], room) : 0;
      if (rev && Number(rev) === state.rev && (!keys || ft === latest)) return reply({ unchanged: true });
      return reply({ state: publicView(state), feed: keys ? readFeed(keys, room, 30) : null });
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

    // Binary assets: maps and fog masks (one set per saved location; no id means the original single map),
    // location thumbnails, and token images.
    const sid = cleanId(rawId);
    const assets = {
      map: { key: sid ? `map/${room}/${sid}` : `map/${room}`, max: MAX_MAP, type: /^image\// , fallback: "image/jpeg" },
      fog: { key: sid ? `fog/${room}/${sid}` : `fog/${room}`, max: MAX_FOG, type: /^image\/png/, fallback: "image/png" },
      thumb: { key: `thumb/${room}/${sid}`, max: MAX_THUMB, type: /^image\//, fallback: "image/jpeg" },
      img: { key: `img/${room}/${sid}`, max: MAX_IMG, type: /^image\//, fallback: "image/jpeg" },
    }[route];

    if (assets) {
      if ((route === "img" || route === "thumb") && !sid) return fail(400, "Missing id.");
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
      if (req.method === "DELETE" && sid) {
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
      if (!(await mayActAs(e.id))) return needLogin();
      await store.setJSON(`sub/${room}/${cleanId(id)}`, { id, init: Math.round(n), t: Date.now() });
      return reply({ ok: true });
    }

    if (route === "roll" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      let who = "Player";
      if (b.dm) {
        const denied = await dmOnly();
        if (denied) return denied;
        who = "DM";
      } else if (b.pid) {
        const state = await store.get(`state/${room}`, { type: "json" });
        const e = state?.ents?.find((x) => x.id === b.pid && x.type === "pc");
        if (e && (await mayActAs(e.id))) who = e.name;
      }
      const total = Math.round(Number(b.total));
      if (!Number.isFinite(total) || Math.abs(total) > 100000) return fail(400, "Bad roll.");
      const rec = {
        who: String(who).slice(0, 30),
        label: String(b.label || "").slice(0, 30),
        total,
        detail: String(b.detail || "").slice(0, 120),
        nat: b.nat === 20 || b.nat === 1 ? b.nat : null,
        dm: !!b.dm,
        r: Math.random().toString(36).slice(2, 6),
      };
      const key = `${feedPrefix(room)}${String(Date.now()).padStart(13, "0")}-${Buffer.from(JSON.stringify(rec)).toString("base64url")}`;
      await store.set(key, "1");
      const keys = await feedKeys(store, room);
      if (keys.length > FEED_MAX) await Promise.all(keys.slice(0, keys.length - FEED_MAX).map((k) => store.delete(k)));
      return reply({ ok: true });
    }

    if (route === "feed" && (req.method === "GET" || req.method === "DELETE")) {
      const denied = await dmOnly();
      if (denied) return denied;
      const keys = await feedKeys(store, room);
      if (req.method === "DELETE") {
        await Promise.all(keys.map((k) => store.delete(k)));
        return reply({ ok: true });
      }
      return reply(readFeed(keys, room, FEED_MAX));
    }

    if (route === "sheet" && (req.method === "GET" || req.method === "PUT")) {
      const pid = cleanId(rawId);
      if (!pid) return fail(400, "Missing character id.");
      if (!(await mayActAs(pid))) return needLogin();
      const key = `sheet/${room}/${pid}`;
      const cur = readSheet(await store.get(key, { type: "json" }));
      if (req.method === "GET") return reply({ sheet: cur });
      const text = await req.text();
      if (text.length > 400000) return fail(413, "That sheet is too large.");
      let body;
      try { body = JSON.parse(text); } catch { return fail(400, "Bad data."); }
      const state = await store.get(`state/${room}`, { type: "json" });
      if (!state?.ents?.some((x) => x.id === pid && x.type === "pc")) return fail(400, "Pick one of the player characters.");
      if (Number(body.rev || 0) !== (cur.rev || 0)) return reply({ error: "Changed elsewhere.", current: cur }, 409);
      const out = { ...cleanSheet(body.sheet || {}), rev: (cur.rev || 0) + 1 };
      await store.setJSON(key, out);
      return reply({ sheet: out });
    }

    if (route === "sheets" && req.method === "GET") {
      const denied = await dmOnly();
      if (denied) return denied;
      const prefix = `sheet/${room}/`;
      const { blobs } = await store.list({ prefix });
      const sheets = {};
      await Promise.all(blobs.map(async (b) => { sheets[b.key.slice(prefix.length)] = readSheet(await store.get(b.key, { type: "json" })); }));
      return reply({ sheets });
    }

    if (route === "playerlogin" && req.method === "POST") {
      const { pid, pin } = await req.json().catch(() => ({}));
      const id = cleanId(pid);
      const state = await store.get(`state/${room}`, { type: "json" });
      const e = state?.ents?.find((x) => x.id === id && x.type === "pc");
      if (!e) return fail(400, "Pick one of the player characters.");
      const key = loginKey(room, id);
      const login = await store.get(key, { type: "json" });
      if (!login) return reply({ pid: id, name: e.name, token: null });
      const now = Date.now();
      const f = login.fails || { n: 0, t: 0 };
      const recent = now - f.t < WINDOW;
      if (recent && f.n >= 8) return fail(429, "Too many wrong PINs. Wait a few minutes, or ask your DM.");
      if ((await pinHash(room, id, String(pin ?? ""))) !== login.pinHash) {
        login.fails = { n: (recent ? f.n : 0) + 1, t: now };
        await store.setJSON(key, login);
        return fail(401, "Wrong PIN.");
      }
      if (f.n) { login.fails = { n: 0, t: 0 }; await store.setJSON(key, login); }
      return reply({ pid: id, name: e.name, token: await tokenOf(login) });
    }

    if (route === "logins") {
      const denied = await dmOnly();
      if (denied) return denied;
      const prefix = `login/${room}/`;
      if (req.method === "GET") {
        const { blobs } = await store.list({ prefix });
        const logins = {};
        blobs.forEach((b) => { logins[b.key.slice(prefix.length)] = true; });
        return reply({ logins });
      }
      const id = cleanId(rawId);
      if (!id) return fail(400, "Missing character id.");
      if (req.method === "DELETE") { await store.delete(loginKey(room, id)); return reply({ ok: true }); }
      if (req.method === "PUT") {
        const { pin } = await req.json().catch(() => ({}));
        if (typeof pin !== "string" || pin.length < 4 || pin.length > 12) return fail(400, "Use a PIN of 4 to 12 characters.");
        const state = await store.get(`state/${room}`, { type: "json" });
        if (!state?.ents?.some((x) => x.id === id && x.type === "pc")) return fail(400, "Pick one of the player characters.");
        await store.setJSON(loginKey(room, id), { pinHash: await pinHash(room, id, pin), fails: { n: 0, t: 0 }, set: Date.now() });
        return reply({ ok: true });
      }
    }

    if (route === "library" && req.method === "GET") {
      const lib = await store.get(`lib/${room}`, { type: "json" });
      return reply({ spells: lib?.spells || [] });
    }
    if (route === "library" && req.method === "PUT") {
      const denied = await dmOnly();
      if (denied) return denied;
      const text = await req.text();
      if (text.length > 2600000) return fail(413, "That spell list is too large. Try splitting it up.");
      let body;
      try { body = JSON.parse(text); } catch { return fail(400, "Bad data."); }
      const spells = cleanLib(body.spells);
      await store.setJSON(`lib/${room}`, { spells });
      return reply({ ok: true, count: spells.length });
    }

    // A player changes their own HP; the DM's screen applies it to the token.
    if (route === "hp" && req.method === "POST") {
      const { id, hp, maxHp } = await req.json().catch(() => ({}));
      const state = await store.get(`state/${room}`, { type: "json" });
      const e = state?.ents?.find((x) => x.id === id && x.type === "pc");
      if (!e) return fail(400, "Pick one of the player characters.");
      if (!(await mayActAs(e.id))) return needLogin();
      const rec = { id: e.id, hp: num(hp, 0, 9999, 0), t: Date.now() };
      if (maxHp !== undefined && maxHp !== null) rec.maxHp = num(maxHp, 1, 9999, 1);
      await store.setJSON(`pcu/${room}/${cleanId(e.id)}`, rec);
      return reply({ ok: true });
    }

    if (route === "locs" && (req.method === "GET" || req.method === "PUT")) {
      const denied = await dmOnly();
      if (denied) return denied;
      const prev = await store.get(`locs/${room}`, { type: "json" });
      if (req.method === "GET") return reply({ doc: { ...cleanLocs(prev), rev: prev?.rev || 0 } });
      const text = await req.text();
      if (text.length > 800000) return fail(413, "The saved locations are too large.");
      let body;
      try { body = JSON.parse(text); } catch { return fail(400, "Bad data."); }
      const rev = (prev?.rev || 0) + 1;
      await store.setJSON(`locs/${room}`, { ...cleanLocs(body.doc), rev });
      return reply({ ok: true, rev });
    }

    if (route === "campaign" && req.method === "GET") {
      return reply(sharedCamp(readCamp(await store.get(`camp/${room}`, { type: "json" }))));
    }
    if (route === "campdoc" && (req.method === "GET" || req.method === "PUT")) {
      const denied = await dmOnly();
      if (denied) return denied;
      const prev = await store.get(`camp/${room}`, { type: "json" });
      if (req.method === "GET") return reply({ doc: readCamp(prev) });
      const text = await req.text();
      if (text.length > 1500000) return fail(413, "The campaign document is too large.");
      let body;
      try { body = JSON.parse(text); } catch { return fail(400, "Bad data."); }
      const rev = (prev?.rev || 0) + 1;
      await store.setJSON(`camp/${room}`, { ...cleanCamp(body.doc), rev });
      return reply({ ok: true, rev });
    }

    if (route === "subs" && req.method === "GET") {
      const denied = await dmOnly();
      if (denied) return denied;
      const read = async (prefix, kind) => {
        const { blobs } = await store.list({ prefix });
        const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
        return items.filter(Boolean).map((x) => ({ ...x, kind }));
      };
      const [inits, hps] = await Promise.all([read(`sub/${room}/`, "init"), read(`pcu/${room}/`, "hp")]);
      return reply([...inits, ...hps]);
    }

    return fail(404, "Not found.");
  } catch (err) {
    console.error(err);
    return fail(500, "Something went wrong on the server.");
  }
};

export const config = { path: "/api/*" };
