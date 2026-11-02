// The window's chrome as data (D-11): the shell draws it and the budget test counts it.
import { strings } from "../strings";
import type { Config } from "./ipc";

export type ActionId = keyof typeof strings.actions;

export interface Action {
  id: ActionId;
  label: string;
  icon?: string;
  /** e.g. `Ctrl+O`, `Alt+ArrowLeft`; matched against `KeyboardEvent.key`. */
  key: string;
  /** Acts on the active document, so it is disabled with none open. */
  needsDocument?: boolean;
  /** Shows a native dialog. Only actions the user explicitly asks for may (D-11). */
  dialog?: boolean;
}

const a = strings.actions;
const i = strings.icons;

export const actions: Record<ActionId, Action> = {
  open: { id: "open", label: a.open, key: "Ctrl+O", dialog: true },
  print: {
    id: "print",
    label: a.print,
    icon: i.print,
    key: "Ctrl+P",
    needsDocument: true,
    dialog: true,
  },
  export: {
    id: "export",
    label: a.export,
    icon: i.export,
    key: "Ctrl+Shift+E",
    needsDocument: true,
    dialog: true,
  },
  newTab: { id: "newTab", label: a.newTab, icon: i.newTab, key: "Ctrl+T" },
  closeTab: {
    id: "closeTab",
    label: a.closeTab,
    icon: i.closeTab,
    key: "Ctrl+W",
    needsDocument: true,
  },
  nextTab: { id: "nextTab", label: a.nextTab, key: "Ctrl+Tab", needsDocument: true },
  previousTab: {
    id: "previousTab",
    label: a.previousTab,
    key: "Ctrl+Shift+Tab",
    needsDocument: true,
  },
  outline: { id: "outline", label: a.outline, icon: i.outline, key: "Ctrl+B", needsDocument: true },
  back: { id: "back", label: a.back, icon: i.back, key: "Alt+ArrowLeft", needsDocument: true },
  forward: {
    id: "forward",
    label: a.forward,
    icon: i.forward,
    key: "Alt+ArrowRight",
    needsDocument: true,
  },
  zoomOut: { id: "zoomOut", label: a.zoomOut, icon: i.zoomOut, key: "Ctrl+-", needsDocument: true },
  zoomIn: { id: "zoomIn", label: a.zoomIn, icon: i.zoomIn, key: "Ctrl+=", needsDocument: true },
  zoomReset: { id: "zoomReset", label: a.zoomReset, key: "Ctrl+0", needsDocument: true },
  wideSheet: {
    id: "wideSheet",
    label: a.wideSheet,
    icon: i.sheetFill,
    key: "Ctrl+9",
    needsDocument: true,
  },
  find: { id: "find", label: a.find, icon: i.find, key: "Ctrl+F", needsDocument: true },
  findNext: {
    id: "findNext",
    label: a.findNext,
    icon: i.findNext,
    key: "F3",
    needsDocument: true,
  },
  findPrevious: {
    id: "findPrevious",
    label: a.findPrevious,
    icon: i.findPrevious,
    key: "Shift+F3",
    needsDocument: true,
  },
  findClose: {
    id: "findClose",
    label: a.findClose,
    icon: i.findClose,
    key: "Escape",
    needsDocument: true,
  },
  viewSource: { id: "viewSource", label: a.viewSource, key: "Ctrl+U", needsDocument: true },
  theme: { id: "theme", label: a.theme, key: "Ctrl+Shift+L" },
  remoteImages: { id: "remoteImages", label: a.remoteImages, key: "Ctrl+Shift+M" },
  settings: { id: "settings", label: a.settings, key: "Ctrl+," },
  shortcuts: { id: "shortcuts", label: a.shortcuts, key: "F1" },
  help: { id: "help", label: a.help, key: "Shift+F1" },
  about: { id: "about", label: a.about, key: "Ctrl+F1" },
};

export type BarItem =
  | { kind: "button"; action: ActionId }
  | { kind: "notice" }
  | { kind: "more" }
  | { kind: "zoom" };

/** The one slim bar in three zones, left, centre, right (Chrome's PDF viewer, D-19). */
export const bar: BarItem[][] = [
  [
    { kind: "button", action: "outline" },
    { kind: "button", action: "back" },
    { kind: "button", action: "forward" },
    { kind: "notice" },
  ],
  [
    { kind: "button", action: "zoomOut" },
    { kind: "zoom" },
    { kind: "button", action: "zoomIn" },
    { kind: "button", action: "wideSheet" },
  ],
  [
    { kind: "button", action: "find" },
    { kind: "button", action: "export" },
    { kind: "button", action: "print" },
    { kind: "more" },
  ],
];

/** ⋮ More's sections, divided by rules; every command keeps its shortcut. */
export const menus: ActionId[][] = [
  ["open", "export", "print", "closeTab"],
  ["outline", "zoomIn", "zoomOut", "zoomReset", "wideSheet", "find", "viewSource"],
  ["back", "forward", "nextTab", "previousTab"],
  // Theme and remote images are set in Settings; their shortcuts still work from anywhere.
  ["settings", "shortcuts", "help", "about"],
];

/** What the user can set; window size is remembered by the window-state plugin. */
export const settings = [
  "theme",
  "style",
  "defaultZoom",
  "remoteImages",
] as const satisfies readonly (keyof Config)[];

export function barButtons(): ActionId[] {
  return bar.flat().flatMap((item) => (item.kind === "button" ? [item.action] : []));
}

/** Whether a keydown matches an action's `key`, e.g. `Ctrl+O`. */
export function matchesKey(key: string, e: KeyboardEvent): boolean {
  // ponytail: no key is `+` itself; `Ctrl` means Cmd on macOS.
  const parts = key.split("+");
  const main = parts.pop() ?? "";
  const ctrl = /Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
  // `Ctrl+=` also answers to `Ctrl++`, typed with Shift or on the keypad.
  const plus = main === "=" && e.key === "+";
  return (
    (plus || e.key.toLowerCase() === main.toLowerCase()) &&
    ctrl === parts.includes("Ctrl") &&
    e.altKey === parts.includes("Alt") &&
    (plus || e.shiftKey === parts.includes("Shift"))
  );
}
