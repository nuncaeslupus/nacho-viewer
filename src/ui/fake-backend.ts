import type { Backend, Config, DocumentChanged, UpdateAvailable } from "./ipc";
import type { PdfMark } from "./links";

/** Where the fake's `image:` protocol URLs point (Tauri's Windows form, so a browser can route it). */
export const FAKE_IMAGE_ORIGIN = "http://image.localhost";

/** An in-memory Rust core for tests: `files` maps a path to its Markdown. */
export function fakeBackend(files: Record<string, string>, launch: string[] = []) {
  let openFiles: (paths: string[]) => void = () => {};
  let documentChanged: (change: DocumentChanged) => void = () => {};
  let updateAvailable: (update: UpdateAvailable) => void = () => {};
  const mtimes: Record<string, number> = {};
  let clock = 1000;
  const state = {
    config: {
      version: 1,
      theme: "system",
      defaultZoom: 100,
      remoteImages: true,
      wideSheet: false,
      style: "classic",
      recentFiles: [],
    } as Config,
    external: [] as string[],
    revealed: [] as string[],
    /** Where the guide lands; `null` makes `helpFile` fail. */
    guide: "/data/help/Guide.md" as string | null,
    userCss: null as string | null,
    dialogPaths: [] as string[],
    dialogCalls: 0,
    dialogNear: undefined as string | undefined,
    /** What the save dialog returns; `null` is a cancel. */
    savePath: null as string | null,
    saveNames: [] as string[],
    exported: [] as string[],
    previewed: [] as string[],
    pdfMarks: [] as PdfMark[],
    /** Calls to the core's print; `printHandled` is what it answers. */
    printed: 0,
    printHandled: false,
    reads: 0,
    unwatchCalls: 0,
    updateChecks: 0,
    installs: 0,
    /** When set, the matching call rejects with this error. */
    fail: {} as Partial<
      Record<"openDialog" | "getConfig" | "setConfig" | "readUserCss" | "installUpdate", unknown>
    >,
    /** When set, reads wait for it. */
    readGate: undefined as Promise<void> | undefined,
    /** Watchers per path, as the core counts them. */
    watched: {} as Record<string, number>,
    /** Paths whose `watch` rejects. */
    unwatchable: [] as string[],
    emitOpenFiles: (paths: string[]) => openFiles(paths),
    emitDocumentChanged: (change: DocumentChanged) => documentChanged(change),
    emitUpdateAvailable: (update: UpdateAvailable) => updateAvailable(update),
    /** When set, the next read takes the file as it is now, then waits for this. */
    nextReadWaits: undefined as Promise<void> | undefined,
    /** An external save, by default with a newer mtime, and the event if the path is watched. */
    write: (path: string, text: string, mtime = ++clock) => {
      files[path] = text;
      mtimes[path] = mtime;
      if (state.watched[path]) documentChanged({ path, mtime_ms: mtime });
    },
    remove: (path: string) => {
      delete files[path];
      if (state.watched[path]) documentChanged({ path, deleted: true });
    },
  };
  const failing = (call: keyof typeof state.fail) => {
    if (call in state.fail) throw state.fail[call];
  };
  const backend: Backend = {
    takeOpenFiles: async () => launch.splice(0),
    openDialog: async (near) => {
      state.dialogCalls++;
      state.dialogNear = near;
      await state.readGate;
      failing("openDialog");
      return state.dialogPaths;
    },
    saveDialog: async (name, near) => {
      state.saveNames.push(name);
      state.dialogNear = near;
      return state.savePath;
    },
    exportPdf: async (path, marks) => {
      state.exported.push(path);
      state.pdfMarks = marks;
    },
    previewPdf: async (name, marks) => {
      state.previewed.push(name);
      state.pdfMarks = marks;
    },
    printDocument: async () => {
      state.printed++;
      return state.printHandled;
    },
    readDocument: async (path) => {
      state.reads++;
      const waits = state.nextReadWaits;
      if (waits) {
        state.nextReadWaits = undefined;
        const snapshot = { path, text: files[path], mtime_ms: mtimes[path] ?? 0 };
        await waits;
        return snapshot;
      }
      await state.readGate;
      if (!(path in files)) throw { kind: "not_found", message: `${path}: not found` };
      return { path, text: files[path], mtime_ms: mtimes[path] ?? 0 };
    },
    readSvg: async (path) => {
      if (!(path in files)) throw { kind: "not_found", message: `${path}: not found` };
      return files[path];
    },
    imageUrl: (path) => `${FAKE_IMAGE_ORIGIN}/${encodeURIComponent(path)}`,
    getConfig: async () => {
      failing("getConfig");
      return structuredClone(state.config);
    },
    setConfig: async (config) => {
      failing("setConfig");
      state.config = config;
    },
    readUserCss: async () => {
      failing("readUserCss");
      return state.userCss;
    },
    openExternal: async (url) => {
      state.external.push(url);
    },
    revealFile: async (path) => {
      state.revealed.push(path);
    },
    helpFile: async () => {
      if (state.guide === null) throw { kind: "io", message: "no guide" };
      files[state.guide] = "# Guide";
      return state.guide;
    },
    appVersion: async () => "1.2.3",
    watch: async (path) => {
      if (state.unwatchable.includes(path)) throw { kind: "io", message: `${path}: no watch` };
      state.watched[path] = (state.watched[path] ?? 0) + 1;
    },
    unwatch: async (path) => {
      state.unwatchCalls++;
      if (state.watched[path]) state.watched[path]--;
    },
    checkUpdate: async () => {
      state.updateChecks++;
    },
    installUpdate: async () => {
      failing("installUpdate");
      state.installs++;
    },
    onOpenFiles: async (handler) => {
      openFiles = handler;
      return () => {
        openFiles = () => {};
      };
    },
    onDocumentChanged: async (handler) => {
      documentChanged = handler;
      return () => {
        documentChanged = () => {};
      };
    },
    onUpdateAvailable: async (handler) => {
      updateAvailable = handler;
      return () => {
        updateAvailable = () => {};
      };
    },
  };
  return { backend, state };
}

/** Lets pending promise callbacks run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise and the function that resolves it. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
