/* Image helpers for maps: shrink a big image to something that uploads quickly, and make a small preview. */

export async function compressMap(file) {
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  let q = 0.86;
  for (let i = 0; i < 7; i++) {
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= 3.4 * 1024 * 1024) return { blob, w, h };
    q = Math.max(0.6, q - 0.08);
    scale *= 0.85;
  }
  throw new Error("That map is too large even after shrinking. Try a smaller image.");
}

export async function makeThumb(blob, width = 320) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, width / bmp.width);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.72));
}
