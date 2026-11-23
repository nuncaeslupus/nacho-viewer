/** Rewrites an `img` or `source` element while it is still in DOMPurify's inert document. */
export type ImagePolicy = (el: Element) => void;

const DATA = /^\s*data:/i;
const WEB = /^https?:/;
const SVG = /\.svg$/i;

/** Where an image URL in the document at `docPath` points: a local file or a remote URL. */
export type Target = { local: string } | { remote: string };

/**
 * Resolves `src` the way the URL parser will, so a URL is local only if it really names a file:
 * `https:host/x` and `HTTPS://host/x` are remote even without the usual spelling, and `//host/x`
 * is remote over https. `null` when it does not parse.
 */
export function classify(docPath: string, src: string): Target | null {
  try {
    const base = new URL("file:///");
    base.pathname = docPath;
    const url = new URL(src.trim(), base);
    if (url.protocol !== "file:") return { remote: url.href };
    if (url.host) return { remote: `https://${url.host}${url.pathname}${url.search}` };
    // A Windows path comes back as `/C:/…`; the drive letter has to lead again.
    return { local: decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1") };
  } catch {
    return null;
  }
}

// Remote images off (D-12) is enforced here, before insertion, not after: an `<img>` created in
// the live document starts fetching at once, even detached, while DOMPurify's document is
// inert. So a remote URL never reaches a live element and no request is even attempted (a CSP
// block alone still starts one and cancels it). `blockRemoteImages` then narrows the CSP as a
// second lock for anything this misses. Both are checked in e2e/images.spec.ts.
/** Local paths go to the `image:` protocol (SVGs are marked for inlining); remote ones are kept
 * or dropped. Only `data:` is left as written. */
export function imagePolicy(
  docPath: string,
  remoteImages: boolean,
  toImageUrl: (path: string) => string,
): ImagePolicy {
  const web = (url: string) => {
    const target = classify(docPath, url);
    return target !== null && "remote" in target && WEB.test(target.remote);
  };
  return (el) => {
    const srcset = el.getAttribute("srcset");
    // ponytail: a local `srcset` is dropped, not rewritten; `src` still shows the image.
    if (srcset !== null && !(remoteImages && candidates(srcset).every(web))) {
      el.removeAttribute("srcset");
    }
    const src = el.getAttribute("src");
    if (src === null || el.tagName !== "IMG" || DATA.test(src)) return;
    el.removeAttribute("src");
    const target = classify(docPath, src);
    if (target === null) return;
    if ("remote" in target) {
      if (!remoteImages) el.setAttribute("data-remote-src", src);
      // The CSP admits only https images, so http is upgraded rather than left to break.
      else if (WEB.test(target.remote)) el.setAttribute("src", target.remote.replace(WEB, "https:"));
    } else if (SVG.test(target.local)) el.setAttribute("data-svg-path", target.local);
    else el.setAttribute("src", toImageUrl(target.local));
  };
}

function candidates(srcset: string): string[] {
  return srcset
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** Narrows the page's CSP so no image can load from outside the app, whatever the markup. */
export function blockRemoteImages(doc: Document = document): void {
  if (doc.querySelector('meta[data-remote-images="off"]')) return;
  // Policies intersect, so this meta can only tighten the one from `tauri.conf.json`. It cannot
  // be lifted again: turning the setting back on reloads the window (`Shell.setRemoteImages`).
  const meta = doc.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = "img-src 'self' image: http://image.localhost data:";
  meta.setAttribute("data-remote-images", "off");
  doc.head.append(meta);
}
