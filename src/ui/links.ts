// Link routing and per-tab history (D-8). Pure: the shell performs what `route` returns.
import { ID_PREFIX, Slugger } from "../render/enhance/slug";
import type { ScrollAnchor } from "./watch";

export type LinkKind = "external" | "fragment" | "markdown" | "wiki" | "file";

/** How the link was activated: a plain click, or Ctrl/Cmd-click and middle-click. */
export type Gesture = "click" | "newTab";

export type LinkAction =
  | { type: "external"; url: string }
  | { type: "scroll"; fragment: string }
  | { type: "navigate" | "newTab"; entry: Entry }
  | { type: "unsupported" };

/** One place in a tab's history. */
export interface Entry {
  path: string;
  fragment: string;
  /** The canvas's scroll offset when the user left this entry. */
  scroll: number;
  /** The same place by the heading at the top; back and forward prefer it to `scroll`. */
  anchor?: ScrollAnchor;
  /** Other files a wiki link may mean, tried in order when `path` is not found. */
  alternates?: string[];
  /** Set once loaded; back and forward then restore `scroll` instead of the fragment. */
  visited?: boolean;
}

export const MARKDOWN = /\.(?:md|markdown)$/i;

export function linkKind(link: Element): LinkKind {
  const href = link.getAttribute("href") ?? "";
  if (link.hasAttribute("data-external")) return "external";
  if (href.startsWith("#")) return "fragment";
  if (link.classList.contains("wikilink")) return "wiki";
  return MARKDOWN.test(splitHref(href).path) ? "markdown" : "file";
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function splitHref(href: string): { path: string; fragment: string } {
  const hash = href.indexOf("#");
  const path = (hash < 0 ? href : href.slice(0, hash)).replace(/\?.*$/, "");
  return { path: decode(path), fragment: hash < 0 ? "" : href.slice(hash + 1) };
}

/** `href` relative to the file `from`, with `.` and `..` resolved. */
export function resolvePath(from: string, href: string): string {
  // ponytail: `/`-separated paths only; Linux is the target (D-2).
  const parts = href.startsWith("/") ? [] : from.split("/").filter(Boolean).slice(0, -1);
  for (const part of href.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** What activating `link` in a document at `from` should do. */
export function route(link: Element, from: string, gesture: Gesture): LinkAction {
  const href = link.getAttribute("href") ?? "";
  const kind = linkKind(link);
  if (kind === "external") return { type: "external", url: href };
  if (kind === "fragment") return { type: "scroll", fragment: href.slice(1) };
  if (kind === "file") return { type: "unsupported" };

  const { path: relative, fragment } = splitHref(href);
  const path = relative ? resolvePath(from, relative) : from;
  // ponytail: jumps within a document add no history entry, unlike a browser's.
  if (path === from && gesture === "click") return { type: "scroll", fragment };
  const entry: Entry = { path, fragment, scroll: 0 };
  // `[[My Page]]` is `My Page.md` here, `My-Page.md` in a GitHub wiki.
  const dashed = path.replace(/[^/]+$/, (name) => name.replace(/ /g, "-"));
  if (kind === "wiki" && dashed !== path) entry.alternates = [dashed];
  return { type: gesture === "click" ? "navigate" : "newTab", entry };
}

/**
 * The element a `#fragment` names: the exact id first, then its GitHub slug (so
 * `[[Page#My Section]]` finds `my-section`), each with and without `user-content-`.
 */
export function findTarget(sheet: Element, fragment: string): Element | null {
  const id = decode(fragment);
  const slug = new Slugger().slug(id);
  const ids = [id, ID_PREFIX + id, slug, ID_PREFIX + slug];
  for (const want of ids.filter(Boolean)) {
    const found = [...sheet.querySelectorAll("[id], a[name]")].find(
      (n) => n.id === want || n.getAttribute("name") === want,
    );
    if (found) return found;
  }
  return null;
}

/** What a link printed to PDF does: opens `uri`, or goes to mark number `to`. */
export interface PdfMark {
  uri?: string;
  to?: number;
}

/**
 * WebKitGTK prints no links, so the backend finds these marks in the PDF and links them there:
 * each link and target gets a background too faint to see, with its index as the colour.
 * `clear` takes the backgrounds off again.
 */
export function markForPdf(sheet: Element): { marks: PdfMark[]; clear(): void } {
  const marks: PdfMark[] = [];
  const index = new Map<HTMLElement, number>();
  const markOf = (el: HTMLElement) => {
    const known = index.get(el);
    if (known !== undefined) return known;
    const i = marks.push({}) - 1;
    index.set(el, i);
    el.style.backgroundColor = `rgb(1 ${i >> 8} ${i & 255} / 0.004)`;
    return i;
  };
  for (const link of sheet.querySelectorAll<HTMLElement>("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    const kind = linkKind(link);
    if (kind === "external") marks[markOf(link)].uri = href;
    const target = kind === "fragment" && findTarget(sheet, href.slice(1));
    if (target instanceof HTMLElement) marks[markOf(link)].to = markOf(target);
  }
  return {
    marks,
    clear: () => {
      for (const el of index.keys()) el.style.removeProperty("background-color");
    },
  };
}

/** A tab's back/forward list, like a browser's: a new entry drops the forward ones. */
export class History {
  private readonly entries: Entry[];
  private index = 0;

  constructor(first: Entry) {
    this.entries = [first];
  }

  get current(): Entry {
    return this.entries[this.index];
  }

  get canGoBack(): boolean {
    return this.index > 0;
  }

  get canGoForward(): boolean {
    return this.index < this.entries.length - 1;
  }

  push(entry: Entry): void {
    this.entries.splice(this.index + 1, Infinity, entry);
    this.index++;
  }

  back(): Entry | null {
    if (!this.canGoBack) return null;
    return this.entries[--this.index];
  }

  forward(): Entry | null {
    if (!this.canGoForward) return null;
    return this.entries[++this.index];
  }
}
