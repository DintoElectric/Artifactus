export const TYPES = {
  pc: { label: "Player", color: "#4fb3d6" },
  npc: { label: "NPC", color: "#e3a93b" },
  enemy: { label: "Enemy", color: "#d9525f" },
};

export const PING_TTL = 8000;   // how long a ping stays on the map (milliseconds)
/* A steady colour for each person, so their pings and move ghosts are easy to tell apart. */
export const pingColor = (key) => {
  let h = 0;
  for (const c of String(key || "x")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 78% 62%)`;
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

export async function call(path, { method = "GET", body, pin, token, acct } = {}) {
  const headers = {};
  if (pin) headers["x-pin"] = pin;
  if (acct) headers["x-acct"] = acct;
  if (token) headers["x-player"] = token;
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
    let msg = "", data = null;
    try { data = await res.json(); msg = data.error; } catch { /* ignore */ }
    const err = new Error(msg || res.statusText || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return res.json();
}

/* ---------- perspective grid maths ----------
   A perspective grid is the flat grid seen through a camera: the four corners of the grid are dragged onto the
   floor of the picture, and every line in between follows (a "homography"). Straight lines stay straight, and
   squares get smaller toward the far side. */
export const defaultPersp = () => ({ quad: [[0.32, 0.12], [0.68, 0.12], [0.92, 0.92], [0.08, 0.92]], cols: 10, rows: 18 });

/* Matrix (row-major, 9 numbers) taking the unit square (0,0)(1,0)(1,1)(0,1) onto four points. */
function squareToQuad(P) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = P;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-9) return null;
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
function invert3(M) {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}
/* Apply the matrix to (u, v). Returns [x, y, w]; w > 0 means the point is in front of the camera. */
function project(M, u, v) {
  const w = M[6] * u + M[7] * v + M[8];
  if (Math.abs(w) < 1e-12) return null;
  return [(M[0] * u + M[1] * v + M[2]) / w, (M[3] * u + M[4] * v + M[5]) / w, w];
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
    this.perspMode = false;  // DM: drag the four corners of the perspective grid
    this._pk = ""; this._pv = null;
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
      '<div class="mv-grid"></div><canvas class="mv-fog" style="display:none"></canvas><div class="mv-tokens"></div><svg class="mv-over" xmlns="http://www.w3.org/2000/svg"></svg><svg class="mv-shape" xmlns="http://www.w3.org/2000/svg"></svg></div><div class="mv-empty"></div>';
    this.world = root.querySelector(".mv-world");
    this.img = root.querySelector(".mv-img");
    this.gridEl = root.querySelector(".mv-grid");
    this.fogCanvas = root.querySelector(".mv-fog");
    this.tokLayer = root.querySelector(".mv-tokens");
    this.shapeEl = root.querySelector(".mv-shape");
    this.overEl = root.querySelector(".mv-over");
    this.overlay = { pings: [], moves: [] };
    this.overKey = "";
    this.tapMode = null;     // "ping" or "move": the next tap reports a spot on the map
    this.fogReady = false;
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
    this.renderOverlays(true);
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
      const s = this.cellSizeAt(e.x, e.y) * (e.size || 1);
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
    this.fogReady = false;
    const hideAll = () => {
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cw, ch);
      this.fogReady = true;
    };
    if (!this.fog.url) { hideAll(); return; }
    const token = ++this.fogLoad;
    const im = new Image();
    im.onload = () => {
      if (token !== this.fogLoad) return;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(im, 0, 0, cw, ch);
      this.fogReady = true;
    };
    im.onerror = () => { if (token === this.fogLoad) hideAll(); };
    im.src = this.fog.url;
  }

  markFogKey(key) { this.fog.key = key; this.fogKey = key; this.fogReady = true; }

  /* Is this spot (0..1 across the map) visible, i.e. not hidden under fog? */
  isRevealed(nx, ny) {
    if (!this.fog.on) return true;
    const c = this.fogCanvas;
    if (!c.width || !this.fogReady) return false;
    const x = Math.min(c.width - 1, Math.max(0, Math.floor(nx * c.width)));
    const y = Math.min(c.height - 1, Math.max(0, Math.floor(ny * c.height)));
    return c.getContext("2d").getImageData(x, y, 1, 1).data[3] < 128;
  }

  /* Is this spot inside the areas the DM outlined for the grid? (No outlines means everywhere.) */
  inShape(nx, ny) {
    const areas = (this.grid.areas || []).filter((a) => a.length >= 3);
    if (!areas.length) return true;
    return areas.some((poly) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > ny) !== (yj > ny) && nx < ((xj - xi) * (ny - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    });
  }

  /* The perspective grid's maths for the current corners, or null when the grid is flat (or the corners are unusable). */
  persp() {
    const g = this.grid, { w, h } = this.dim;
    if (g.mode !== "perspective" || !w || !Array.isArray(g.quad) || g.quad.length !== 4) return null;
    const key = `${w}x${h}|${g.cols}|${g.rows}|${JSON.stringify(g.quad)}`;
    if (key === this._pk) return this._pv;
    this._pk = key;
    this._pv = null;
    const H = squareToQuad(g.quad.map(([x, y]) => [x * w, y * h]));
    if (!H) return null;
    let Hi = invert3(H);
    if (!Hi) return null;
    const mid = project(H, 0.5, 0.5);
    const back = mid && project(Hi, mid[0], mid[1]);
    if (back && back[2] < 0) Hi = Hi.map((v) => -v);    // keep "in front of the camera" positive
    const cols = Math.max(1, Math.round(g.cols) || 10), rows = Math.max(1, Math.round(g.rows) || 10);
    this._pv = { H, Hi, cols, rows };
    return this._pv;
  }

  /* Where grid point (U, V), counted in squares from the first corner, lands on the picture (in pixels). */
  gridPt(P, U, V) {
    const r = project(P.H, U / P.cols, V / P.rows);
    return r && r[2] > 0 ? [r[0], r[1]] : null;
  }

  /* Which grid square (U, V) is this spot on the picture? null if it's past the horizon. */
  gridUV(P, nx, ny) {
    const r = project(P.Hi, nx * this.dim.w, ny * this.dim.h);
    return r && r[2] > 0 ? [r[0] * P.cols, r[1] * P.rows] : null;
  }

  /* How big (in picture pixels) is one grid square at this spot? Shrinks toward the far side of a perspective grid. */
  cellSizeAt(nx, ny) {
    const flat = Math.max(8, this.grid.size || 60);
    const P = this.persp();
    if (!P) return flat;
    const uv = this.gridUV(P, nx, ny);
    if (!uv) return 10;
    const a = this.gridPt(P, uv[0] - 0.5, uv[1]), b = this.gridPt(P, uv[0] + 0.5, uv[1]);
    if (!a || !b) return 10;
    return clamp(Math.hypot(a[0] - b[0], a[1] - b[1]), 10, this.dim.w * 0.25);
  }

  /* Snap a spot to the middle of its grid square when snapping is on. */
  snapPoint(nx, ny) {
    if (!(this.grid.snap && this.grid.on) || !this.dim.w) return { x: nx, y: ny };
    const P = this.persp();
    if (P) {
      const uv = this.gridUV(P, nx, ny);
      const pt = uv && this.gridPt(P, Math.floor(uv[0]) + 0.5, Math.floor(uv[1]) + 0.5);
      return pt ? { x: clamp(pt[0] / this.dim.w, 0, 1), y: clamp(pt[1] / this.dim.h, 0, 1) } : { x: nx, y: ny };
    }
    const g = this.grid.size, ox = this.grid.ox || 0, oy = this.grid.oy || 0;
    const wx = (Math.floor((nx * this.dim.w - ox) / g) + 0.5) * g + ox;
    const wy = (Math.floor((ny * this.dim.h - oy) / g) + 0.5) * g + oy;
    return { x: clamp(wx / this.dim.w, 0, 1), y: clamp(wy / this.dim.h, 0, 1) };
  }

  focusAt(nx, ny) {
    if (!this.dim.w) return;
    const r = this.root.getBoundingClientRect();
    this.view.x = r.width / 2 - nx * this.dim.w * this.view.k;
    this.view.y = r.height / 2 - ny * this.dim.h * this.view.k;
    this.autoFit = false;
    this.apply();
  }

  setTapMode(mode) {
    this.tapMode = mode || null;
    this.root.classList.toggle("tap", !!this.tapMode);
  }

  /* Pings (pulsing rings) and move ghosts (dashed outline with a line from the token). */
  setOverlays({ pings = [], moves = [] }) {
    this.overlay = { pings, moves };
    this.renderOverlays(false);
  }

  renderOverlays(force) {
    const { w, h } = this.dim;
    const svg = this.overEl;
    if (!w) { svg.innerHTML = ""; this.overKey = ""; return; }
    const key = JSON.stringify([this.overlay, this.grid.size, this.grid.mode, this.grid.quad, this.grid.cols, this.grid.rows]);
    if (!force && key === this.overKey) return;
    this.overKey = key;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.style.width = w + "px";
    svg.style.height = h + "px";
    let out = "";
    for (const m of this.overlay.moves) {
      const x = m.x * w, y = m.y * h;
      const g = this.cellSizeAt(m.x, m.y), fs = g * 0.3;
      out += `<g class="ghost" style="--c:${m.color}">`;
      if (m.fromX != null) out += `<line x1="${m.fromX * w}" y1="${m.fromY * h}" x2="${x}" y2="${y}" stroke-width="${g * 0.07}" stroke-dasharray="${g * 0.2} ${g * 0.15}"/>`;
      out += `<circle cx="${x}" cy="${y}" r="${g * 0.45}" stroke-width="${g * 0.08}" stroke-dasharray="${g * 0.18} ${g * 0.12}"/>`;
      out += `<text x="${x}" y="${y + g * 0.45 + fs * 1.1}" font-size="${fs}" text-anchor="middle">${esc(m.label || "")}</text></g>`;
    }
    for (const p of this.overlay.pings) {
      const x = p.x * w, y = p.y * h;
      const g = this.cellSizeAt(p.x, p.y), fs = g * 0.3;
      out += `<g class="ping" style="--c:${p.color}"><circle class="r r1" cx="${x}" cy="${y}" r="${g * 0.4}" stroke-width="${g * 0.09}"/>` +
        `<circle class="r r2" cx="${x}" cy="${y}" r="${g * 0.4}" stroke-width="${g * 0.09}"/><circle class="dot" cx="${x}" cy="${y}" r="${g * 0.1}"/>` +
        `<text x="${x}" y="${y - g * 0.55}" font-size="${fs}" text-anchor="middle">${esc(p.label || "")}</text></g>`;
    }
    svg.innerHTML = out;
  }

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
    if (!w || !gr.on) {
      el.style.backgroundImage = "none"; el.style.clipPath = "none";
      if (el._persp) { el.innerHTML = ""; el._persp = false; }
      return;
    }
    const g = Math.max(8, gr.size || 60);
    const op = clamp(gr.opacity ?? 0.3, 0.03, 1);
    const line = `rgba(${gr.dark ? "0,0,0" : "255,255,255"},${op})`;
    const P = gr.mode === "perspective" ? this.persp() : null;
    if (P) {
      // Perspective: draw each grid line from its projected end points; far lines are drawn thinner.
      el.style.backgroundImage = "none";
      let lines = "";
      const widthAt = (V) => {
        const a = this.gridPt(P, P.cols / 2 - 0.5, V), b = this.gridPt(P, P.cols / 2 + 0.5, V);
        return a && b ? clamp(Math.hypot(a[0] - b[0], a[1] - b[1]) * 0.035, 1, 3.2) : 1.5;
      };
      for (let i = 0; i <= P.cols; i++) {
        const a = this.gridPt(P, i, 0), b = this.gridPt(P, i, P.rows);
        if (a && b) lines += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke-width="${widthAt(P.rows / 2).toFixed(2)}"/>`;
      }
      for (let j = 0; j <= P.rows; j++) {
        const a = this.gridPt(P, 0, j), b = this.gridPt(P, P.cols, j);
        if (a && b) lines += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke-width="${widthAt(j).toFixed(2)}"/>`;
      }
      el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="position:absolute;left:0;top:0;overflow:hidden" stroke="${line}" fill="none">${lines}</svg>`;
      el._persp = true;
    } else {
      if (el._persp) { el.innerHTML = ""; el._persp = false; }
      el.style.backgroundImage =
        `linear-gradient(to right,${line} 2px,transparent 2px),linear-gradient(to bottom,${line} 2px,transparent 2px)`;
      el.style.backgroundSize = `${g}px ${g}px`;
      el.style.backgroundPosition = `${gr.ox || 0}px ${gr.oy || 0}px`;
    }
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
    if (!(this.shapeMode || this.perspMode) || !w) { svg.style.display = "none"; svg.innerHTML = ""; return; }
    this._shapeK = this.view.k;
    svg.style.display = "block";
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.style.width = w + "px";
    svg.style.height = h + "px";
    const k = this.view.k, r = 9 / k, sw = 2 / k;
    const pts = (poly) => poly.map((p) => `${p[0] * w},${p[1] * h}`).join(" ");
    let out = "";
    if (this.perspMode && Array.isArray(this.grid.quad)) {
      const q = this.grid.quad;
      out += `<polygon points="${pts(q)}" fill="rgba(79,179,214,.10)" stroke="#4fb3d6" stroke-width="${sw}" stroke-dasharray="${8 / k} ${5 / k}"/>`;
      q.forEach((p, i) => {
        out += `<circle class="vtx" data-a="q" data-i="${i}" cx="${p[0] * w}" cy="${p[1] * h}" r="${r * 1.25}" fill="#4fb3d6" stroke="#161b25" stroke-width="${sw}"/>`;
      });
    }
    if (this.shapeMode) (this.grid.areas || []).forEach((poly, a) => {
      out += `<polygon points="${pts(poly)}" fill="rgba(212,170,92,.14)" stroke="#d4aa5c" stroke-width="${sw}"/>`;
      poly.forEach((p, i) => {
        out += `<circle class="vtx" data-a="${a}" data-i="${i}" cx="${p[0] * w}" cy="${p[1] * h}" r="${r}" fill="#d4aa5c" stroke="#161b25" stroke-width="${sw}"/>`;
      });
    });
    if (this.shapeMode && this.draft.length) {
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

  toNorm(cx, cy, snap, free = false) {
    const r = this.root.getBoundingClientRect();
    const wx = (cx - r.left - this.view.x) / this.view.k;
    const wy = (cy - r.top - this.view.y) / this.view.k;
    let nx = wx / this.dim.w, ny = wy / this.dim.h;
    if (snap && this.grid.snap && this.grid.on) { const p = this.snapPoint(nx, ny); nx = p.x; ny = p.y; }
    return free ? { x: nx, y: ny } : { x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) };
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
    if ((this.shapeMode || this.perspMode) && this.interactive) {
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
      const p = this.toNorm(e.clientX, e.clientY, false, vd.a === "q");
      const poly = vd.a === "q" ? this.grid.quad : vd.a === "d" ? this.draft : this.grid.areas?.[Number(vd.a)];
      if (poly && poly[vd.i]) {
        poly[vd.i] = vd.a === "q" ? [clamp(p.x, -0.5, 1.5), clamp(p.y, -0.5, 1.5)] : [p.x, p.y];
        vd.moved = true;
        if (vd.a === "q") this.render();          // token sizes follow the corners as you drag
        else { this.renderGrid(); this.renderShapes(); }
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
      const ent = this.ents.find((x) => x.id === d.id);
      const s = this.persp() ? this.cellSizeAt(p.x, p.y) * (ent?.size || 1) : parseFloat(d.el.style.width);
      if (this.persp()) { d.el.style.setProperty("--s", s + "px"); d.el.style.width = d.el.style.height = s + "px"; }
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
    if (this.tapMode && tap && this.pointers.size === 1 && !this.multi && Math.hypot(e.clientX - tap.sx, e.clientY - tap.sy) < 6) {
      const n = this.toNorm(e.clientX, e.clientY, false);
      this.cb.onTap?.(n.x, n.y, this.tapMode);
    }
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
