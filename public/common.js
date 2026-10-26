export const TYPES = {
  pc: { label: "Player", color: "#4fb3d6" },
  npc: { label: "NPC", color: "#e3a93b" },
  enemy: { label: "Enemy", color: "#d9525f" },
};

export const uid = () => Math.random().toString(36).slice(2, 9);
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const initials = (name) => {
  const w = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
};

export async function call(path, { method = "GET", body, pin } = {}) {
  const headers = {};
  if (pin) headers["x-pin"] = pin;
  let payload;
  if (body instanceof Blob) {
    headers["content-type"] = body.type || "application/octet-stream";
    payload = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch("/api/" + path, { method, headers, body: payload, cache: "no-store" });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).error; } catch { /* ignore */ }
    const err = new Error(msg || res.statusText || "Request failed");
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* A pan/zoom map with draggable tokens. Token positions are stored as 0..1 fractions of the image. */
export class MapView {
  constructor(root, opts = {}) {
    this.root = root;
    this.interactive = !!opts.interactive;
    this.cb = opts;
    this.view = { x: 0, y: 0, k: 1 };
    this.fitK = 0.1;
    this.dim = { w: 0, h: 0 };
    this.key = null;
    this.ents = [];
    this.grid = { on: false, size: 60, snap: false };
    this.turnId = null;
    this.selId = null;
    this.els = new Map();
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this.autoFit = true;
    this.fitPending = false;
    this.fog = { on: false, key: null, url: null };
    this.fogKey = undefined;
    this.fogLoad = 0;
    this.paintMode = null;   // null, "reveal" or "hide" (DM only)
    this.brush = 0.05;       // brush radius as a fraction of map width
    this.stroke = null;
    this.moveGrid = false;   // DM: drag to slide the grid under the map
    this.shapeMode = false;  // DM: click to outline where the grid should show
    this.draft = [];         // outline in progress (normalised points)
    this.gpan = null;
    this.vdrag = null;
    this.multi = false;
    this._shapeK = 0;

    root.classList.add("mv");
    if (!this.interactive) root.classList.add("ro");
    root.innerHTML =
      '<div class="mv-world" style="display:none"><img class="mv-img" alt="" draggable="false">' +
      '<div class="mv-grid"></div><canvas class="mv-fog" style="display:none"></canvas><div class="mv-tokens"></div><svg class="mv-shape" xmlns="http://www.w3.org/2000/svg"></svg></div><div class="mv-empty"></div>';
    this.world = root.querySelector(".mv-world");
    this.img = root.querySelector(".mv-img");
    this.gridEl = root.querySelector(".mv-grid");
    this.fogCanvas = root.querySelector(".mv-fog");
    this.tokLayer = root.querySelector(".mv-tokens");
    this.shapeEl = root.querySelector(".mv-shape");
    this.empty = root.querySelector(".mv-empty");
    this.empty.textContent = opts.emptyText || "No map loaded";

    this.img.addEventListener("load", () => {
      this.dim = { w: this.img.naturalWidth, h: this.img.naturalHeight };
      this.world.style.width = this.dim.w + "px";
      this.world.style.height = this.dim.h + "px";
      if (this.fitPending) { this.fit(); this.fitPending = false; }
      this.render();
      this.applyFog(true);
      this.cb.onDims?.(this.dim);
    });

    root.addEventListener("pointerdown", (e) => this.down(e));
    root.addEventListener("pointermove", (e) => this.move(e));
    root.addEventListener("pointerup", (e) => this.up(e));
    root.addEventListener("pointercancel", (e) => this.up(e));
    root.addEventListener("dblclick", (e) => {
      const v = e.target.closest?.(".vtx");
      if (v && this.shapeMode && this.interactive) { this.deleteVertex(v.dataset.a, Number(v.dataset.i)); return; }
      const t = e.target.closest?.(".tok");
      if (t && this.interactive) this.cb.onEdit?.(t.dataset.id);
    });
    root.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = root.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    new ResizeObserver(() => { if (this.autoFit) this.fit(); }).observe(root);
  }

