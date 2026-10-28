import { call, esc, uid } from "./common.js";
import { blankChar } from "./charsheet.js";

/* A character sheet holds notes, spell slots and known spells.
   SheetStore keeps a server copy (base) plus a queue of edits (ops). The screen shows base + ops,
   so taps feel instant. If someone else saved first, the edits are replayed on top of their copy. */

const clone = (o) => JSON.parse(JSON.stringify(o));
export const blankSheet = () => ({ rev: 0, notes: [], slots: {}, spells: [], char: blankChar() });

export class SheetStore {
  constructor(room, pid, auth = {}, path = null) {
    this.room = room;
    this.pid = pid;
    this.path = path || `sheet/${room}/${pid}`;   // a character in a table, or one in a player's own library
    this.auth = auth;        // { pin } for the DM, { token } for a logged-in player
    this.dead = false;       // set when the server says the login is no longer valid
    this.base = blankSheet();
    this.view = blankSheet();
    this.ops = [];
    this.saving = false;
    this.timer = null;
    this.status = "saved";   // saved | saving | error | auth
    this.loaded = false;
    this.subs = new Set();
  }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit() { this.subs.forEach((fn) => fn()); }

  recompute() {
    const d = clone(this.base);
    for (const o of this.ops) o.fn(d);
    this.view = d;
  }

  /* Take a copy from the server, but only when nothing of ours is waiting to be saved. */
  adopt(doc) {
    if (this.saving || this.ops.length || !doc) return false;
    if (this.loaded && doc.rev === this.base.rev) return false;
    this.base = doc;
    this.loaded = true;
    this.recompute();
    this.emit();
    return true;
  }

  async load() {
    try {
      const r = await call(this.path, this.auth);
      if (!this.adopt(r.sheet) && !this.loaded) { this.loaded = true; this.emit(); }
    } catch (e) {
      if (e.status === 401) { this.dead = true; this.status = "auth"; this.emit(); }
      else if (!this.loaded) { this.status = "error"; this.emit(); }
    }
  }

