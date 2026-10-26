import { call } from "./common.js";

/* Spell library: loaded from the table (DM import) plus an optional /spells.json shipped with the app. */

const WORDS = { cantrip: 0, "cantrips": 0 };
export function parseLevel(v) {
  const t = String(v ?? "").trim().toLowerCase();
  if (t in WORDS) return 0;
  const m = t.match(/\d+/);
  return m ? Math.min(9, parseInt(m[0])) : 1;
}

const FIELDS = {
  name: ["name", "spell", "spell name", "title"],
  level: ["level", "lvl", "spell level"],
  school: ["school"],
  time: ["casting time", "cast time", "casting_time", "time", "casttime"],
  range: ["range"],
  comp: ["components", "component", "comp"],
  dur: ["duration", "dur"],
  classes: ["classes", "class", "class list"],
  desc: ["description", "desc", "text", "details", "effect", "notes", "note"],
};
const ORDER = Object.keys(FIELDS);

function fieldFor(header) {
  const h = String(header).trim().toLowerCase();
  return ORDER.find((k) => FIELDS[k].includes(h)) || null;
}

/* Small CSV/TSV reader that handles quotes and line breaks inside quotes. */
export function parseTable(text, delim) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

function normalise(rec) {
  const out = { name: "", level: 1, school: "", time: "", range: "", comp: "", dur: "", classes: "", desc: "" };
  for (const [k, v] of Object.entries(rec)) {
    const f = fieldFor(k) || (ORDER.includes(k) ? k : null);
    if (!f || v == null) continue;
    out[f] = f === "level" ? parseLevel(v) : String(v).trim();
  }
  // "Fireball (3)" with no level column
  if (out.name && rec.level === undefined) {
    const m = out.name.match(/^(.*?)\s*\((cantrip|\d+)(?:st|nd|rd|th)?\)\s*$/i);
    if (m) { out.name = m[1].trim(); out.level = parseLevel(m[2]); }
  }
  return out;
}

/* Accepts JSON, CSV, TSV, or one spell per line ("Name, Level" or just "Name"). */
export function parseSpells(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  let list = [];
  if (/^[[{]/.test(t)) {
    const data = JSON.parse(t);
    const arr = Array.isArray(data) ? data : data.spells || [];
    list = arr.map((r) => (typeof r === "string" ? normalise({ name: r }) : normalise(r)));
  } else {
    const first = t.split(/\r?\n/, 1)[0];
    const delim = first.includes("\t") ? "\t" : first.includes(",") || first.includes(";") ? (first.includes(",") ? "," : ";") : ",";
    const rows = parseTable(t, delim);
    const head = rows[0].map(fieldFor);
    const hasHeader = head.includes("name");
    const cols = hasHeader ? head : ORDER.slice(0, rows[0].length);
    for (const r of hasHeader ? rows.slice(1) : rows) {
      const rec = {};
      r.forEach((v, i) => { if (cols[i]) rec[cols[i]] = v; });
      list.push(normalise(rec));
    }
  }
  const seen = new Set();
  return list.filter((p) => {
    const k = p.name.toLowerCase();
    if (!p.name || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export class Library {
  constructor(room) {
    this.room = room;
    this.list = [];
    this.byName = new Map();
    this.loaded = false;
    this.loading = null;
    this.subs = new Set();
  }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }

  set(list) {
    this.list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    this.byName = new Map(this.list.map((p) => [p.name.toLowerCase(), p]));
    this.loaded = true;
    this.subs.forEach((fn) => fn());
  }

  load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let base = [], mine = [];
      try {
        const r = await fetch("/spells.json", { cache: "no-cache" });
        if (r.ok) base = (await r.json()).map((p) => normalise(p));
      } catch { /* the app doesn't have to ship one */ }
      try { mine = (await call(`library/${this.room}`)).spells || []; } catch { /* offline */ }
      const merged = new Map(base.map((p) => [p.name.toLowerCase(), p]));
      mine.forEach((p) => merged.set(p.name.toLowerCase(), p));
      this.set([...merged.values()]);
    })();
    return this.loading;
  }

  find(name) { return this.byName.get(String(name || "").toLowerCase()) || null; }

  search(q, level) {
    const t = String(q || "").trim().toLowerCase();
    return this.list
      .filter((p) => (level === "" || level == null || p.level === Number(level)) && (!t || p.name.toLowerCase().includes(t)))
      .slice(0, 40);
  }

  /* DM only: save the table's library to the server. */
  async save(spells, pin) {
    const r = await call(`library/${this.room}`, { method: "PUT", body: { spells }, pin });
    this.loading = null;
    await this.load();
    return r.count;
  }
}