  setMap(key, src, emptyText) {
    if (emptyText) this.empty.textContent = emptyText;
    if (!src) {
      this.key = null;
      this.img.removeAttribute("src");
      this.dim = { w: 0, h: 0 };
      this.world.style.display = "none";
      this.empty.style.display = "grid";
      return;
    }
    this.empty.style.display = "none";
    this.world.style.display = "block";
    if (key === this.key) return;
    this.key = key;
    this.autoFit = true;
    this.fitPending = true;
    this.img.src = src;
  }

  update({ ents, grid, turnId, selId }) {
    if (ents) this.ents = ents;
    if (grid) this.grid = grid;
    this.turnId = turnId ?? null;
    this.selId = selId ?? null;
    this.render();
  }

  render() {
    const { w, h } = this.dim;
    if (!w) return;
    const g = Math.max(8, this.grid.size || 60);
    this.renderGrid();
    this.renderShapes();
    const seen = new Set();
    for (const e of this.ents) {
      seen.add(e.id);
      let el = this.els.get(e.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "tok";
        el.dataset.id = e.id;
        el.innerHTML = '<img class="tok-img" alt="" draggable="false"><span class="tok-face"></span><span class="tok-name"></span>';
        el._img = el.children[0];
        el._face = el.children[1];
        el._name = el.children[2];
        el._img.addEventListener("error", () => el.classList.remove("has-img"));
        this.tokLayer.appendChild(el);
        this.els.set(e.id, el);
      }
      const s = g * (e.size || 1);
      el.style.setProperty("--s", s + "px");
      el.style.setProperty("--c", TYPES[e.type]?.color || "#999");
      el.style.width = el.style.height = s + "px";
      if (!(this.drag && this.drag.moved && this.drag.id === e.id)) {
        el.style.left = e.x * w - s / 2 + "px";
        el.style.top = e.y * h - s / 2 + "px";
      }
      el.classList.toggle("hidden", !!e.hidden);
      el.classList.toggle("down", !!e.down);
      el.classList.toggle("turn", this.turnId === e.id);
      el.classList.toggle("sel", this.selId === e.id);
      el._face.textContent = e.down ? "✕" : initials(e.name);
      el._name.textContent = e.name;
      const url = this.cb.imgUrl?.(e) || "";
      if (el._img.dataset.src !== url) {
        el._img.dataset.src = url;
        if (url) el._img.src = url; else el._img.removeAttribute("src");
      }
      el.classList.toggle("has-img", !!url);
    }
    for (const [id, el] of this.els) {
      if (!seen.has(id)) { el.remove(); this.els.delete(id); }
    }
  }

  /* ----- fog of war: a low-res black mask drawn over the map ----- */
  setFog(on, key, url) {
    this.fog = { on: !!on, key, url };
    if (!on) {
      this.fogCanvas.style.display = "none";
      this.fogKey = undefined;
      return;
    }
    this.fogCanvas.style.display = "block";
    this.applyFog(false);
  }

