import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PdfMark } from "./links";

export interface Config {
  version: number;
  theme: "system" | "light" | "dark";
  defaultZoom: number;
  remoteImages: boolean;
  /** The sheet fills the window instead of keeping a book's line length. */
  wideSheet: boolean;
  /** Settings › Style: the document's faces and spacing. */
  style: string;
  recentFiles: string[];
}

export interface Doc {
  path: string;
  text: string;
  mtime_ms: number;
}

/** Payload of `document-changed`: a new `mtime_ms`, or `deleted`. */
export interface DocumentChanged {
  path: string;
  mtime_ms?: number;
  deleted?: boolean;
}

/** Payload of `update-available`: the newer version the updater found. */
export interface UpdateAvailable {
  version: string;
}

/** The Rust core, as the shell sees it; tests pass a fake. */
export interface WindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Resolves to the function that stops listening. */
  onResized(handler: () => void): Promise<() => void>;
}

export interface Backend {
  takeOpenFiles(): Promise<string[]>;
  /** The native Open dialog, starting in the folder of `near`, the last file opened. */
  openDialog(near?: string): Promise<string[]>;
  /** The native Save dialog, offering `name`, starting like Open; `null` when cancelled. */
  saveDialog(name: string, near?: string): Promise<string | null>;
  /** Prints the page to `path`, which must be the Save dialog's last answer. */
  exportPdf(path: string, marks: PdfMark[]): Promise<void>;
  /** The same PDF in the temp folder, opened in the system viewer. */
  previewPdf(name: string, marks: PdfMark[]): Promise<void>;
  /** The system print dialog over the same page as the PDF; `false` where the webview's own
   * print is used instead. */
  printDocument(): Promise<boolean>;
  readDocument(path: string): Promise<Doc>;
  /** The markup of a local SVG, for inlining after sanitising (2 MB cap). */
  readSvg(path: string): Promise<string>;
  /** The `image:` protocol URL of a local image, for `<img src>`. */
  imageUrl(path: string): string;
  getConfig(): Promise<Config>;
  setConfig(config: Config): Promise<void>;
  /** `$XDG_CONFIG_HOME/nacho-viewer/user.css`, or `null` when there is none. */
  readUserCss(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  /** Opens the system file manager at an open document, with it selected. */
  revealFile(path: string): Promise<void>;
  /** Writes the bundled user guide to disk and returns its path, ready to open. */
  helpFile(): Promise<string>;
  /** The version of the running app. */
  appVersion(): Promise<string>;
  /** The window's own buttons, drawn in the tab strip; absent where the system draws them. */
  window?: WindowControls;
  /** Watching is reference-counted in the core: each `watch` needs its own `unwatch`. */
  watch(path: string): Promise<void>;
  unwatch(path: string): Promise<void>;
  /** Asks for `latest.json` once; a newer version arrives as `update-available`. */
  checkUpdate(): Promise<void>;
  /** Installs the newer version and restarts into it; settles only on failure. */
  installUpdate(): Promise<void>;
  /** Resolves to the function that stops listening. */
  onOpenFiles(handler: (paths: string[]) => void): Promise<() => void>;
  onDocumentChanged(handler: (change: DocumentChanged) => void): Promise<() => void>;
  onUpdateAvailable(handler: (update: UpdateAvailable) => void): Promise<() => void>;
}

interface OpenFiles {
  paths: string[];
}

export const tauriBackend: Backend = {
  takeOpenFiles: () => invoke<OpenFiles>("take_open_files").then((r) => r.paths),
  openDialog: (near) => invoke<OpenFiles>("open_dialog", { near }).then((r) => r.paths),
  saveDialog: (name, near) => invoke<string | null>("save_dialog", { name, near }),
  exportPdf: (path, marks) => invoke<void>("export_pdf", { path, marks }),
  previewPdf: (name, marks) => invoke<void>("preview_pdf", { name, marks }),
  printDocument: () => invoke<boolean>("print_document"),
  readDocument: (path) => invoke<Doc>("read_document", { path }),
  readSvg: (path) => invoke<{ svg: string }>("read_svg", { path }).then((r) => r.svg),
  imageUrl: (path) => convertFileSrc(path, "image"),
  getConfig: () => invoke<Config>("get_config"),
  setConfig: (config) => invoke<void>("set_config", { config }),
  readUserCss: () => invoke<{ css: string | null }>("read_user_css").then((r) => r.css),
  openExternal: (url) => invoke<void>("open_external", { url }),
  revealFile: (path) => invoke<void>("reveal_file", { path }),
  helpFile: () => invoke<string>("help_file"),
  appVersion: getVersion,
  window: {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
    startDragging: () => getCurrentWindow().startDragging(),
    isMaximized: () => getCurrentWindow().isMaximized(),
    onResized: (handler) => getCurrentWindow().onResized(() => handler()),
  },
  watch: (path) => invoke<void>("watch", { path }),
  unwatch: (path) => invoke<void>("unwatch", { path }),
  checkUpdate: () => invoke<void>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
  onOpenFiles: (handler) => listen<OpenFiles>("open-files", (e) => handler(e.payload.paths)),
  onDocumentChanged: (handler) =>
    listen<DocumentChanged>("document-changed", (e) => handler(e.payload)),
  onUpdateAvailable: (handler) =>
    listen<UpdateAvailable>("update-available", (e) => handler(e.payload)),
};

/** The message of an `IpcError` (`{kind, message}`), or of anything else thrown. */
export function errorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) return String(err.message);
  return String(err);
}
