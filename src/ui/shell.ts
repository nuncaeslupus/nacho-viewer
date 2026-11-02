import logo from "../../assets/icon.svg?url";
import { renderDocument } from "../render/document";
import { blockRemoteImages, imagePolicy } from "../render/enhance/images";
import { diagramsForPaper } from "../render/enhance/mermaid";
import { inlineSvgs } from "../render/enhance/svg";
import { strings } from "../strings";
import { applyUserCss } from "../themes/user-css";
import { type ActionId, actions, bar, matchesKey, menus } from "./definition";
import { clearMatches, highlightMatches } from "./find";
import { type Backend, type Config, type Doc, type DocumentChanged, errorMessage } from "./ipc";
import {
  type Entry,
  findTarget,
  type Gesture,
  History,
  MARKDOWN,
  markForPdf,
  type PdfMark,
  route,
} from "./links";
import { currentSection, type Section, sections } from "./outline";
import { restoreScroll, scrollAnchor, watchFile } from "./watch";
import { clampZoom, sheetLayout, stepZoom } from "./zoom";

const MAX_RECENT_FILES = 10;
const REPOSITORY = "https://github.com/nuncaeslupus/nacho-viewer";
const NOTICE_MS = 6000;
const THEMES = ["system", "light", "dark"] as const;
const STYLES = Object.keys(strings.styles) as (keyof typeof strings.styles)[];
const FIND_DEBOUNCE_MS = 100;
/** Find stops marking here, so a common word in a large document stays quick. */
const FIND_LIMIT = 1000;
/** Zoom keys come in bursts; the level is saved once the reader settles on it. */
const ZOOM_SAVE_MS = 500;
/** Paper text sizes the print dialog offers; the zoom multiplies the sheet's print font. */
const PRINT_SIZES = [
  { label: strings.printDialog.small, zoom: 0.85 },
  { label: strings.printDialog.normal, zoom: 1 },
  { label: strings.printDialog.large, zoom: 1.2 },
] as const;

interface Tab {
  history: History;
  /** The tab's entry in the tab strip, and the file name on it. */
  handle: HTMLElement;
  label: HTMLElement;
  /** The grey canvas that scrolls; each tab keeps its own, so switching keeps the scroll. */
  canvas: HTMLElement;
  sheet: HTMLElement;
  /** View source: the file's Markdown in place of the sheet, while shown. */
  source: HTMLPreElement;
  /** The Markdown last read, for View source. */
  text: string;
  /** The outline of what the sheet shows. */
  sections: Section[];
  /** Counts loads and reloads, so only the latest request fills the sheet. */
  loads: number;
  /** The load in flight, or the last one. */
  loading: Promise<void>;
  /** The path the tab watches, and how to stop; follows the file the tab shows. */
  watched?: { path: string; stop: () => void };
}

const pathOf = (tab: Tab) => tab.history.current.path;
/** What the tab shows: the rendered sheet, or its source. */
const shown = (tab: Tab) => (tab.source.hidden ? tab.sheet : tab.source);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A button showing `icon`: a glyph, or SVG path data on Material Symbols' 960 grid. */
function iconButton(className: string, icon: string): HTMLButtonElement {
  if (!icon.startsWith("M")) return h("button", className, icon);
  const button = h("button", className);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 -960 960 960");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", icon);
  svg.append(path);
  button.append(svg);
  return button;
}