  mutate(fn, { key = null, delay = 150 } = {}) {
    const last = this.ops[this.ops.length - 1];
    if (key && last && last.key === key && !last.sent) last.fn = fn;
    else this.ops.push({ fn, key, sent: false });
    this.recompute();
    this.status = "saving";
    this.emit();
    this.schedule(delay);
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  async flush() {
    if (this.saving || !this.ops.length) return;
    this.saving = true;
    const batch = this.ops.slice();
    batch.forEach((o) => (o.sent = true));
    let retryIn = 150;
    try {
      const next = clone(this.base);
      batch.forEach((o) => o.fn(next));
      const r = await call(this.path, { method: "PUT", body: { rev: this.base.rev, sheet: next }, ...this.auth });
      this.base = r.sheet;
      this.ops.splice(0, batch.length);
      this.status = this.ops.length ? "saving" : "saved";
    } catch (e) {
      batch.forEach((o) => (o.sent = false));
      if (e.status === 409 && e.data?.current) { this.base = e.data.current; retryIn = 50; }
      else if (e.status === 401) { this.dead = true; this.status = "auth"; }
      else { this.status = "error"; retryIn = 3000; }
    } finally {
      this.saving = false;
      this.recompute();
      this.emit();
      if (this.ops.length && !this.dead) this.schedule(retryIn);
    }
  }
}

const ORD = ["Cantrips", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];
const STATUS = { saved: "Saved", saving: "Saving…", error: "Offline, retrying…", auth: "Log in again" };
const TYPING = "input[type=text],input[type=number],textarea,select";
const typingIn = (root) => root.contains(document.activeElement) && document.activeElement.matches(TYPING);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ---------- spell slots + known spells ---------- */
export function mountBook(root, store, { canEdit = true, library = null } = {}) {
  let editSlots = false, editing = null, adding = false, picking = false, msg = "", msgTimer = null;
  let pq = "", plv = "";
  const open = new Set();
  const known = (name) => store.view.spells.some((p) => p.name.toLowerCase() === name.toLowerCase());
  const brief = (e) => [e.school, e.time, e.range].filter(Boolean).join(" · ").slice(0, 160);

  const pickList = () => {
    const found = library.search(pq, plv);
    if (!found.length) return '<li class="empty" style="display:block">No matches.</li>';
    return found.map((e) => `<li>
      <span class="sinfo"><b>${esc(e.name)}</b><small>${e.level === 0 ? "Cantrip" : "Level " + e.level}${e.school ? " · " + esc(e.school) : ""}${e.classes ? " · " + esc(e.classes) : ""}</small></span>
      <button class="btn small" data-act="libadd" data-name="${esc(e.name)}" ${known(e.name) ? "disabled" : ""}>${known(e.name) ? "Added" : "Add"}</button></li>`).join("");
  };

  const picker = () => {
    if (!picking || !library) return "";
    if (!library.loaded) return '<div class="picker"><p class="empty">Loading spells…</p></div>';
    if (!library.list.length) return `<div class="picker"><p class="empty">${library.room ? "No spell library yet. Ask your DM to import one." : "No spell list is built in yet. Add spells manually."}</p></div>`;
    return `<div class="picker">
      <div class="row">
        <input type="text" data-f="q" placeholder="Search ${library.list.length} spells" value="${esc(pq)}" aria-label="Search spells" autocomplete="off">
        <select data-f="lv" aria-label="Filter by level"><option value="">All levels</option>${ORD.map((_, i) =>
          `<option value="${i}" ${String(i) === plv ? "selected" : ""}>${i === 0 ? "Cantrips" : "Level " + i}</option>`).join("")}</select>
      </div>
      <ul class="plist" data-plist>${pickList()}</ul>
    </div>`;
  };

  const details = (p) => {
    const e = library?.find(p.name);
    if (!e || !open.has(p.id)) return "";
    const meta = [e.school, e.time, e.range, e.comp, e.dur].filter(Boolean).map(esc).join(" · ");
    return `<div class="sdetail">${meta ? `<p class="smeta">${meta}</p>` : ""}${e.desc ? `<p>${esc(e.desc)}</p>` : ""}${!meta && !e.desc ? "<p>No details in the library.</p>" : ""}</div>`;
  };

  const levelOptions = (sel) =>
    ORD.map((l, i) => `<option value="${i}" ${i === sel ? "selected" : ""}>${i === 0 ? "Cantrip" : "Level " + i}</option>`).join("");

  const spellForm = (sp) => `
    <form class="spellform" data-form="${sp ? "edit" : "add"}" ${sp ? `data-id="${sp.id}"` : ""}>
      <input type="text" name="name" placeholder="Spell name" maxlength="60" value="${esc(sp?.name || "")}" required aria-label="Spell name">
      <div class="row">
        <select name="level" aria-label="Spell level">${levelOptions(sp?.level ?? 1)}</select>
        <input type="text" name="note" placeholder="Notes (range, damage…)" maxlength="160" value="${esc(sp?.note || "")}" aria-label="Spell notes">
      </div>
      <div class="row">
        <button class="btn small primary" type="submit">${sp ? "Save" : "Add spell"}</button>
        <button class="btn small" type="button" data-act="cancel">Cancel</button>
        ${sp ? '<button class="btn small danger" type="button" data-act="remove">Remove</button>' : ""}
      </div>
    </form>`;

  function render(force) {
    if (!force && typingIn(root)) return;
    const d = store.view;
    const levels = editSlots ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((l) => d.slots[l]?.max > 0);

    const slotRows = levels.map((l) => {
      const s = d.slots[l] || { max: 0, used: 0 };
      const free = s.max - s.used;
      const pips = Array.from({ length: s.max }, (_, i) => {
        const avail = i < free;
        return `<button class="pip ${avail ? "" : "used"}" data-act="pip" data-l="${l}" data-avail="${avail ? 1 : 0}"
          aria-label="Level ${l} slot, ${avail ? "available. Tap to use" : "used. Tap to restore"}" ${canEdit ? "" : "disabled"}></button>`;
      }).join("");
      const right = editSlots
        ? `<span class="maxctl"><button class="btn small" data-act="max" data-l="${l}" data-d="-1" aria-label="Fewer level ${l} slots">−</button><button class="btn small" data-act="max" data-l="${l}" data-d="1" aria-label="More level ${l} slots">+</button></span>`
        : `<span class="left">${free}/${s.max}</span>`;
      return `<div class="slotrow"><span class="lv">${ORD[l]}</span><span class="pips">${pips || '<span class="hint">none</span>'}</span>${right}</div>`;
    }).join("");

    const groups = ORD.map((_, lv) => {
      const list = d.spells.filter((p) => p.level === lv).sort((a, b) => a.name.localeCompare(b.name));
      if (!list.length) return "";
      return `<h4 class="splevel">${lv === 0 ? "Cantrips" : ORD[lv] + " level"}</h4><ul class="spells">${list.map((p) => {
        if (editing === p.id && canEdit) return `<li>${spellForm(p)}</li>`;
        return `<li class="spell" data-id="${p.id}">
          <div class="srow">
            <input type="checkbox" data-act="prep" ${p.prepared ? "checked" : ""} ${canEdit ? "" : "disabled"} aria-label="${esc(p.name)} prepared">
            <span class="sinfo"><button class="sname" data-act="edit" ${canEdit ? "" : "disabled"}>${esc(p.name)}</button>${p.note ? `<small>${esc(p.note)}</small>` : ""}</span>
            ${library?.find(p.name) ? `<button class="btn small ghost" data-act="info" aria-expanded="${open.has(p.id)}">Info</button>` : ""}
            ${canEdit && lv > 0 ? '<button class="btn small" data-act="cast">Cast</button>' : ""}
          </div>
          ${details(p)}
        </li>`;
      }).join("")}</ul>`;
    }).join("");

    root.innerHTML = `
      <div class="bookhead">
        <h3>Spell slots</h3>
        <span class="sync" data-status>${STATUS[store.status]}</span>
      </div>
      ${canEdit ? `<div class="btnrow">
        <button class="btn small" data-act="longrest">Long rest</button>
        <button class="btn small" data-act="editslots" aria-pressed="${editSlots}">${editSlots ? "Done" : "Edit slots"}</button>
      </div>` : ""}
      ${slotRows || '<p class="empty">No spell slots yet. Use Edit slots to set them.</p>'}
      <p class="msg" role="status">${esc(msg)}</p>
      <div class="bookhead" style="margin-top:.8rem"><h3>Known spells</h3>
        ${canEdit ? `<span class="btnrow" style="margin:0">
          ${library ? `<button class="btn small" data-act="pick" aria-pressed="${picking}">${picking ? "Close library" : "From library"}</button>` : ""}
          <button class="btn small" data-act="addspell" aria-pressed="${adding}">${adding ? "Close" : "Add manually"}</button></span>` : ""}</div>
      ${picking && canEdit ? picker() : ""}
      ${adding && canEdit ? spellForm(null) : ""}
      ${groups || '<p class="empty">No spells yet.</p>'}`;
  }

  const flash = (text) => {
    msg = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { msg = ""; render(); }, 3500);
    render(true);
  };

