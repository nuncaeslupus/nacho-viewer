import DOMPurify from "dompurify";

const SVG_NS = "http://www.w3.org/2000/svg";
const FRAGMENT_URL = /url\(\s*(['"]?)\s*#/gi;
// Anything that could still fetch once fragment references are prefixed: `url(` to a file,
// `image-set(`, or CSS escapes hiding either.
const EXTERNAL_CSS = /url\(\s*['"]?\s*[^\s'"#]|image-set\(|\\/i;
const ID_LISTS = ["aria-labelledby", "aria-describedby"];

const purify = DOMPurify(window);
let prefix = "";
let count = 0;

// Runs in DOMPurify's inert document, so a dropped reference was never fetched.
purify.addHook("afterSanitizeAttributes", (node) => {
  if (!(node instanceof Element)) return;
  for (const { name, value } of Array.from(node.attributes)) {
    if (name === "id") node.setAttribute(name, prefix + value);
    else if (ID_LISTS.includes(name)) {
      node.setAttribute(
        name,
        value.replace(/\S+/g, (id) => prefix + id),
      );
    } else if (name === "href" || name === "xlink:href") {
      // ponytail: only in-image references and embedded `data:` rasters; an SVG that pulls in
      // other files keeps its shape but loses those parts.
      if (/^\s*#/.test(value)) node.setAttribute(name, value.replace("#", `#${prefix}`));
      else if (!(node.localName === "image" && /^\s*data:image\//i.test(value))) {
        node.removeAttribute(name);
      }
    } else if (value.toLowerCase().includes("url(") || name === "style") {
      const prefixed = value.replace(FRAGMENT_URL, `url($1#${prefix}`);
      if (EXTERNAL_CSS.test(prefixed)) node.removeAttribute(name);
      else node.setAttribute(name, prefixed);
    }
  }
});

/**
 * Sanitises an SVG file for inlining (D-13): DOMPurify's SVG profile, `<style>` dropped so its
 * rules cannot reach the page, and every ID and `#id` reference prefixed per image so two
 * inlined SVGs never share one. Returns `null` when the markup holds no SVG.
 */
export function sanitizeSvg(markup: string): SVGSVGElement | null {
  prefix = `gm-svg${++count}-`;
  const clean = purify.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // DOMPurify leaves `use` out for its external references; the hook keeps only `#id` ones.
    ADD_TAGS: ["use"],
    FORBID_TAGS: ["style"],
    // DOM clobbering needs a bare `id` such as `title`; every id here gets the image's prefix,
    // and the default would drop those ids while their `#id` references survive, prefixed.
    SANITIZE_DOM: false,
  });
  // A template's content is inert too: nothing loads until the element is inserted.
  const template = document.createElement("template");
  template.innerHTML = clean;
  const svg = template.content.firstElementChild;
  if (!(svg instanceof SVGSVGElement) || svg.namespaceURI !== SVG_NS) return null;
  // The root is a CSS box in the live page: `position:fixed` there could cover the app chrome.
  // Inner elements are not boxes, so their styles stay.
  svg.removeAttribute("style");
  return svg;
}

/** Replaces each `img[data-svg-path]` with the sanitised SVG; on any failure, a plain `<img>`. */
export async function inlineSvgs(
  root: ParentNode,
  readSvg: (path: string) => Promise<string>,
  toImageUrl: (path: string) => string,
): Promise<void> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>("img[data-svg-path]"));
  await Promise.all(
    images.map(async (img) => {
      const path = img.getAttribute("data-svg-path") ?? "";
      img.removeAttribute("data-svg-path");
      const svg = await readSvg(path).then(sanitizeSvg, () => null);
      if (!svg) {
        // Too large (over 2 MB), unreadable or not an SVG: the `image:` protocol shows it as-is.
        img.src = toImageUrl(path);
        return;
      }
      svg.setAttribute("role", "img");
      if (img.alt) svg.setAttribute("aria-label", img.alt);
      for (const size of ["width", "height"]) {
        const value = img.getAttribute(size);
        if (value) svg.setAttribute(size, value);
      }
      img.replaceWith(svg);
    }),
  );
}