/** Text that comes from the user's files, not from `strings` (file names, paths, errors). */
function userText<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string) {
  const node = h(tag, className, text);
  node.dataset.user = "";
  return node;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** The window: tab strip, the slim bar, and the tabs' sheets or the empty state. */
export class Shell {
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private config: Config | null = null;
  /** The title bar, Chrome's way: the tab strip, room to drag the window, its buttons. */
  private readonly titleBar = h("div", "titlebar");
  private stopResize = () => {};
  /** Re-sizes the sheet when its canvas changes width: the outline, a scrollbar, the window. */
  private readonly canvasWidth =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.layoutSheet());
  private readonly tabStrip = h("nav", "tabs");
  private readonly view = h("div", "view");
  private readonly empty = h("main", "empty");
  private readonly menuBar = h("div", "menu-wrap");
  /** A tab's ▾, or a right-click on it: show its file in the file manager, or copy its path. */
  private readonly fileMenu = h("div", "menu file-menu");
  private fileMenuPath = "";
  /** The user guide once opened: it stays out of the recent files. */
  private guidePath = "";
  private readonly notice = h("span", "notice");
  /** The zoom level; a click fits the sheet to the window's width, or returns to 100%. */
  private readonly zoomReadout = h("button", "zoom");
  private readonly outlinePanel = h("nav", "outline");
  private outlineOpen = false;
  /** The sections the outline panel lists, so it is redrawn only when they change. */
  private drawnSections: Section[] | null = null;
  private readonly findBox = h("div", "find");
  private readonly findInput = h("input", "find-input");
  private readonly findCount = h("span", "find-count");
  /** Find in page: the sheet holding the marks, the marks, and the current one. */
  private found = { open: false, root: null as HTMLElement | null, marks: [] as HTMLElement[] };
  private foundIndex = -1;
  private foundMore = false;
  private findTimer: ReturnType<typeof setTimeout> | undefined;
  /** After a click in the outline, the clicked entry stays current until the reader scrolls. */
  private sectionHeld = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private remoteItem: HTMLElement | null = null;
  /** The sheet fills the window rather than keeping a book's line length. */
  private wide = false;
  /** The "New tab" entry in the strip, showing the start page, and the tab it was opened from. */
  private shortcutsPanel: HTMLElement | null = null;
  /** The print dialog overlay while open, and the paper text size it last chose. */
  private modal: HTMLElement | null = null;
  private printZoom = 1;
  private themeItems: HTMLElement[] = [];
  private sourceItem: HTMLElement | null = null;
  private theme: Config["theme"] = "system";
  private style: (typeof STYLES)[number] = "classic";
  private styleItems: HTMLElement[] = [];
  private zoom = 100;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private dialogOpen = false;
  private disposed = false;
  private readonly listeners = new AbortController();
  private unlisten: (() => void)[] = [];

  private readonly handlers: Record<ActionId, () => void> = {
    open: () => void this.openDialog(),
    print: () => this.openPrintDialog("print"),
    export: () => this.openPrintDialog("export"),
    closeTab: () => this.active && this.close(this.active),
    nextTab: () => this.cycleTab(1),
    previousTab: () => this.cycleTab(-1),
    outline: () => {
      this.outlineOpen = !this.outlineOpen;
      this.update();
    },
    back: () => this.active && this.go(this.active, "back"),
    forward: () => this.active && this.go(this.active, "forward"),
    zoomOut: () => this.setZoom(stepZoom(this.zoom, -1)),
    zoomIn: () => this.setZoom(stepZoom(this.zoom, 1)),
    zoomReset: () => this.setZoom(100),
    // One way to open a file: "+" and Ctrl+T show the same dialog as Open.
    newTab: () => void this.openDialog(),
    wideSheet: () =>
      this.keepPlace(() => {
        this.wide = !this.wide;
        this.saveSettings();
      }),
    find: () => this.openFind(),
    findNext: () => this.stepFind(1),
    findPrevious: () => this.stepFind(-1),
    findClose: () => this.closeFind(),
    theme: () => {
      this.theme = THEMES[(THEMES.indexOf(this.theme) + 1) % THEMES.length];
      this.saveSettings();
    },
    remoteImages: () => {
      void this.setRemoteImages(!(this.config?.remoteImages ?? true)).then(() => this.update());
    },
    viewSource: () => this.active && this.toggleSource(this.active),
    settings: () => this.openSettings(),
    shortcuts: () => this.toggleShortcuts(),
    help: () => void this.openGuide(),
    about: () => void this.openAbout(),
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly backend: Backend,
    private readonly reloadWindow: () => void = () => location.reload(),
  ) {
    this.tabStrip.setAttribute("role", "tablist");
    this.outlinePanel.setAttribute("aria-label", strings.actions.outline);
    this.view.append(this.empty, this.outlinePanel);
    root.replaceChildren(this.buildTitleBar(), this.buildBar(), this.view);
    this.notice.setAttribute("role", "status");
    const signal = this.listeners.signal;
    this.view.addEventListener("click", (e) => this.onLinkClick(e), { signal });
    this.view.addEventListener("auxclick", (e) => this.onLinkClick(e), { signal });
    const doc = root.ownerDocument;
    doc.addEventListener("keydown", (e) => this.onKey(e), { signal });
    const outside = (e: Event) => {
      const inside = (el: Element) => this.menuBar.contains(el) || el.closest(".tab-menu");
      if (!(e.target instanceof Element && inside(e.target))) this.closeMenus();
    };
    doc.addEventListener("click", outside, { signal });
    // WebKit's own menu is a browser's: Reload, Open Link, and Inspect in dev builds. It stays
    // only where it has a use: pasting into the find box and copying selected text.
    doc.addEventListener(
      "contextmenu",
      (e) => {
        const el = e.target as Element;
        const picked = doc.getSelection();
        const copying = picked && !picked.isCollapsed && picked.getRangeAt(0).intersectsNode(el);
        if (el !== this.findInput && !(copying && !el.closest("a, img"))) e.preventDefault();
      },
      { signal },
    );
    doc.defaultView?.addEventListener("resize", () => this.layoutSheet(), { signal });
    this.update();
  }

  /** Listens for `open-files` first, so a second launch during startup is not lost. */
  async start(): Promise<void> {
    const unlisten = await Promise.all([
      this.backend.onOpenFiles((paths) => {
        if (!this.disposed) void this.openPaths(paths);
      }),
      this.backend.onDocumentChanged((change) => {
        if (!this.disposed) this.onDocumentChanged(change);
      }),
      this.backend.onUpdateAvailable(({ version }) => {
        if (!this.disposed) this.offerUpdate(version);
      }),
    ]);
    if (this.disposed) for (const stop of unlisten) stop();
    else this.unlisten = unlisten;
    this.config = await this.backend.getConfig().catch(() => {
      this.show(strings.notices.settingsUnavailable);
      return null;
    });
    // Before any document is inserted; config unread means the default, remote images on.
    if (this.config?.remoteImages === false) blockRemoteImages(this.root.ownerDocument);
    if (this.config) {
      this.theme = THEMES.includes(this.config.theme) ? this.config.theme : "system";
      this.zoom = clampZoom(this.config.defaultZoom);
      this.wide = this.config.wideSheet === true;
      const style = STYLES.find((s) => s === this.config?.style);
      this.style = style ?? "classic";
    }
    await this.backend.readUserCss().then(
      (css) => applyUserCss(this.root.ownerDocument, css),
      () => this.show(strings.notices.userCssUnavailable),
    );
    this.update();
    await this.openPaths(await this.backend.takeOpenFiles());
    // After first paint, so the request cannot delay it; offline is no notice (D-31).
    this.backend.checkUpdate().catch(() => {});
  }

  /** Removes the window's listeners; the shell does nothing afterwards. */
  dispose(): void {
    this.disposed = true;
    this.listeners.abort();
    for (const stop of this.unlisten) stop();
    this.stopResize();
    this.canvasWidth?.disconnect();
    for (const tab of this.tabs) this.watch(tab, null);
    clearTimeout(this.noticeTimer);
    clearTimeout(this.findTimer);
    if (this.saveTimer !== undefined) this.writeSettings();
  }

  /** A one-line message in the bar that fades on its own: never a dialog (D-11). */
  private show(message: string): void {
    this.notice.textContent = message;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice.replaceChildren();
    }, NOTICE_MS);
  }

  /**
   * The remote-images setting (D-12), saved first. Off applies at once: the CSP is narrowed and
   * open tabs re-render without remote images. On reloads the window, since a narrowed CSP cannot
   * be lifted.
   */
  async setRemoteImages(on: boolean): Promise<void> {
    if (!this.config || this.config.remoteImages === on) return;
    const next = { ...this.config, remoteImages: on };
    try {
      await this.backend.setConfig(next);
    } catch {
      this.show(strings.notices.settingNotSaved);
      return;
    }
    this.config = next;
    if (on) return this.reloadWindow();
    blockRemoteImages(this.root.ownerDocument);
    await Promise.all(this.tabs.map((tab) => this.load(tab, true)));
  }

  /** Opens each path in a new tab, or focuses its tab; the last one becomes active. */
  async openPaths(paths: string[]): Promise<void> {
    // Dialog, drop, launch args and recent files all land here; only Markdown opens (D-14).
    const markdown = paths.filter((path) => MARKDOWN.test(path));
    if (markdown.length < paths.length) this.show(strings.notices.notMarkdown);
    await this.openEntries(markdown.map((path) => ({ path, fragment: "", scroll: 0 })));
  }

  private async openEntries(entries: Entry[]): Promise<void> {
    const added: Tab[] = [];
    let last: Tab | undefined;
    // A `#fragment` for a tab that is already open; a new tab lands on its own.
    let jump = "";
    for (const entry of entries) {
      last = this.tabs.find((t) => pathOf(t) === entry.path);
      jump = last ? entry.fragment : "";
      if (!last) {
        last = this.addTab(entry);
        added.push(last);
      }
    }
    if (!last) return;
    const tab = last;
    this.activate(tab);
    await Promise.all(added.map((t) => this.load(t)));
    if (!jump) return;
    // Lands once that tab's own load is done, so a half-loaded sheet is not searched.
    let pending: Promise<void>;
    do {
      pending = tab.loading;
      await pending;
    } while (pending !== tab.loading);
    if (!this.disposed && this.active === tab) this.land(tab, jump);
  }

  /** Print: the same page as Export, through the system dialog where the core offers it, else
   * the webview's own print. */
  private async print(): Promise<void> {
    if (this.dialogOpen || !this.active) return;
    this.dialogOpen = true;
    this.applyPrintZoom();
    try {
      // `print()` usually blocks until the dialog closes; restoring after it covers a webview
      // that never fires `afterprint`.
      const back = await diagramsForPaper();
      try {
        if (!(await this.backend.printDocument())) window.print();
      } finally {
        back();
      }
    } catch {
      this.show(strings.notices.printFailed);
    } finally {
      this.dialogOpen = false;
    }
  }

  /** The sheet made ready for paper, with its links marked, while `print` makes the PDF. */
  private async printToPdf(print: (marks: PdfMark[]) => Promise<void>): Promise<void> {
    if (!this.active) return;
    const back = await diagramsForPaper();
    const { marks, clear } = markForPdf(this.active.sheet);
    try {
      await print(marks);
    } finally {
      clear();
      back();
    }
  }

  /** The print dialog's Preview: the PDF Export would save, opened in the system viewer. */
  private async previewPdf(): Promise<void> {
    if (this.dialogOpen || !this.active) return;
    this.dialogOpen = true;
    this.applyPrintZoom();
    try {
      const name = basename(pathOf(this.active)).replace(/\.[^.]*$/, "");
      await this.printToPdf((marks) => this.backend.previewPdf(name, marks));
    } catch {
      this.show(strings.notices.previewFailed);
    } finally {
      this.dialogOpen = false;
    }
  }

  /** Export: the print styling, saved as a PDF where the user picks (D-20). */
  private async exportPdf(): Promise<void> {
    if (this.dialogOpen || !this.active) return;
    this.dialogOpen = true;
    this.applyPrintZoom();
    try {
      const name = basename(pathOf(this.active)).replace(/\.[^.]*$/, "");
      const path = await this.backend.saveDialog(`${name}.pdf`, this.config?.recentFiles[0]);
      if (!path) return;
      await this.printToPdf((marks) => this.backend.exportPdf(path, marks));
    } catch {
      this.show(strings.notices.exportFailed);
    } finally {
      this.dialogOpen = false;
    }
  }

  /** The intermediate print page (D-20): pick a paper text size, then print or save as PDF. */
  private openPrintDialog(primary: "print" | "export"): void {
    if (this.modal || this.dialogOpen || !this.active) return;
    const panel = h("section", "print-dialog");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const title =
      primary === "export" ? strings.printDialog.exportTitle : strings.printDialog.title;
    panel.setAttribute("aria-label", title);
    panel.append(h("h2", "", title));

    const sizes = h("div", "print-sizes");
    sizes.setAttribute("role", "radiogroup");
    sizes.setAttribute("aria-label", strings.printDialog.size);
    for (const size of PRINT_SIZES) {
      const button = h("button", "print-size");
      button.dataset.zoom = String(size.zoom);
      button.setAttribute("role", "radio");
      const sample = h("span", "print-sample", strings.printDialog.sample);
      sample.style.fontSize = `${size.zoom}em`;
      button.append(sample, h("span", "print-size-label", size.label));
      button.addEventListener("click", () => this.pickPrintSize(size.zoom));
      sizes.append(button);
    }
    panel.append(sizes);

    // One action, the one the toolbar button asked for, so Print and Export stay distinct.
    const row = h("div", "print-actions");
    const isExport = primary === "export";
    const action = isExport
      ? h("button", "print-save", strings.actions.export)
      : h("button", "print-go", strings.actions.print);
    const cancel = h("button", "print-cancel", strings.printDialog.cancel);
    action.addEventListener("click", () => {
      this.closeModal();
      void (isExport ? this.exportPdf() : this.print());
    });
    // Preview leaves the dialog open, so another size can be tried.
    const preview = h("button", "print-preview", strings.printDialog.preview);
    preview.addEventListener("click", () => void this.previewPdf());
    cancel.addEventListener("click", () => this.closeModal());
    row.append(action, preview, cancel);
    panel.append(row);
    this.showModal(panel, action);
    this.markPrintSize();
  }

  /** ⋮ More › Settings: theme and remote images, each applied as soon as it is picked. */
  private openSettings(): void {
    if (this.modal || this.dialogOpen) return;
    const s = strings.settingsDialog;
    const panel = h("section", "print-dialog settings-dialog");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", s.title);

    const themes = h("div", "settings-group");
    themes.setAttribute("role", "radiogroup");
    themes.setAttribute("aria-label", s.theme);
    this.themeItems = THEMES.map((theme) => {
      const item = h("button", "menu-item", strings.themes[theme]);
      item.setAttribute("role", "radio");
      item.dataset.theme = theme;
      item.addEventListener("click", () => {
        this.theme = theme;
        this.saveSettings();
      });
      return item;
    });
    themes.append(...this.themeItems);

    const styles = h("div", "settings-group");
    styles.setAttribute("role", "radiogroup");
    styles.setAttribute("aria-label", s.style);
    this.styleItems = STYLES.map((style) => {
      const item = h("button", "menu-item", strings.styles[style]);
      item.setAttribute("role", "radio");
      item.dataset.style = style;
      item.addEventListener("click", () => {
        this.style = style;
        this.saveSettings();
      });
      return item;
    });
    styles.append(...this.styleItems);

    const remote = h("button", "menu-item", strings.actions.remoteImages);
    remote.setAttribute("role", "checkbox");
    remote.dataset.action = "remoteImages";
    remote.addEventListener("click", () => this.run("remoteImages"));
    this.remoteItem = remote;

    const row = h("div", "print-actions");
    const done = h("button", "print-go", s.done);
    done.addEventListener("click", () => this.closeModal());
    row.append(done);
    panel.append(h("h2", "", s.title), h("h3", "", s.theme), themes, h("h3", "", s.style), styles);
    panel.append(h("h3", "", s.images), remote, row);
    this.showModal(panel, done);
    this.update();
  }

  /** Shows `panel` over the page; a click beside it or Esc closes it. */
  private showModal(panel: HTMLElement, focus: HTMLElement): void {
    const overlay = h("div", "print-overlay");
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.closeModal();
    });
    overlay.append(panel);
    this.view.append(overlay);
    this.modal = overlay;
    focus.focus();
  }

  private pickPrintSize(zoom: number): void {
    this.printZoom = zoom;
    this.markPrintSize();
  }

  private markPrintSize(): void {
    for (const b of this.modal?.querySelectorAll<HTMLElement>(".print-size") ?? []) {
      const on = Number(b.dataset.zoom) === this.printZoom;
      b.classList.toggle("current", on);
      b.setAttribute("aria-checked", String(on));
    }
  }

  private closeModal(): void {
    this.modal?.remove();
    this.modal = null;
  }

  private applyPrintZoom(): void {
    this.root.ownerDocument.documentElement.style.setProperty(
      "--print-zoom",
      String(this.printZoom),
    );
  }

  private async openDialog(): Promise<void> {
    // A second Ctrl+O while the dialog is up does nothing.
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    let paths: string[] = [];
    try {
      paths = await this.backend.openDialog(this.config?.recentFiles[0]);
    } catch {
      this.show(strings.notices.openFailed);
    } finally {
      this.dialogOpen = false;
    }
    await this.openPaths(paths);
  }

  /** `read_document` → render → sanitise → insert → enhance. Errors stay in the sheet, never a
   * dialog. A reload keeps the reader's place and, if it fails, the last version. */
  private load(tab: Tab, reload = false): Promise<void> {
    tab.loading = this.fill(tab, reload);
    return tab.loading;
  }

  private async fill(tab: Tab, reload: boolean): Promise<void> {
    const entry = tab.history.current;
    // Orders overlapping reads by request, not by mtime: a coarse or older mtime still reloads.
    const seq = ++tab.loads;
    // A tab closed, moved on or reloaded again while its read was in flight takes no result.
    const live = () => !this.disposed && this.tabs.includes(tab) && tab.loads === seq;
    try {
      const doc = await this.read(entry);
      if (!live()) return;
      tab.text = doc.text;
      if (!tab.source.hidden) tab.source.textContent = doc.text;
      const anchor = reload ? scrollAnchor(tab.canvas, tab.sheet) : undefined;
      const remoteImages = this.config?.remoteImages ?? true;
      const { readSvg, imageUrl } = this.backend;
      const { outline, settled } = await renderDocument(tab.sheet, doc.text, {
        current: live,
        images: imagePolicy(doc.path, remoteImages, (path) => imageUrl(path)),
      });
      if (!live()) return;
      // Back and forward return to where the user was; the fragment is for the first visit.
      const fragment = !anchor && !entry.visited ? entry.fragment : "";
      const place = anchor ?? (fragment ? undefined : entry.anchor);
      // A plain offset (the top, mostly) is taken at once, so a reader scrolling while the
      // rest settles is not sent back.
      if (!place && !fragment) tab.canvas.scrollTop = entry.scroll;
      if (!anchor) {
        this.remember(doc.path);
        entry.visited = true;
      }
      // A large document shows at once but is laid out by estimate off screen until it
      // settles (after its diagrams); a heading or fragment is found on the real layout.
      await settled;
      if (!live()) return;
      // Before the scroll is restored, since inlined SVGs take their own height.
      await inlineSvgs(
        tab.sheet,
        (path) => readSvg(path),
        (path) => imageUrl(path),
      );
      if (!live()) return;
      tab.sections = sections(tab.sheet, outline);
      if (this.found.root === shown(tab)) this.runFind(false);
      // ponytail: watching starts after a successful read, so a missing file adds no second
      // notice; a save in the moment between the two is not seen.
      this.watch(tab, entry.path);
      if (place) restoreScroll(tab.canvas, tab.sheet, place);
      else if (fragment) this.land(tab, fragment);
    } catch (err) {
      if (!live()) return;
      if (reload) return this.fileNotice(tab, strings.fileNotices.reloadFailed);
      this.watch(tab, null);
      tab.sections = [];
      // No source either: View source must not show the file the tab came from.
      tab.text = "";
      tab.source.replaceChildren();
      const box = h("div", "doc-error");
      box.append(h("p", "", strings.documentError), userText("p", "", errorMessage(err)));
      tab.sheet.replaceChildren(box);
    }
    this.update();
  }

  /** Reads the entry's file, or the first of its alternates that exists. */
  private async read(entry: Entry): Promise<Doc> {
    let first: unknown;
    for (const path of [entry.path, ...(entry.alternates ?? [])]) {
      try {
        const doc = await this.backend.readDocument(path);
        entry.path = path;
        entry.alternates = undefined;
        return doc;
      } catch (err) {
        first ??= err;
        if ((err as { kind?: string } | null)?.kind !== "not_found") break;
      }
    }
    throw first;
  }

  /** Records where the reader is in `entry`: the offset, and the heading at the top, which
   * survives a large document's boxes being laid out after it comes back. */
  private leave(tab: Tab, entry: Entry): void {
    entry.scroll = tab.canvas.scrollTop;
    entry.anchor = scrollAnchor(tab.canvas, tab.sheet);
  }

  /** Follows a link in place: a new history entry in the same tab. */
  private navigate(tab: Tab, entry: Entry): void {
    this.leave(tab, tab.history.current);
    tab.history.push(entry);
    this.update();
    void this.load(tab);
  }

  private go(tab: Tab, direction: "back" | "forward"): void {
    this.leave(tab, tab.history.current);
    if (!tab.history[direction]()) return;
    this.update();
    void this.load(tab);
  }

  /** Scrolls to `#fragment`, or to the top for `#`; a missing one is a notice, not a dialog. */
  private land(tab: Tab, fragment: string): void {
    if (!fragment) {
      tab.canvas.scrollTop = 0;
      return;
    }
    const target = findTarget(tab.sheet, fragment);
    if (target) target.scrollIntoView();
    else this.show(strings.notices.sectionNotFound);
  }

  /** `document-changed`: every tab on the path reloads, or keeps its sheet if it was deleted. */
  private onDocumentChanged(change: DocumentChanged): void {
    for (const tab of this.tabs) {
      // A tab still loading another file after navigating takes the change on its own load.
      if (tab.watched?.path !== change.path || pathOf(tab) !== change.path) continue;
      if (change.deleted) this.fileNotice(tab, strings.fileNotices.deleted);
      else void this.load(tab, true);
    }
  }

  /** A one-line notice at the top of the sheet, over the last version; the next render clears it. */
  private fileNotice(tab: Tab, message: string): void {
    tab.sheet.querySelector(":scope > .file-notice")?.remove();
    const notice = h("p", "file-notice", message);
    notice.setAttribute("role", "status");
    tab.sheet.prepend(notice);
  }

  /** Moves the tab's watch to `path`, or ends it; the core counts watchers per path. */
  private watch(tab: Tab, path: string | null): void {
    if (tab.watched?.path === path) return;
    tab.watched?.stop();
    tab.watched = path
      ? { path, stop: watchFile(this.backend, path, () => this.show(strings.notices.watchFailed)) }
      : undefined;
  }

  /** Theme and zoom: applied at once, kept in the config (when it could be read) after `delay`.
   * The zoom last used is the default zoom: it has no field in Settings, so this is how one is set. */
  private saveSettings(delay = 0): void {
    this.update();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeSettings(), delay);
  }

  private writeSettings(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.config) return;
    this.config = {
      ...this.config,
      theme: this.theme,
      style: this.style,
      defaultZoom: this.zoom,
      wideSheet: this.wide,
    };
    void this.backend
      .setConfig(this.config)
      .catch(() => this.show(strings.notices.settingNotSaved));
  }

  /** Zooms the sheets; the active tab keeps the heading the reader is at. */
  private setZoom(percent: number): void {
    this.keepPlace(() => {
      this.zoom = clampZoom(percent);
      this.saveSettings(ZOOM_SAVE_MS);
    });
  }

  /** Runs `reflow`, which changes the document's height, and keeps the reader where they were. */
  private keepPlace(reflow: () => void): void {
    const tab = this.active;
    const anchor = tab && scrollAnchor(tab.canvas, tab.sheet);
    reflow();
    if (tab && anchor) restoreScroll(tab.canvas, tab.sheet, anchor);
  }

  /** Shows the active tab's outline, redrawn only when its sections changed. */
  private drawOutline(): void {
    const tab = this.active;
    // The outline lists rendered headings, so a tab showing its source has none.
    const open = this.outlineOpen && tab?.source.hidden === true;
    this.outlinePanel.hidden = !open;
    this.view.classList.toggle("with-outline", open);
    if (!open) return;
    if (this.drawnSections !== tab.sections) this.listSections(tab.sections);
    if (!this.sectionHeld) this.markSection(currentSection(tab.canvas, tab.sections));
  }

  private listSections(list: Section[]): void {
    this.drawnSections = list;
    this.sectionHeld = false;
    if (list.length === 0) {
      this.outlinePanel.replaceChildren(h("p", "outline-empty", strings.outlineEmpty));
      return;
    }
    const top = Math.min(...list.map((s) => s.heading.level));
    const ul = h("ul");
    for (const [i, { heading, node }] of list.entries()) {
      const item = userText("button", "outline-item", heading.text);
      item.title = heading.text;
      item.style.setProperty("--depth", String(heading.level - top));
      item.addEventListener("click", () => {
        this.sectionHeld = true;
        node.scrollIntoView?.();
        this.markSection(i);
      });
      const li = h("li");
      li.append(item);
      ul.append(li);
    }
    this.outlinePanel.replaceChildren(ul);
  }

  private markSection(index: number): void {
    for (const [i, item] of this.outlinePanel.querySelectorAll(".outline-item").entries()) {
      item.classList.toggle("current", i === index);
      if (i === index) item.setAttribute("aria-current", "location");
      else item.removeAttribute("aria-current");
    }
  }

  private openFind(): void {
    clearTimeout(this.findTimer);
    this.found.open = true;
    this.findBox.hidden = false;
    this.findInput.focus();
    this.findInput.select();
    this.runFind(true);
    this.update();
  }

  private closeFind(): void {
    clearTimeout(this.findTimer);
    this.found.open = false;
    this.findBox.hidden = true;
    this.runFind(false);
    this.update();
  }

  /** Marks the query's matches in the active sheet. `jump` goes to the first match from the
   * reader's place; otherwise (a reload) the current match keeps its number. */
  private runFind(jump: boolean): void {
    const tab = this.active;
    const keep = this.foundIndex;
    if (this.found.root) clearMatches(this.found.root);
    this.found.marks = [];
    this.found.root = this.found.open && tab ? shown(tab) : null;
    this.foundIndex = -1;
    const { marks, more } = this.found.root
      ? highlightMatches(this.found.root, this.findInput.value, FIND_LIMIT)
      : { marks: [], more: false };
    this.found.marks = marks;
    this.foundMore = more;
    let index = -1;
    if (marks.length > 0 && !jump) index = Math.min(Math.max(keep, 0), marks.length - 1);
    else if (marks.length > 0 && tab) {
      const top = tab.canvas.getBoundingClientRect().top;
      index = Math.max(
        marks.findIndex((m) => m.getBoundingClientRect().top >= top),
        0,
      );
    }
    this.selectMatch(index, jump);
  }

  private stepFind(direction: 1 | -1): void {
    const count = this.found.marks.length;
    if (count > 0) this.selectMatch((this.foundIndex + direction + count) % count, true);
  }

  private selectMatch(index: number, scroll: boolean): void {
    this.found.marks[this.foundIndex]?.classList.remove("current");
    this.foundIndex = index;
    const mark = this.found.marks[index];
    if (mark) {
      mark.classList.add("current");
      if (scroll) {
        for (let d = mark.closest("details"); d; d = d.parentElement?.closest("details") ?? null) {
          d.open = true;
        }
        mark.scrollIntoView?.({ block: "center" });
      }
    }
    const count = this.found.marks.length;
    if (count > 0) {
      const counted = this.foundMore ? strings.findCountMore : strings.findCount;
      this.findCount.textContent = counted(index + 1, count);
    } else if (this.found.open && this.findInput.value)
      this.findCount.textContent = strings.findNone;
    else this.findCount.replaceChildren();
  }

  /** Help › Keyboard shortcuts: a list beside the page, not a dialog; F1 or Esc closes it. */
  private toggleShortcuts(): void {
    if (this.shortcutsPanel) {
      this.shortcutsPanel.remove();
      this.shortcutsPanel = null;
      return;
    }
    const panel = h("section", "shortcuts");
    panel.setAttribute("aria-label", strings.actions.shortcuts);
    const table = h("table");
    for (const action of Object.values(actions)) {
      const row = h("tr");
      row.dataset.action = action.id;
      const key = h("td");
      key.append(h("kbd", "", action.key));
      row.append(h("td", "", action.label), key);
      table.append(row);
    }
    panel.append(
      h("h2", "", strings.actions.shortcuts),
      table,
      h("p", "shortcuts-hint", strings.shortcutsHint),
    );
    this.view.append(panel);
    this.shortcutsPanel = panel;
  }

  /** More › User guide. Not a recent file: its folder would become where the dialogs start. */
  private async openGuide(): Promise<void> {
    try {
      this.guidePath = await this.backend.helpFile();
      await this.openPaths([this.guidePath]);
    } catch {
      this.show(strings.notices.helpFailed);
    }
  }

  private async openAbout(): Promise<void> {
    const version = await this.backend.appVersion();
    if (this.modal) return;
    const s = strings.aboutDialog;
    const panel = h("section", "print-dialog about-dialog");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", strings.actions.about);
    const row = h("div", "print-actions");
    const github = h("button", "print-go", s.github);
    github.addEventListener("click", () => void this.backend.openExternal(REPOSITORY));
    const close = h("button", "print-cancel", s.close);
    close.addEventListener("click", () => this.closeModal());
    row.append(github, close);
    panel.append(
      h("h2", "", strings.appName),
      h("p", "", s.version(version)),
      h("p", "", s.tagline),
      h("p", "", s.license),
      row,
    );
    this.showModal(panel, close);
  }

  private remember(path: string): void {
    if (!this.config || path === this.guidePath) return;
    const recent = [path, ...this.config.recentFiles.filter((p) => p !== path)];
    this.saveRecent(recent.slice(0, MAX_RECENT_FILES));
  }

  private saveRecent(recentFiles: string[]): void {
    if (!this.config) return;
    this.config = { ...this.config, recentFiles };
    void this.backend
      .setConfig(this.config)
      .catch(() => this.show(strings.notices.recentFilesNotSaved));
  }

  /** Redraws the page and puts focus on the X now in `index`'s place, or on the drop area. */
  private dropRecent(recentFiles: string[], index: number): void {
    this.saveRecent(recentFiles);
    this.drawEmpty();
    const removes = this.empty.querySelectorAll<HTMLElement>(".recent-remove");
    (
      removes[Math.min(index, removes.length - 1)] ?? this.empty.querySelector<HTMLElement>(".drop")
    )?.focus();
  }

  private addTab(entry: Entry): Tab {
    const handle = h("div", "tab");
    handle.setAttribute("role", "tab");
    // Named in update(), since following a link changes the tab's file.
    const label = userText("button", "tab-label", "");
    const menu = iconButton("tab-menu", strings.icons.fileMenu);
    menu.title = strings.fileMenu.button;
    menu.setAttribute("aria-label", strings.fileMenu.button);
    menu.setAttribute("aria-haspopup", "menu");
    menu.setAttribute("aria-expanded", "false");
    const close = this.actionButton("closeTab", "tab-close");
    handle.append(label, menu, close);

    const canvas = h("div", "canvas");
    const sheet = h("article", "sheet");
    const source = userText("pre", "sheet source", "");
    source.hidden = true;
    canvas.append(sheet, source);
    const tab: Tab = {
      history: new History(entry),
      handle,
      label,
      canvas,
      sheet,
      source,
      text: "",
      sections: [],
      loads: 0,
      loading: Promise.resolve(),
    };
    label.addEventListener("click", () => this.activate(tab));
    menu.addEventListener("click", () => {
      if (!this.fileMenu.hidden) return this.closeMenus();
      const at = menu.getBoundingClientRect();
      this.openFileMenu(at.left, at.bottom, pathOf(tab));
      menu.setAttribute("aria-expanded", "true");
    });
    handle.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openFileMenu(e.clientX, e.clientY, pathOf(tab));
    });
    canvas.addEventListener(
      "scroll",
      () => {
        if (tab === this.active && this.outlineOpen && !this.sectionHeld) {
          this.markSection(currentSection(canvas, tab.sections));
        }
      },
      { passive: true, signal: this.listeners.signal },
    );
    // The reader scrolling, not a jump from the outline, releases the clicked entry.
    for (const type of ["wheel", "touchstart", "mousedown"]) {
      canvas.addEventListener(
        type,
        () => {
          this.sectionHeld = false;
        },
        { passive: true, signal: this.listeners.signal },
      );
    }
    // The tab's own close button closes that tab, not the active one.
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close(tab);
    });

    this.tabs.push(tab);
    this.tabStrip.append(handle);
    this.view.append(canvas);
    this.canvasWidth?.observe(canvas);
    return tab;
  }

  private activate(tab: Tab): void {
    this.active = tab;
    this.update();
  }

  /** Swaps the rendered sheet for the file's Markdown, or back; each tab keeps its own. */
  private toggleSource(tab: Tab): void {
    const on = tab.source.hidden;
    tab.source.textContent = on ? tab.text : "";
    tab.source.hidden = !on;
    tab.sheet.hidden = on;
    tab.canvas.scrollTop = 0;
    if (this.found.open) this.runFind(true);
    this.update();
  }

  /** Ctrl+Tab and Ctrl+Shift+Tab, wrapping at the ends. */
  private cycleTab(step: number): void {
    if (!this.active) return;
    const n = this.tabs.length;
    const tab = this.tabs[(this.tabs.indexOf(this.active) + step + n) % n];
    if (tab) this.activate(tab);
  }

  private close(tab: Tab): void {
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    this.canvasWidth?.unobserve(tab.canvas);
    this.watch(tab, null);
    tab.handle.remove();
    tab.canvas.remove();
    if (this.active === tab) this.active = this.tabs[Math.min(index, this.tabs.length - 1)] ?? null;
    this.update();
  }

  private enabled(id: ActionId): boolean {
    if (actions[id].needsDocument && !this.active) return false;
    if (id === "back") return this.active?.history.canGoBack === true;
    if (id === "forward") return this.active?.history.canGoForward === true;
    if (id === "findNext" || id === "findPrevious") return this.found.marks.length > 0;
    if (id === "findClose") return this.found.open;
    if (id === "remoteImages") return this.config !== null;
    // The outline lists the rendered headings.
    if (id === "outline") return this.active?.source.hidden === true;
    return true;
  }

  private run(id: ActionId): void {
    if (this.enabled(id)) this.handlers[id]();
  }

  private actionButton(id: ActionId, className: string): HTMLButtonElement {
    const action = actions[id];
    const button = iconButton(className, action.icon ?? action.label);
    button.title = action.label;
    button.setAttribute("aria-label", action.label);
    button.dataset.action = id;
    // The tab's close button is wired per tab in addTab.
    if (id !== "closeTab") button.addEventListener("click", () => this.run(id));
    return button;
  }

  /** Linux: moves the window only once the mouse moves with the button held. Started on a bare
   * press, as data-tauri-drag-region does, GTK keeps the window grabbed after the release and
   * later clicks move the window instead of reaching the app. */
  private dragOnMove(handles: HTMLElement[]): void {
    const controls = this.backend.window;
    if (!controls) return;
    const handle = (t: EventTarget | null) =>
      handles.includes(t as HTMLElement) || handles[1]?.contains(t as Node) === true;
    let pressed: { x: number; y: number } | null = null;
    const on = { signal: this.listeners.signal };
    this.titleBar.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 0 || !handle(e.target)) return;
        if (e.detail === 2) void Promise.resolve().then(() => controls.toggleMaximize());
        else pressed = { x: e.clientX, y: e.clientY };
      },
      on,
    );
    window.addEventListener(
      "mousemove",
      (e) => {
        if (!pressed) return;
        if (!(e.buttons & 1)) pressed = null;
        else if (Math.abs(e.clientX - pressed.x) + Math.abs(e.clientY - pressed.y) > 3) {
          pressed = null;
          void Promise.resolve()
            .then(() => controls.startDragging())
            .catch(() => {});
        }
      },
      on,
    );
    window.addEventListener("mouseup", () => (pressed = null), on);
  }

  private buildTitleBar(): HTMLElement {
    const drag = h("div", "drag");
    const brand = h("div", "brand");
    const mark = h("img");
    mark.src = logo;
    mark.alt = "";
    brand.append(mark, h("span", "", strings.appName));
    // "+" sits right after the last tab, before the empty strip that drags the window.
    const plus = this.actionButton("newTab", "new-tab");
    this.titleBar.append(brand, this.tabStrip, plus, drag);
    const controls = this.backend.window;
    // The window moves by the bar, not by the tabs on it; a double-click maximizes.
    const handles = [this.titleBar, brand, this.tabStrip, drag];
    if (!/Linux/.test(navigator.platform)) {
      for (const el of handles) el.dataset.tauriDragRegion = "";
    } else {
      this.dragOnMove(handles);
    }
    // Dragging the window takes the mouse before any click, so the menus close here.
    this.titleBar.addEventListener(
      "mousedown",
      (e) => {
        if (!(e.target instanceof Element && e.target.closest(".tab-menu"))) this.closeMenus();
      },
      { capture: true, signal: this.listeners.signal },
    );
    // No scrollbar to grab on a drag region: the wheel scrolls the tabs sideways.
    this.tabStrip.addEventListener(
      "wheel",
      (e) => {
        this.tabStrip.scrollLeft += e.deltaY;
      },
      { passive: true, signal: this.listeners.signal },
    );
    // macOS keeps its own buttons, over the strip's left end.
    if (/Mac/.test(navigator.platform)) this.titleBar.classList.add("mac");
    else if (controls) {
      const w = strings.windowControls;
      const i = strings.icons;
      const box = h("div", "window-controls");
      for (const [label, icon, act] of [
        [w.minimize, i.minimize, () => controls.minimize()],
        [w.maximize, i.maximize, () => controls.toggleMaximize()],
        [w.close, i.closeWindow, () => controls.close()],
      ] as const) {
        const button = iconButton("window-button", icon);
        button.title = label;
        button.setAttribute("aria-label", label);
        button.addEventListener("click", () => void act());
        box.append(button);
      }
      box.lastElementChild?.classList.add("window-close");
      this.titleBar.append(box);
      // Maximize turns into Restore while the window is maximized, as on Chrome.
      const maximize = box.children[1] as HTMLButtonElement;
      const sync = () =>
        Promise.resolve()
          .then(() => controls.isMaximized())
          .then((max) => {
            const label = max ? w.restore : w.maximize;
            const icon = iconButton("window-button", max ? i.restore : i.maximize);
            maximize.replaceChildren(...icon.childNodes);
            maximize.title = label;
            maximize.setAttribute("aria-label", label);
          })
          .catch(() => {});
      void sync();
      Promise.resolve()
        .then(() => controls.onResized(() => void sync()))
        .then((stop) => {
          if (this.disposed) stop();
          else this.stopResize = stop;
        })
        .catch(() => {});
    }
    return this.titleBar;
  }

  private buildBar(): HTMLElement {
    const header = h("header", "bar");
    for (const items of bar) {
      const zone = h("div", "zone");
      for (const item of items) {
        if (item.kind === "button") zone.append(this.actionButton(item.action, "bar-button"));
        else if (item.kind === "notice") zone.append(this.notice);
        else if (item.kind === "more") zone.append(this.buildMore());
        else {
          this.zoomReadout.title = strings.zoomToggle;
          this.zoomReadout.addEventListener("click", () => this.setZoom(100));
          zone.append(this.zoomReadout);
        }
      }
      header.append(zone);
    }
    header.append(this.buildFind());
    return header;
  }

  /** The find box under the bar, shown by Find: Enter and Shift+Enter cycle the matches. */
  private buildFind(): HTMLElement {
    this.findBox.hidden = true;
    this.findBox.setAttribute("role", "search");
    this.findInput.type = "text";
    this.findInput.placeholder = strings.findPlaceholder;
    this.findInput.setAttribute("aria-label", strings.findPlaceholder);
    const search = () => {
      clearTimeout(this.findTimer);
      this.findTimer = undefined;
      this.runFind(true);
      this.update();
    };
    this.findInput.addEventListener("input", () => {
      clearTimeout(this.findTimer);
      this.findTimer = setTimeout(search, FIND_DEBOUNCE_MS);
    });
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      // Typed and Enter at once: the search runs first, then Enter moves on, as it would have.
      if (this.findTimer !== undefined) search();
      this.stepFind(e.shiftKey ? -1 : 1);
    });
    this.findCount.setAttribute("aria-live", "polite");
    this.findBox.append(
      this.findInput,
      this.findCount,
      this.actionButton("findPrevious", "find-button"),
      this.actionButton("findNext", "find-button"),
      this.actionButton("findClose", "find-button"),
    );
    return this.findBox;
  }

  /** ⋮ More: the menu's sections in one list, divided by rules. */
  private buildMore(): HTMLElement {
    const button = iconButton("menu-button", strings.icons.more);
    button.title = strings.more;
    button.setAttribute("aria-label", strings.more);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    const list = h("div", "menu");
    list.setAttribute("role", "menu");
    list.hidden = true;
    for (const [n, section] of menus.entries()) {
      if (n > 0) {
        const rule = h("div", "menu-rule");
        rule.setAttribute("role", "separator");
        list.append(rule);
      }
      for (const id of section) {
        const item = h("button", "menu-item", actions[id].label);
        item.setAttribute("role", "menuitem");
        item.dataset.action = id;
        // Each command shows its shortcut, as native menus do.
        item.setAttribute("aria-keyshortcuts", actions[id].key);
        item.append(h("kbd", "menu-key", actions[id].key));
        if (id === "viewSource") {
          this.sourceItem = item;
          item.setAttribute("role", "menuitemcheckbox");
        }
        if (id === "wideSheet") item.setAttribute("role", "menuitemcheckbox");
        item.addEventListener("click", () => {
          this.closeMenus();
          this.run(id);
        });
        list.append(item);
      }
    }
    button.addEventListener("click", () => {
      const opening = list.hidden;
      this.closeMenus();
      list.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
    });
    this.menuBar.append(button, list, this.buildFileMenu());
    return this.menuBar;
  }

  private buildFileMenu(): HTMLElement {
    const menu = this.fileMenu;
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    const platform = navigator.platform;
    const m = strings.fileMenu;
    const reveal = /Mac/.test(platform)
      ? m.revealMac
      : /Win/.test(platform)
        ? m.revealWindows
        : m.revealLinux;
    const item = (label: string, act: (path: string) => Promise<void>, failed: string) => {
      const button = h("button", "menu-item", label);
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => {
        this.closeMenus();
        act(this.fileMenuPath).catch(() => this.show(failed));
      });
      return button;
    };
    menu.append(
      item(reveal, (path) => this.backend.revealFile(path), strings.notices.revealFailed),
      item(m.copyPath, (path) => navigator.clipboard.writeText(path), strings.notices.copyFailed),
    );
    return menu;
  }

  private openFileMenu(x: number, y: number, path: string): void {
    this.closeMenus();
    this.fileMenuPath = path;
    this.fileMenu.hidden = false;
    // Kept inside the window when opened near its right or bottom edge.
    const { innerWidth, innerHeight } = this.root.ownerDocument.defaultView ?? window;
    const { width, height } = this.fileMenu.getBoundingClientRect();
    this.fileMenu.style.left = `${Math.max(0, Math.min(x, innerWidth - width))}px`;
    this.fileMenu.style.top = `${Math.max(0, Math.min(y, innerHeight - height))}px`;
  }

  /** More › Restart to update to x.y.z, in its own section at the end; a later version replaces it. */
  private offerUpdate(version: string): void {
    const list = this.menuBar.querySelector(".menu");
    const offered = list?.querySelector('[data-action="update"]');
    if (offered) offered.textContent = strings.restartToUpdate(version);
    if (!list || offered) return;
    const rule = h("div", "menu-rule");
    rule.setAttribute("role", "separator");
    const item = h("button", "menu-item", strings.restartToUpdate(version));
    item.setAttribute("role", "menuitem");
    item.dataset.action = "update";
    item.addEventListener("click", () => {
      this.closeMenus();
      this.backend.installUpdate().catch(() => this.show(strings.notices.updateFailed));
    });
    list.append(rule, item);
  }

  private closeMenus(): void {
    for (const list of this.menuBar.querySelectorAll<HTMLElement>(".menu")) list.hidden = true;
    const buttons = this.root.querySelectorAll(".menu-button, .tab-menu");
    for (const button of buttons) {
      button.setAttribute("aria-expanded", "false");
    }
  }

  private onKey(e: KeyboardEvent): void {
    // A key may scroll the page, which releases a section clicked in the outline.
    this.sectionHeld = false;
    // The print and settings dialogs are modal: Esc closes them, other shortcuts wait.
    if (this.modal) {
      if (e.key === "Escape") {
        this.closeModal();
        e.preventDefault();
      }
      return;
    }
    // Esc closes an open menu or the shortcuts list before it closes find.
    const menuOpen = [...this.menuBar.querySelectorAll<HTMLElement>(".menu")].some(
      (m) => !m.hidden,
    );
    if (e.key === "Escape" && (menuOpen || this.shortcutsPanel)) {
      this.closeMenus();
      if (this.shortcutsPanel) this.toggleShortcuts();
      e.preventDefault();
      return;
    }
    const action = Object.values(actions).find((a) => matchesKey(a.key, e));
    if (action && this.enabled(action.id)) {
      e.preventDefault();
      this.run(action.id);
    }
  }

  /**
   * Links never navigate the webview: external ones go to the OS, `#` ones scroll, Markdown
   * ones open in the tab, or in a new tab on Ctrl-click or middle-click.
   */
  private onLinkClick(e: MouseEvent): void {
    const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
    const tab = this.active;
    if (!link || !tab?.sheet.contains(link)) return;
    e.preventDefault();
    let gesture: Gesture;
    if (e.type === "auxclick" && e.button === 1) gesture = "newTab";
    else if (e.type === "click" && e.button === 0) {
      gesture = e.ctrlKey || e.metaKey ? "newTab" : "click";
    } else return;
    const action = route(link, pathOf(tab), gesture);
    if (action.type === "external") void this.backend.openExternal(action.url).catch(() => {});
    else if (action.type === "scroll") this.land(tab, action.fragment);
    else if (action.type === "navigate") this.navigate(tab, action.entry);
    else if (action.type === "newTab") void this.openEntries([action.entry]);
    else this.show(strings.notices.notMarkdown);
  }

  private update(): void {
    const { active } = this;
    for (const tab of this.tabs) {
      tab.label.textContent = basename(pathOf(tab));
      tab.label.title = pathOf(tab);
      tab.handle.classList.toggle("active", tab === active);
      tab.handle.setAttribute("aria-selected", String(tab === active));
      tab.canvas.hidden = tab !== active;
    }
    this.empty.hidden = active !== null;
    if (!active) this.drawEmpty();
    this.root.ownerDocument.title = active
      ? strings.windowTitle(basename(pathOf(active)))
      : strings.appName;
    // Find follows the active tab, and closes with the last one.
    if (!active) {
      this.found.open = false;
      this.findBox.hidden = true;
    }
    if (this.found.root !== (this.found.open && active ? shown(active) : null)) this.runFind(true);
    for (const node of this.root.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
      if (node.classList.contains("tab-close")) continue;
      node.disabled = !this.enabled(node.dataset.action as ActionId);
    }
    for (const node of this.root.querySelectorAll(".bar-button[data-action=outline]")) {
      node.setAttribute("aria-pressed", String(this.outlineOpen));
    }
    this.applySettings();
    this.drawOutline();
    // After the outline, which moves the canvas's edge.
    this.layoutSheet();
  }

  /** Sizes the sheet to the window: text scales with the zoom and lines rewrap, so the sheet
   * never runs past the canvas (no sideways scrolling). */
  private layoutSheet(): void {
    const width = this.active?.canvas.clientWidth ?? 0;
    if (width <= 0) return;
    const { maxWidth, padScale } = sheetLayout(width, this.wide);
    this.view.style.setProperty("--sheet-max", `${maxWidth}px`);
    this.view.style.setProperty("--sheet-pad", String(padScale));
  }

  private applySettings(): void {
    const html = this.root.ownerDocument.documentElement;
    if (this.theme === "system") delete html.dataset.theme;
    else html.dataset.theme = this.theme;
    html.dataset.style = this.style;
    this.view.style.setProperty("--zoom", String(this.zoom / 100));
    for (const el of this.root.querySelectorAll('[data-action="wideSheet"]')) {
      if (el.getAttribute("role") === "menuitemcheckbox") {
        el.setAttribute("aria-checked", String(this.wide));
        continue;
      }
      // Toolbar toggle: icon and tooltip name the layout a click switches to.
      el.setAttribute("aria-pressed", String(this.wide));
      const label = this.wide ? strings.sheetFixed : strings.sheetFill;
      el.setAttribute("aria-label", label);
      (el as HTMLElement).title = label;
      el.querySelector("path")?.setAttribute(
        "d",
        this.wide ? strings.icons.sheetFixed : strings.icons.sheetFill,
      );
    }
    this.zoomReadout.textContent = strings.zoomPercent(this.zoom);
    for (const item of this.themeItems)
      item.setAttribute("aria-checked", String(item.dataset.theme === this.theme));
    for (const item of this.styleItems)
      item.setAttribute("aria-checked", String(item.dataset.style === this.style));
    this.remoteItem?.setAttribute("aria-checked", String(this.config?.remoteImages ?? true));
    this.sourceItem?.setAttribute("aria-checked", String(this.active?.source.hidden === false));
  }

  /** "Open or drop a Markdown file", and the recent files under it. */
  private drawEmpty(): void {
    const drop = h("button", "drop", strings.emptyState);
    drop.addEventListener("click", () => this.run("open"));
    this.empty.replaceChildren(drop);
    const recent = this.config?.recentFiles ?? [];
    if (recent.length === 0) return;
    const section = h("section", "recent");
    const list = h("ul");
    recent.forEach((path, index) => {
      const item = userText("button", "recent-file", basename(path));
      item.title = path;
      item.addEventListener("click", () => void this.openPaths([path]));
      const remove = iconButton("recent-remove", strings.icons.closeTab);
      remove.title = strings.recentRemove(basename(path));
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () =>
        this.dropRecent(
          recent.filter((p) => p !== path),
          index,
        ),
      );
      const li = h("li");
      li.append(item, remove);
      list.append(li);
    });
    const clear = h("button", "recent-clear", strings.recentClear);
    clear.addEventListener("click", () => this.dropRecent([], 0));
    section.append(h("h2", "", strings.recentFiles), list, clear);
    this.empty.append(section);
  }
}