  store.subscribe(() => {
    const s = root.querySelector("[data-status]");
    if (typingIn(root) && s) s.textContent = STATUS[store.status];
    else render();
  });
  library?.subscribe(() => render());

  root.addEventListener("input", (e) => {
    const f = e.target.dataset.f;
    if (!f || !library) return;
    if (f === "q") pq = e.target.value;
    if (f === "lv") plv = e.target.value;
    const list = root.querySelector("[data-plist]");
    if (list) list.innerHTML = pickList();
  });

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "info") {
      const id = b.closest("[data-id]").dataset.id;
      open.has(id) ? open.delete(id) : open.add(id);
      render(true);
      return;
    }
    if (!canEdit) return;
    const act = b.dataset.act;
    const li = b.closest("[data-id]");
    const l = Number(b.dataset.l);
    if (act === "pip") {
      const avail = b.dataset.avail === "1";
      store.mutate((d) => { const s = d.slots[l]; if (s) s.used = clamp(s.used + (avail ? 1 : -1), 0, s.max); });
    } else if (act === "max") {
      const dd = Number(b.dataset.d);
      store.mutate((d) => {
        const s = (d.slots[l] ||= { max: 0, used: 0 });
        s.max = clamp(s.max + dd, 0, 20);
        s.used = Math.min(s.used, s.max);
        if (!s.max) delete d.slots[l];
      });
    } else if (act === "longrest") {
      store.mutate((d) => { for (const k in d.slots) d.slots[k].used = 0; });
      flash("Long rest: all slots restored.");
    } else if (act === "editslots") {
      editSlots = !editSlots;
      render(true);
    } else if (act === "addspell") {
      adding = !adding; editing = null; picking = false;
      render(true);
    } else if (act === "pick") {
      picking = !picking; adding = false; editing = null;
      if (picking) library?.load();
      render(true);
    } else if (act === "libadd") {
      const entry = library?.find(b.dataset.name);
      if (!entry || known(entry.name)) return;
      store.mutate((d) => { d.spells.push({ id: uid(), name: entry.name, level: entry.level, note: brief(entry), prepared: false }); });
      flash(`Added ${entry.name}.`);
    } else if (act === "cancel") {
      adding = false; editing = null;
      render(true);
    } else if (act === "edit" && li) {
      editing = li.dataset.id; adding = false;
      render(true);
    } else if (act === "remove") {
      const id = b.closest("form").dataset.id;
      if (!confirm("Remove this spell?")) return;
      editing = null;
      store.mutate((d) => { d.spells = d.spells.filter((p) => p.id !== id); });
    } else if (act === "cast" && li) {
      const sp = store.view.spells.find((p) => p.id === li.dataset.id);
      if (!sp) return;
      const s = store.view.slots[sp.level];
      if (!s || s.used >= s.max) { flash(`No level ${sp.level} slots left for ${sp.name}. Tap a higher slot to spend it instead.`); return; }
      store.mutate((d) => { d.slots[sp.level].used += 1; });
      flash(`Cast ${sp.name}. ${s.max - s.used - 1} level ${sp.level} slot${s.max - s.used - 1 === 1 ? "" : "s"} left.`);
    }
  });

  root.addEventListener("change", (e) => {
    if (e.target.dataset.act !== "prep" || !canEdit) return;
    const id = e.target.closest("[data-id]").dataset.id;
    const on = e.target.checked;
    store.mutate((d) => { const p = d.spells.find((x) => x.id === id); if (p) p.prepared = on; });
  });

  root.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!canEdit) return;
    const f = e.target;
    const data = Object.fromEntries(new FormData(f));
    const name = String(data.name || "").trim();
    if (!name) return;
    const level = clamp(parseInt(data.level) || 0, 0, 9);
    const note = String(data.note || "").trim();
    if (f.dataset.form === "edit") {
      const id = f.dataset.id;
      store.mutate((d) => { const p = d.spells.find((x) => x.id === id); if (p) Object.assign(p, { name, level, note }); });
      editing = null;
    } else {
      store.mutate((d) => { d.spells.push({ id: uid(), name, level, note, prepared: false }); });
      adding = false;
    }
    render(true);
  });

  render(true);
}

