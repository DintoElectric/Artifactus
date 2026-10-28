/* Put part of the page in its own window, for a second screen, and bring it back afterwards.

   The piece of the page is MOVED into the new window rather than copied, and the page that opened the window keeps
   running it. So there is nothing to keep in sync: every button, drag and live update keeps working exactly as before. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Opens popout.html and waits for it to finish loading. Resolves to the window, or null if it was blocked or didn't load. */
async function openFrame(name, width, height) {
  const win = window.open("popout.html", name, `popup=yes,width=${width},height=${height}`);
  if (!win) return null;
  for (let i = 0; i < 60; i++) {                 // up to about 6 seconds
    try {
      const d = win.document;
      if (d.readyState === "complete" && d.getElementById("popRoot")) return win;
    } catch { /* still loading */ }
    await sleep(100);
  }
  try { win.close(); } catch { /* already gone */ }
  return null;
}

/* If the computer has more than one screen and the browser can tell us, send the window to the screen this page
   isn't on. Best effort: it needs a permission, and not every browser has it. */
async function toOtherScreen(win) {
  try {
    if (!window.screen?.isExtended || !window.getScreenDetails) return;
    const details = await window.getScreenDetails();
    const other = details.screens.find((s) => s !== details.currentScreen);
    if (!other) return;
    win.moveTo(other.availLeft, other.availTop);
    win.resizeTo(other.availWidth, other.availHeight);
  } catch { /* permission refused, or not supported: the person can drag the window themselves */ }
}

export async function openPopout({ el, name, title, width = 1280, height = 800, onClose }) {
  const win = await openFrame(name, width, height);
  if (!win) return null;
  const doc = win.document;
  doc.title = title;
  doc.getElementById("popTitle").textContent = title;

  const marker = document.createComment("popped out");   // remembers where the piece lives
  el.parentNode.insertBefore(marker, el);
  doc.getElementById("popRoot").appendChild(el);

  const ctl = { win, doc, closed: false };
  let poll = null;
  const onMainHide = () => { try { win.close(); } catch { /* already closed */ } };

  function restore() {
    if (ctl.closed) return;
    ctl.closed = true;
    clearInterval(poll);
    window.removeEventListener("pagehide", onMainHide);
    if (marker.parentNode) marker.parentNode.insertBefore(el, marker);
    marker.remove();
    onClose?.();
  }
  ctl.focus = () => { try { win.focus(); } catch { /* the browser may refuse */ } };
  ctl.close = () => { try { if (!win.closed) win.close(); } catch { /* ignore */ } restore(); };

  win.addEventListener("pagehide", restore);                 // the window was closed
  poll = setInterval(() => {                                 // belt and braces: notice a window that went away quietly
    let gone = false;
    try { gone = win.closed; } catch { gone = true; }        // a closed window can refuse to answer
    if (gone) restore();
  }, 700);
  window.addEventListener("pagehide", onMainHide);           // this page is going away: take the window with it

  doc.getElementById("popBack").addEventListener("click", ctl.close);
  doc.getElementById("popFull").addEventListener("click", () => {
    try { doc.fullscreenElement ? doc.exitFullscreen() : doc.documentElement.requestFullscreen(); } catch { /* not allowed here */ }
  });
  toOtherScreen(win);
  return ctl;
}
