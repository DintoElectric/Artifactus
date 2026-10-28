/* Image and video helpers for maps: shrink a big image to something that uploads quickly, make a small preview,
   and check a video loop. */

export const MAP_ACCEPT = "image/*,video/mp4,video/webm";
export const VIDEO_MAX = 4 * 1024 * 1024;   // the hosting platform only lets a request carry about 6 MB once encoded

const videoType = (f) => (f.type && f.type.startsWith("video/") ? f.type.split(";")[0]
  : /\.webm$/i.test(f.name || "") ? "video/webm" : /\.(mp4|m4v)$/i.test(f.name || "") ? "video/mp4" : "");
export const isVideoFile = (f) => !!videoType(f);

/* Load a video far enough to read its size and its first picture. */
function openVideo(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    const fail = () => { URL.revokeObjectURL(url); reject(new Error("This browser can't play that video. Try an MP4 (H.264) or a WebM file.")); };
    const timer = setTimeout(fail, 12000);
    v.addEventListener("loadeddata", () => { clearTimeout(timer); resolve({ video: v, url }); }, { once: true });
    v.addEventListener("error", () => { clearTimeout(timer); fail(); }, { once: true });
    v.src = url;
  });
}

function frameToJpeg(source, width) {
  const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
  const k = Math.min(1, width / sw);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.72));
}

export async function compressMap(file) {
  const vt = videoType(file);
  if (vt) {
    if (file.size > VIDEO_MAX) {
      throw new Error(`That video is ${(file.size / 1048576).toFixed(1)} MB and the limit is 4 MB. Make the loop shorter, or export it smaller (for example 1280 pixels wide at a low bitrate), then try again.`);
    }
    const blob = new Blob([file], { type: vt });
    const { video, url } = await openVideo(blob);
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) { URL.revokeObjectURL(url); throw new Error("That video has no picture I can read."); }
    const thumb = await frameToJpeg(video, 320);
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    return { blob, w, h, kind: "video", thumb };
  }
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
    if (blob && blob.size <= 3.4 * 1024 * 1024) return { blob, w, h, kind: "image" };
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