/* ---------- notes ---------- */
export function mountNotes(root, store, { canEdit = true } = {}) {
  function render(force) {
    if (!force && typingIn(root)) return;
    const notes = store.view.notes;
    const list = notes.map((n) => canEdit
      ? `<article class="note" data-id="${n.id}">
          <input type="text" class="ntitle" data-f="title" value="${esc(n.title)}" placeholder="Title" maxlength="80" aria-label="Note title">
          <textarea class="nbody" data-f="body" rows="4" maxlength="6000" placeholder="Write here…" aria-label="Note text">${esc(n.body)}</textarea>
          <button class="btn small ghost danger" data-act="del">Delete</button>
        </article>`
      : `<article class="note ro"><h4>${esc(n.title || "Untitled")}</h4><p>${esc(n.body)}</p></article>`).join("");
    root.innerHTML = `
      ${canEdit ? `<div class="bookhead"><span class="hint">Your DM can read these.</span><span class="sync" data-status>${STATUS[store.status]}</span></div>
      <button class="btn small primary" data-act="add" style="margin-bottom:.6rem">Add note</button>` : ""}
      ${list || `<p class="empty">${canEdit ? "No notes yet. Add one for clues, names and plans." : "No notes yet."}</p>`}`;
  }

  store.subscribe(() => {
    const s = root.querySelector("[data-status]");
    if (typingIn(root) && s) s.textContent = STATUS[store.status];
    else render();
  });

  root.addEventListener("input", (e) => {
    const f = e.target.dataset.f;
    if (!f || !canEdit) return;
    const id = e.target.closest("[data-id]").dataset.id;
    const v = e.target.value;
    store.mutate((d) => { const n = d.notes.find((x) => x.id === id); if (n) n[f] = v; }, { key: `${id}:${f}`, delay: 700 });
  });

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !canEdit) return;
    if (b.dataset.act === "add") {
      const id = uid();
      store.mutate((d) => { d.notes.unshift({ id, title: "", body: "" }); });
      render(true);
      root.querySelector(`[data-id="${id}"] .ntitle`)?.focus();
    } else if (b.dataset.act === "del") {
      if (!confirm("Delete this note?")) return;
      const id = b.closest("[data-id]").dataset.id;
      store.mutate((d) => { d.notes = d.notes.filter((n) => n.id !== id); });
      render(true);
    }
  });

  render(true);
}