  applyFog(force) {
    const { w, h } = this.dim;
    if (!w || !this.fog.on) return;
    const k = Math.min(1, 512 / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    const c = this.fogCanvas;
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; this.fogKey = undefined; }
    c.style.width = w + "px";
    c.style.height = h + "px";
    if (this.fogKey === this.fog.key && !force) return;
    this.fogKey = this.fog.key;
    const ctx = c.getContext("2d");
    const hideAll = () => {
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cw, ch);
    };
    if (!this.fog.url) { hideAll(); return; }
    const token = ++this.fogLoad;
    const im = new Image();
    im.onload = () => {
      if (token !== this.fogLoad) return;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(im, 0, 0, cw, ch);
    };
    im.onerror = () => { if (token === this.fogLoad) hideAll(); };
    im.src = this.fog.url;
  }

  markFogKey(key) { this.fog.key = key; this.fogKey = key; }

  paint(x0, y0, x1, y1, r, reveal) {
    const c = this.fogCanvas;
    if (!c.width || !this.fog.on) return;
    const ctx = c.getContext("2d");
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, r * c.width * 2);
    ctx.globalCompositeOperation = reveal ? "destination-out" : "source-over";
    ctx.strokeStyle = "#000";
    ctx.beginPath();
    ctx.moveTo(x0 * c.width, y0 * c.height);
    ctx.lineTo(x1 * c.width + 0.01, y1 * c.height);
    ctx.stroke();
  }

  fogFill(reveal) {
    const c = this.fogCanvas;
    if (!c.width || !this.fog.on) return;
    const ctx = c.getContext("2d");
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, c.width, c.height);
    if (!reveal) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height); }
  }

  exportFog() {
    return new Promise((resolve) => this.fogCanvas.toBlob(resolve, "image/png"));
  }

  /* ----- grid: dimmable, movable, and clipped to the DM's outline ----- */
  renderGrid() {
    const { w, h } = this.dim;
    const gr = this.grid;
    const el = this.gridEl;
    if (!w || !gr.on) { el.style.backgroundImage = "none"; el.style.clipPath = "none"; return; }
    const g = Math.max(8, gr.size || 60);
    const op = clamp(gr.opacity ?? 0.3, 0.03, 1);
    const line = `rgba(${gr.dark ? "0,0,0" : "255,255,255"},${op})`;
    el.style.backgroundImage =
      `linear-gradient(to right,${line} 2px,transparent 2px),linear-gradient(to bottom,${line} 2px,transparent 2px)`;
    el.style.backgroundSize = `${g}px ${g}px`;
    el.style.backgroundPosition = `${gr.ox || 0}px ${gr.oy || 0}px`;
    const areas = (gr.areas || []).filter((a) => a.length >= 3);
    if (!areas.length) { el.style.clipPath = "none"; return; }
    const d = areas.map((poly) => {
      let pts = poly.map((p) => [p[0] * w, p[1] * h]);
      let area = 0;
      pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; });
      if (area < 0) pts = pts.reverse();   // same winding for every shape so overlaps merge
      return "M" + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L") + " Z";
    }).join(" ");
    el.style.clipPath = `path("${d}")`;
  }

  renderShapes() {
    const svg = this.shapeEl;
    const { w, h } = this.dim;
    if (!this.shapeMode || !w) { svg.style.display = "none"; svg.innerHTML = ""; return; }
    this._shapeK = this.view.k;
    svg.style.display = "block";
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.style.width = w + "px";
    svg.style.height = h + "px";
    const k = this.view.k, r = 9 / k, sw = 2 / k;
    const pts = (poly) => poly.map((p) => `${p[0] * w},${p[1] * h}`).join(" ");
    let out = "";
    (this.grid.areas || []).forEach((poly, a) => {
      out += `<polygon points="${pts(poly)}" fill="rgba(212,170,92,.14)" stroke="#d4aa5c" stroke-width="${sw}"/>`;
      poly.forEach((p, i) => {
        out += `<circle class="vtx" data-a="${a}" data-i="${i}" cx="${p[0] * w}" cy="${p[1] * h}" r="${r}" fill="#d4aa5c" stroke="#161b25" stroke-width="${sw}"/>`;
      });
    });
    if (this.draft.length) {
      out += `<polyline points="${pts(this.draft)}" fill="none" stroke="#fff" stroke-width="${sw}" stroke-dasharray="${6 / k} ${4 / k}"/>`;
      this.draft.forEach((p, i) => {
        out += `<circle class="vtx" data-a="d" data-i="${i}" cx="${p[0] * w}" cy="${p[1] * h}" r="${r}" fill="#fff" stroke="#161b25" stroke-width="${sw}"/>`;
      });
    }
    svg.innerHTML = out;
  }

  closeShape() {
    if (this.draft.length < 3) return false;
    (this.grid.areas ||= []).push(this.draft);
    this.draft = [];
    this.renderGrid(); this.renderShapes();
    this.cb.onShapeChange?.();
    this.cb.onDraftChange?.();
    return true;
  }

  undoPoint() {
    this.draft.pop();
    this.renderShapes();
    this.cb.onDraftChange?.();
  }

  clearShapes() {
    this.grid.areas = [];
    this.draft = [];
    this.renderGrid(); this.renderShapes();
    this.cb.onShapeChange?.();
    this.cb.onDraftChange?.();
  }

  deleteVertex(a, i) {
    if (a === "d") {
      this.draft.splice(i, 1);
    } else {
      const poly = this.grid.areas?.[Number(a)];
      if (!poly) return;
      poly.splice(i, 1);
      if (poly.length < 3) this.grid.areas.splice(Number(a), 1);
    }
    this.renderGrid(); this.renderShapes();
    this.cb.onShapeChange?.();
    this.cb.onDraftChange?.();
  }

  apply() {
    this.world.style.transform = `translate(${this.view.x}px,${this.view.y}px) scale(${this.view.k})`;
    if (this.shapeMode && this.view.k !== this._shapeK) this.renderShapes();
  }

  fit() {
    const r = this.root.getBoundingClientRect();
    const { w, h } = this.dim;
    if (!w || !r.width || !r.height) return;
    const k = Math.min(r.width / w, r.height / h) * 0.98;
    this.fitK = k;
    this.view = { k, x: (r.width - w * k) / 2, y: (r.height - h * k) / 2 };
    this.autoFit = true;
    this.apply();
  }

  zoomAt(mx, my, factor) {
    const k0 = this.view.k;
    const k = clamp(k0 * factor, this.fitK * 0.5, 6);
    const wx = (mx - this.view.x) / k0;
    const wy = (my - this.view.y) / k0;
    this.view = { k, x: mx - wx * k, y: my - wy * k };
    this.autoFit = false;
    this.apply();
  }

  toNorm(cx, cy, snap) {
    const r = this.root.getBoundingClientRect();
    let wx = (cx - r.left - this.view.x) / this.view.k;
    let wy = (cy - r.top - this.view.y) / this.view.k;
    if (snap && this.grid.snap && this.grid.on) {
      const g = this.grid.size, ox = this.grid.ox || 0, oy = this.grid.oy || 0;
      wx = (Math.floor((wx - ox) / g) + 0.5) * g + ox;
      wy = (Math.floor((wy - oy) / g) + 0.5) * g + oy;
    }
    return { x: clamp(wx / this.dim.w, 0, 1), y: clamp(wy / this.dim.h, 0, 1) };
  }

  centerPoint() {
    if (!this.dim.w) return null;
    const r = this.root.getBoundingClientRect();
    return this.toNorm(r.left + r.width / 2, r.top + r.height / 2, false);
  }

  focus(id) {
    const e = this.ents.find((x) => x.id === id);
    if (!e || !this.dim.w) return;
    const r = this.root.getBoundingClientRect();
    this.view.x = r.width / 2 - e.x * this.dim.w * this.view.k;
    this.view.y = r.height / 2 - e.y * this.dim.h * this.view.k;
    this.autoFit = false;
    this.apply();
  }

  down(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const tokEl = e.target.closest?.(".tok");
    if (this.shapeMode && this.interactive) {
      const v = e.target.closest?.(".vtx");
      if (v && this.pointers.size === 0 && !this.vdrag) {
        this.vdrag = { a: v.dataset.a, i: Number(v.dataset.i), pid: e.pointerId, moved: false };
        this.root.setPointerCapture(e.pointerId);
        return;
      }
    }
    if (this.moveGrid && this.interactive && this.pointers.size === 0 && !this.gpan) {
      this.gpan = { pid: e.pointerId, x: e.clientX, y: e.clientY };
      this.root.setPointerCapture(e.pointerId);
      return;
    }
    if (this.paintMode && this.interactive && this.pointers.size === 0 && !this.drag && !this.stroke) {
      const p = this.toNorm(e.clientX, e.clientY, false);
      this.stroke = { pid: e.pointerId, x: p.x, y: p.y };
      this.root.setPointerCapture(e.pointerId);
      this.paint(p.x, p.y, p.x, p.y, this.brush, this.paintMode === "reveal");
      return;
    }
    if (tokEl && this.interactive && this.pointers.size === 0 && !this.drag) {
      this.drag = { id: tokEl.dataset.id, el: tokEl, pid: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, x: 0, y: 0 };
      this.root.setPointerCapture(e.pointerId);
      return;
    }
    if (this.drag) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    this.root.setPointerCapture(e.pointerId);
    if (this.pointers.size === 2) this.startPinch();
  }

  move(e) {
    const vd = this.vdrag;
    if (vd && e.pointerId === vd.pid) {
      const p = this.toNorm(e.clientX, e.clientY, false);
      const poly = vd.a === "d" ? this.draft : this.grid.areas?.[Number(vd.a)];
      if (poly && poly[vd.i]) {
        poly[vd.i] = [p.x, p.y];
        vd.moved = true;
        this.renderGrid(); this.renderShapes();
      }
      return;
    }
    const gp = this.gpan;
    if (gp && e.pointerId === gp.pid) {
      const k = this.view.k;
      this.grid.ox = (this.grid.ox || 0) + (e.clientX - gp.x) / k;
      this.grid.oy = (this.grid.oy || 0) + (e.clientY - gp.y) / k;
      gp.x = e.clientX; gp.y = e.clientY;
      this.renderGrid();
      return;
    }
    const st = this.stroke;
    if (st && e.pointerId === st.pid) {
      const p = this.toNorm(e.clientX, e.clientY, false);
      this.paint(st.x, st.y, p.x, p.y, this.brush, this.paintMode === "reveal");
      st.x = p.x; st.y = p.y;
      return;
    }
    const d = this.drag;
    if (d && e.pointerId === d.pid) {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return;
      d.moved = true;
      const p = this.toNorm(e.clientX, e.clientY, true);
      d.x = p.x; d.y = p.y;
      const s = parseFloat(d.el.style.width);
      d.el.style.left = p.x * this.dim.w - s / 2 + "px";
      d.el.style.top = p.y * this.dim.h - s / 2 + "px";
      this.cb.onMove?.(d.id, p.x, p.y);
      return;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    this.autoFit = false;
    if (this.pointers.size === 1) {
      this.view.x += dx; this.view.y += dy;
      this.apply();
    } else if (this.pointers.size === 2) {
      this.doPinch();
    }
  }

  up(e) {
    if (this.vdrag && e.pointerId === this.vdrag.pid) {
      const moved = this.vdrag.moved;
      this.vdrag = null;
      if (moved) { this.cb.onShapeChange?.(); this.cb.onDraftChange?.(); }
      return;
    }
    if (this.gpan && e.pointerId === this.gpan.pid) {
      this.gpan = null;
      const g = Math.max(8, this.grid.size || 60);
      this.grid.ox = (((this.grid.ox || 0) % g) + g) % g;
      this.grid.oy = (((this.grid.oy || 0) % g) + g) % g;
      this.renderGrid();
      this.cb.onGridMove?.();
      return;
    }
    if (this.stroke && e.pointerId === this.stroke.pid) {
      this.stroke = null;
      this.cb.onFogStroke?.();
      return;
    }
    const d = this.drag;
    if (d && e.pointerId === d.pid) {
      this.drag = null;
      if (d.moved) { this.cb.onMoveEnd?.(d.id, d.x, d.y); this.render(); }
      else this.cb.onSelect?.(d.id);
      return;
    }
    const tap = this.pointers.get(e.pointerId);
    if (this.shapeMode && this.interactive && tap && this.pointers.size === 1 && !this.multi
        && Math.hypot(e.clientX - tap.sx, e.clientY - tap.sy) < 6) {
      const n = this.toNorm(e.clientX, e.clientY, false);
      this.draft.push([n.x, n.y]);
      this.renderShapes();
      this.cb.onDraftChange?.();
    }
    this.pointers.delete(e.pointerId);
    this.pinch = null;
    if (this.pointers.size === 2) this.startPinch();
    if (!this.pointers.size) this.multi = false;
  }

  startPinch() {
    this.multi = true;
    const [a, b] = [...this.pointers.values()];
    const r = this.root.getBoundingClientRect();
    this.pinch = {
      d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      k: this.view.k, vx: this.view.x, vy: this.view.y,
      mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top,
    };
  }

  doPinch() {
    if (!this.pinch) return;
    const [a, b] = [...this.pointers.values()];
    const r = this.root.getBoundingClientRect();
    const P = this.pinch;
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const k = clamp(P.k * (d / P.d), this.fitK * 0.5, 6);
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const wx = (P.mx - P.vx) / P.k, wy = (P.my - P.vy) / P.k;
    this.view = { k, x: mx - wx * k, y: my - wy * k };
    this.apply();
  }
}
