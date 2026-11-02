import { afterEach, describe, expect, it, vi } from "vitest";
import { strings } from "../strings";
import { actions, matchesKey, menus } from "./definition";
import { fakeBackend, gate, settle } from "./fake-backend";
import { Shell } from "./shell";

const shells: Shell[] = [];
const scrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  for (const shell of shells.splice(0)) shell.dispose();
  Element.prototype.scrollIntoView = scrollIntoView;
});

type FakeState = ReturnType<typeof fakeBackend>["state"];

async function open(
  files: Record<string, string>,
  launch: string[],
  setup: (state: FakeState) => void = () => {},
) {
  const fake = fakeBackend(files, launch);
  setup(fake.state);
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const shell = new Shell(root, fake.backend);
  shells.push(shell);
  await shell.start();
  return { root, shell, ...fake };
}

const notice = (root: Element) => root.querySelector(".bar .notice")?.textContent;
const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
const press = (init: KeyboardEventInit) => document.dispatchEvent(key(init));

function click(el: Element | null, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el?.dispatchEvent(e);
  return e;
}

describe("shell", () => {
  it("test_bar_has_three_zones_and_more_menu", async () => {
    const { root } = await open({ "/d/a.md": "# A" }, ["/d/a.md"]);
    // Chrome's PDF viewer (D-19): navigation left, zoom centred, tools and ⋮ More right.
    const zones = [...root.querySelectorAll(".bar > .zone")].map((zone) =>
      [
        ...zone.querySelectorAll<HTMLElement>(
          ":is([data-action], .zoom, .menu-button):not(.menu *)",
        ),
      ].map((el) => el.dataset.action ?? el.className),
    );
    expect(zones).toEqual([
      ["outline", "back", "forward"],
      ["zoomOut", "zoom", "zoomIn", "wideSheet"],
      ["find", "export", "print", "menu-button"],
    ]);
    // One ⋮ More button replaces the text menus, and lists every one of their commands.
    const more = root.querySelectorAll(".bar .menu-button");
    expect(more).toHaveLength(1);
    expect(more[0]?.textContent).toBe("");
    click(more[0] ?? null);
    const items = [...root.querySelectorAll<HTMLElement>(".menu:not([hidden]) .menu-item")];
    expect(items.map((i) => i.dataset.action)).toEqual(menus.flat());
    // Each item shows its shortcut.
    expect(items.map((i) => i.querySelector("kbd")?.textContent)).toEqual(
      menus.flat().map((id) => actions[id].key),
    );
  });

  it("test_find_and_print_use_material_icons", async () => {
    const { root } = await open({ "/d/a.md": "# A" }, ["/d/a.md"]);
    // Material Symbols' search and print, as in Chrome's PDF viewer (D-21).
    for (const [id, start] of [
      ["find", "M784-120 532-372"],
      ["print", "M640-640v-120H320"],
    ]) {
      const path = root.querySelector(`.bar [data-action="${id}"] svg path`);
      expect(path?.getAttribute("d")).toMatch(new RegExp(`^${start}`));
    }
  });

  it("test_preview_opens_the_pdf_and_keeps_the_dialog", async () => {
    const { root, state } = await open({ "/n/notes.md": "# A" }, ["/n/notes.md"]);
    click(root.querySelector('.bar [data-action="print"]'));
    click(root.querySelector(".print-dialog .print-preview"));
    for (let i = 0; i < 5; i++) await settle();
    expect(state.previewed).toEqual(["notes"]);
    expect(root.querySelector(".print-dialog")).not.toBeNull();
    expect(state.exported).toEqual([]);
  });

  it("test_export_asks_for_a_path_and_saves_pdf", async () => {
    const { root, state } = await open({ "/n/notes.md": "# A" }, ["/n/notes.md"]);
    // Export opens the intermediate page; its Save button asks for the path.
    const doExport = () => {
      click(root.querySelector('.bar [data-action="export"]'));
      click(root.querySelector(".print-dialog .print-save"));
    };
    // Cancelling the save dialog saves nothing.
    doExport();
    for (let i = 0; i < 5; i++) await settle();
    expect(state.saveNames).toEqual(["notes.pdf"]);
    expect(state.dialogNear).toBe(state.config.recentFiles[0]);
    expect(state.exported).toEqual([]);

    state.savePath = "/out/notes.pdf";
    doExport();
    for (let i = 0; i < 5; i++) await settle();
    expect(state.exported).toEqual(["/out/notes.pdf"]);
  });

  it("test_export_marks_links_only_while_it_prints", async () => {
    const source = "[a](https://a.example)";
    const { root, state } = await open({ "/n/notes.md": source }, ["/n/notes.md"]);
    state.savePath = "/out/notes.pdf";
    click(root.querySelector('.bar [data-action="export"]'));
    click(root.querySelector(".print-dialog .print-save"));
    for (let i = 0; i < 5; i++) await settle();
    expect(state.pdfMarks).toEqual([{ uri: "https://a.example" }]);
    expect(root.querySelector<HTMLElement>(".sheet a")?.style.backgroundColor).toBe("");
  });

  it("test_new_tab_opens_the_open_dialog", async () => {
    const { root, state } = await open({ "/n/a.md": "# A", "/n/b.md": "# B" }, ["/n/a.md"]);
    const labels = () => [...root.querySelectorAll(".tabs .tab-label")].map((l) => l.textContent);
    // "+" and Ctrl+T open files the same way Open does: the dialog, into a new tab.
    state.dialogPaths = ["/n/b.md"];
    click(root.querySelector(".titlebar .new-tab"));
    for (let i = 0; i < 5; i++) await settle();
    expect(labels()).toEqual(["a.md", "b.md"]);
    expect(root.querySelector(".tab.active .tab-label")?.textContent).toBe("b.md");
    state.dialogPaths = ["/n/a.md"];
    press({ key: "t", ctrlKey: true });
    for (let i = 0; i < 5; i++) await settle();
    expect(labels()).toEqual(["a.md", "b.md"]);
    expect(root.querySelector(".tab.active .tab-label")?.textContent).toBe("a.md");
  });

  it("test_print_uses_the_cores_page_where_offered", async () => {
    const { root, state, backend } = await open({ "/n/notes.md": "# A" }, ["/n/notes.md"]);
    const browserPrint = vi.spyOn(window, "print").mockImplementation(() => {});
    // Print opens the intermediate page; its Print button runs the actual print.
    const doPrint = async () => {
      click(root.querySelector('.bar [data-action="print"]'));
      click(root.querySelector(".print-dialog .print-go"));
      for (let i = 0; i < 5; i++) await settle();
    };
    try {
      // Linux: the core prints the same page as the PDF, and the webview's print stays unused.
      state.printHandled = true;
      await doPrint();
      expect(state.printed).toBe(1);
      expect(browserPrint).not.toHaveBeenCalled();
      // Elsewhere the core declines and the webview prints.
      state.printHandled = false;
      await doPrint();
      expect(state.printed).toBe(2);
      expect(browserPrint).toHaveBeenCalledTimes(1);
      // A failed print says so and leaves Print usable.
      const fail = vi.spyOn(backend, "printDocument").mockRejectedValueOnce(new Error("no"));
      await doPrint();
      expect(notice(root)).toBe(strings.notices.printFailed);
      fail.mockRestore();
      await doPrint();
      expect(state.printed).toBe(3);
    } finally {
      browserPrint.mockRestore();
    }
  });

  it("test_print_dialog_sets_the_paper_text_size", async () => {
    const { root, state } = await open({ "/n/notes.md": "# A" }, ["/n/notes.md"]);
    click(root.querySelector('.bar [data-action="print"]'));
    expect(root.querySelector(".print-dialog")).not.toBeNull();
    // Small / Normal / Large; Normal (1) is the default selection.
    const sizes = [...root.querySelectorAll<HTMLElement>(".print-size")];
    expect(sizes.map((b) => b.dataset.zoom)).toEqual(["0.85", "1", "1.2"]);
    expect(sizes[1]?.getAttribute("aria-checked")).toBe("true");
    // Choosing Large and printing scales the paper font and dismisses the page.
    click(sizes[2]);
    expect(sizes[2]?.getAttribute("aria-checked")).toBe("true");
    state.printHandled = true;
    click(root.querySelector(".print-go"));
    for (let i = 0; i < 5; i++) await settle();
    expect(state.printed).toBe(1);
    expect(root.ownerDocument.documentElement.style.getPropertyValue("--print-zoom")).toBe("1.2");
    expect(root.querySelector(".print-dialog")).toBeNull();
  });

  it("test_tab_renders_sanitised_document", async () => {
    const { root } = await open({ "/n/a.md": "# Hi\n\n<script>x()</script><b>ok</b>" }, [
      "/n/a.md",
    ]);
    const sheet = root.querySelector(".sheet");
    expect(sheet?.querySelector("h1")?.textContent).toBe("Hi");
    expect(sheet?.querySelector("script")).toBeNull();
    expect(sheet?.querySelector("b")?.textContent).toBe("ok");
    expect(root.querySelector(".tab.active .tab-label")?.textContent).toBe("a.md");
    expect(root.querySelector<HTMLElement>("main.empty")?.hidden).toBe(true);
  });

  it("test_read_error_shows_in_sheet_not_dialog", async () => {
    const { root } = await open({}, ["/n/gone.md"]);
    const error = root.querySelector(".sheet .doc-error");
    expect(error?.textContent).toContain(strings.documentError);
    expect(error?.textContent).toContain("/n/gone.md: not found");
  });

  it("test_open_focuses_existing_tab_and_close_falls_back", async () => {
    const files = { "/n/a.md": "a", "/n/b.md": "b" };
    const { root, shell } = await open(files, ["/n/a.md", "/n/b.md"]);
    await shell.openPaths(["/n/a.md"]);
    expect(root.querySelectorAll(".tab")).toHaveLength(2);
    expect(root.querySelector(".tab.active .tab-label")?.textContent).toBe("a.md");

    click(root.querySelector(".tab.active .tab-close"));
    expect(root.querySelectorAll(".tab")).toHaveLength(1);
    expect(root.querySelector(".tab.active .tab-label")?.textContent).toBe("b.md");
    root.ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true }));
    expect(root.querySelectorAll(".tab")).toHaveLength(0);
    expect(root.querySelector<HTMLElement>("main.empty")?.hidden).toBe(false);
  });

  it("test_open_rejects_non_markdown", async () => {
    const { root, shell } = await open({ "/n/a.md": "a" }, []);
    await shell.openPaths(["/n/doc.pdf", "/n/a.md"]);
    expect(notice(root)).toBe(strings.notices.notMarkdown);
    expect(root.querySelectorAll(".tab")).toHaveLength(1);
    expect(root.querySelector(".tab-label")?.textContent).toBe("a.md");
  });

  it("test_recent_files_newest_first_and_capped", async () => {
    const files = Object.fromEntries([...Array(12).keys()].map((i) => [`/n/${i}.md`, "x"]));
    const { root, shell, state } = await open(files, []);
    for (let i = 0; i < 12; i++) await shell.openPaths([`/n/${i}.md`]);
    await shell.openPaths(["/n/5.md"]);
    await settle();
    expect(state.config.recentFiles).toHaveLength(10);
    expect(state.config.recentFiles.slice(0, 2)).toEqual(["/n/11.md", "/n/10.md"]);

    for (const close of root.querySelectorAll(".tab-close")) click(close);
    const recent = [...root.querySelectorAll(".recent-file")].map((b) => b.textContent);
    expect(recent[0]).toBe("11.md");
    click(root.querySelector(".recent-file"));
    await settle();
    expect(root.querySelector(".tab.active .tab-label")?.textContent).toBe("11.md");
  });

  it("test_user_guide_opens_as_a_tab_and_stays_out_of_recent_files", async () => {
    const { root, state } = await open({}, []);
    press({ key: "F1", shiftKey: true });
    await vi.waitFor(() => expect(root.querySelector(".tab")).not.toBeNull());
    await settle();
    expect(root.querySelector(".sheet h1")?.textContent).toContain("Guide");
    expect(state.config.recentFiles).toEqual([]);
  });

  it("test_user_guide_failure_shows_a_notice", async () => {
    const { root } = await open({}, [], (s) => {
      s.guide = null;
    });
    press({ key: "F1", shiftKey: true });
    await vi.waitFor(() => expect(notice(root)).toBe(strings.notices.helpFailed));
  });

  it("test_about_shows_the_version_and_links_to_github", async () => {
    const { root, state } = await open({}, []);
    press({ key: "F1", ctrlKey: true });
    const panel = await vi.waitFor(() => {
      const found = root.querySelector(".about-dialog");
      expect(found).not.toBeNull();
      return found;
    });
    expect(panel?.textContent).toContain("Version 1.2.3");
    click(panel?.querySelector(".print-go") ?? null);
    expect(state.external).toEqual(["https://github.com/nuncaeslupus/nacho-viewer"]);
    click(panel?.querySelector(".print-cancel") ?? null);
    expect(root.querySelector(".about-dialog")).toBeNull();
  });

  it("test_recent_files_remove_one_then_clear", async () => {
    const { root, state } = await open({}, [], (s) => {
      s.config.recentFiles = ["/n/a.md", "/n/b.md", "/n/c.md"];
    });
    const names = () => [...root.querySelectorAll(".recent-file")].map((b) => b.textContent);
    expect(names()).toEqual(["a.md", "b.md", "c.md"]);

    click(root.querySelectorAll(".recent-remove")[1]);
    await settle();
    expect(names()).toEqual(["a.md", "c.md"]);
    expect(state.config.recentFiles).toEqual(["/n/a.md", "/n/c.md"]);
    // Removed with the keyboard, the next X is one Enter away.
    expect(document.activeElement).toBe(root.querySelectorAll(".recent-remove")[1]);

    click(root.querySelector(".recent-clear"));
    await settle();
    expect(root.querySelector(".recent")).toBeNull();
    expect(state.config.recentFiles).toEqual([]);
    expect(document.activeElement).toBe(root.querySelector(".drop"));
  });

  it("test_file_open_menu_uses_core_dialog", async () => {
    const { root, state } = await open({ "/n/a.md": "# A" }, []);
    state.dialogPaths = ["/n/a.md"];
    const fileMenu = root.querySelector(".menu-button");
    click(fileMenu);
    expect(root.querySelector<HTMLElement>(".menu")?.hidden).toBe(false);
    click(root.querySelector('.menu-item[data-action="open"]'));
    await settle();
    expect(root.querySelector(".sheet h1")?.textContent).toBe("A");
    expect(root.querySelector<HTMLElement>(".menu")?.hidden).toBe(true);
  });

  it("test_links_never_navigate_the_webview", async () => {
    const md = '[ext](https://a.org/x) [here](#goal) [rel](other.md)\n\n<p id="goal">t</p>';
    const { root, state } = await open({ "/n/a.md": md }, ["/n/a.md"]);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const links = root.querySelectorAll(".sheet a");

    const ext = click(links[0]);
    expect(ext.defaultPrevented).toBe(true);
    expect(state.external).toEqual(["https://a.org/x"]);

    expect(click(links[1]).defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(root.querySelector("#user-content-goal"));

    expect(click(links[2]).defaultPrevented).toBe(true);
    expect(state.external).toHaveLength(1);
  });

  it("test_open_dialog_starts_near_the_last_file_opened", async () => {
    const pressOpen = async () => {
      press({ key: "o", ctrlKey: true });
      await settle();
    };
    const first = await open({}, []);
    await pressOpen();
    expect(first.state.dialogNear).toBeUndefined();

    const recent = await open({}, [], (s) => {
      s.config.recentFiles = ["/n/old.md"];
    });
    await pressOpen();
    expect(recent.state.dialogNear).toBe("/n/old.md");

    // Even with another tab in front.
    const tabs = await open({ "/n/a.md": "# A", "/m/b.md": "# B" }, ["/n/a.md", "/m/b.md"]);
    click(tabs.root.querySelector(".tab"));
    await pressOpen();
    expect(tabs.state.dialogNear).toBe("/m/b.md");
  });

  it("test_dialog_failure_shows_notice_and_second_open_is_ignored", async () => {
    const { root, state } = await open({}, []);
    const pending = gate();
    state.readGate = pending.promise;
    state.fail.openDialog = { kind: "io", message: "no portal" };
    root.ownerDocument.dispatchEvent(key({ key: "o", ctrlKey: true }));
    root.ownerDocument.dispatchEvent(key({ key: "o", ctrlKey: true }));
    expect(state.dialogCalls).toBe(1);
    pending.open();
    await settle();
    expect(notice(root)).toBe(strings.notices.openFailed);
    expect(root.querySelectorAll(".tab")).toHaveLength(0);
  });

  it("test_config_failures_show_notice", async () => {
    const read = await open({ "/n/a.md": "a" }, ["/n/a.md"], (s) => {
      s.fail.getConfig = new Error("unreadable");
    });
    expect(notice(read.root)).toBe(strings.notices.settingsUnavailable);

    const save = await open({ "/n/a.md": "a" }, [], (s) => {
      s.fail.setConfig = new Error("read-only");
    });
    await save.shell.openPaths(["/n/a.md"]);
    await settle();
    expect(notice(save.root)).toBe(strings.notices.recentFilesNotSaved);
  });

  it("test_load_after_tab_closed_is_dropped", async () => {
    const { root, shell, state } = await open({ "/n/a.md": "# A", "/n/gone.md": "x" }, []);
    const pending = gate();
    state.readGate = pending.promise;
    const loading = shell.openPaths(["/n/a.md"]);
    const sheet = root.querySelector(".sheet");
    click(root.querySelector(".tab-close"));
    pending.open();
    await loading;
    await settle();
    expect(sheet?.childNodes).toHaveLength(0);
    expect(state.config.recentFiles).toEqual([]);
  });

  it("test_dispose_removes_listeners", async () => {
    const { root, shell, state } = await open({ "/n/a.md": "a" }, ["/n/a.md"]);
    shell.dispose();
    root.ownerDocument.dispatchEvent(key({ key: "w", ctrlKey: true }));
    state.emitOpenFiles(["/n/a.md", "/n/b.md"]);
    await settle();
    expect(root.querySelectorAll(".tab")).toHaveLength(1);
  });

  it("test_shortcut_modifiers_must_match", () => {
    expect(matchesKey("Ctrl+O", key({ key: "o", ctrlKey: true }))).toBe(true);
    expect(matchesKey("Ctrl+O", key({ key: "O", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchesKey("Ctrl+O", key({ key: "o", ctrlKey: true, altKey: true }))).toBe(false);
    expect(matchesKey("Ctrl+O", key({ key: "o" }))).toBe(false);
    expect(matchesKey("Alt+ArrowLeft", key({ key: "ArrowLeft", altKey: true }))).toBe(true);
  });
});

describe("file menu", () => {
  it("test_tab_shows_path_and_offers_reveal_and_copy", async () => {
    const { root, state } = await open({ "/d/a.md": "# A" }, ["/d/a.md"]);
    // The file name is on the tab only, with its path as the tooltip.
    expect(root.querySelector(".bar .title")).toBeNull();
    const label = root.querySelector<HTMLElement>(".tab-label");
    expect(label?.title).toBe("/d/a.md");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const menu = root.querySelector<HTMLElement>(".file-menu");
    const rightClick = (el: Element | null) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el?.dispatchEvent(e);
      return e;
    };
    // ▾ right of the name opens it.
    const button = root.querySelector(".tab .tab-menu");
    expect(button?.previousElementSibling).toBe(label);
    click(button);
    expect(menu?.hidden).toBe(false);
    const items = [...(menu?.querySelectorAll(".menu-item") ?? [])];
    expect(items.map((i) => i.textContent)).toEqual([
      strings.fileMenu.revealLinux,
      strings.fileMenu.copyPath,
    ]);
    click(items[0] ?? null);
    await settle();
    expect(state.revealed).toEqual(["/d/a.md"]);
    expect(menu?.hidden).toBe(true);

    // Right-clicking the tab's name offers the same menu, for that tab's file.
    // Anywhere on the tab, its buttons included.
    expect(rightClick(root.querySelector(".tab-close")).defaultPrevented).toBe(true);
    expect(menu?.hidden).toBe(false);
    click(items[1] ?? null);
    await settle();
    expect(writeText).toHaveBeenCalledWith("/d/a.md");
  });

  it("test_browser_menu_stays_only_for_paste_and_copy", async () => {
    const { root } = await open({ "/d/a.md": "Some text\n\n[A link](b.md)" }, ["/d/a.md"]);
    const browserMenu = (el: Element | null | undefined) =>
      el?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const text = root.querySelector(".sheet p");
    const link = root.querySelector(".sheet a");

    expect(browserMenu(text)).toBe(false);
    expect(browserMenu(link)).toBe(false);
    expect(browserMenu(root.querySelector(".bar"))).toBe(false);
    expect(browserMenu(root.querySelector(".find-input"))).toBe(true);

    document.getSelection()?.selectAllChildren(text as Element);
    expect(browserMenu(text)).toBe(true);
    // Elsewhere the selection is not what was clicked.
    expect(browserMenu(root.querySelector(".bar"))).toBe(false);
    // A link's items would open it inside the window.
    document.getSelection()?.selectAllChildren(link as Element);
    expect(browserMenu(link)).toBe(false);
    document.getSelection()?.removeAllRanges();
  });
});

describe("title bar", () => {
  it("test_title_bar_drags_and_has_window_controls", async () => {
    const fake = fakeBackend({});
    const calls: string[] = [];
    fake.backend.window = {
      minimize: async () => void calls.push("minimize"),
      toggleMaximize: async () => void calls.push("maximize"),
      close: async () => void calls.push("close"),
      startDragging: async () => void calls.push("drag"),
      isMaximized: async () => calls.includes("maximize"),
      onResized: async (handler) => {
        resized = handler;
        return () => {};
      },
    };
    let resized = () => {};
    const root = document.createElement("div");
    const shell = new Shell(root, fake.backend);
    shells.push(shell);
    const bar = root.querySelector(".titlebar");
    // The app's mark and name, then the tabs.
    expect(bar?.firstElementChild?.className).toBe("brand");
    expect(bar?.firstElementChild?.textContent).toBe(strings.appName);
    expect(bar?.querySelector(".tabs")).not.toBeNull();
    // Elsewhere the system's drag region; on Linux a press alone does not move the window,
    // or GTK keeps it grabbed, while moving does.
    expect(root.querySelector(".titlebar .drag")?.hasAttribute("data-tauri-drag-region")).toBe(
      true,
    );
    await settle();
    const first = resized;
    const linux = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const root2 = document.createElement("div");
    shells.push(new Shell(root2, fake.backend));
    linux.mockRestore();
    const drag = root2.querySelector(".titlebar .drag") as HTMLElement;
    expect(drag.hasAttribute("data-tauri-drag-region")).toBe(false);
    const mouse = (type: string, x: number, init: MouseEventInit = {}) =>
      (type === "mousedown" ? drag : window).dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX: x, clientY: 5, buttons: 1, ...init }),
      );
    mouse("mousedown", 10);
    mouse("mouseup", 10);
    mouse("mousemove", 40);
    await settle();
    expect(calls).toEqual([]);
    mouse("mousedown", 10);
    mouse("mousemove", 40);
    await settle();
    expect(calls).toEqual(["drag"]);
    mouse("mousedown", 10, { detail: 2 });
    await settle();
    expect(calls).toEqual(["drag", "maximize"]);
    calls.length = 0;
    const buttons = [...root.querySelectorAll<HTMLElement>(".window-controls button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Minimize",
      "Maximize",
      "Close",
    ]);
    for (const b of buttons) click(b);
    expect(calls).toEqual(["minimize", "maximize", "close"]);
    // Maximize reads Restore once the window is maximized.
    first();
    await settle();
    expect(buttons[1]?.getAttribute("aria-label")).toBe(strings.windowControls.restore);
    // A menu closes when the title bar is pressed, since dragging swallows the click.
    const more = root.querySelector<HTMLElement>(".bar .menu-button");
    click(more);
    root
      .querySelector(".titlebar .drag")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(root.querySelector<HTMLElement>(".bar .menu")?.hidden).toBe(true);
  });

  it("test_title_bar_without_controls_when_system_draws_them", async () => {
    const fake = fakeBackend({});
    const never = async () => {};
    fake.backend.window = {
      minimize: never,
      toggleMaximize: never,
      close: never,
      startDragging: never,
      isMaximized: async () => false,
      onResized: async () => () => {},
    };
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      const root = document.createElement("div");
      shells.push(new Shell(root, fake.backend));
      // macOS draws its own buttons over the strip, which leaves room for them.
      expect(root.querySelector(".titlebar.mac")).not.toBeNull();
      expect(root.querySelector(".window-controls")).toBeNull();
    } finally {
      platform.mockRestore();
    }
  });
});

describe("view source", () => {
  it("test_view_source_shows_markdown_and_back", async () => {
    const { root } = await open({ "/d/a.md": "# A\n\n*b*" }, ["/d/a.md"]);
    const sheet = root.querySelector<HTMLElement>("article.sheet");
    const source = root.querySelector<HTMLElement>("pre.source");
    expect(source?.hidden).toBe(true);
    document.dispatchEvent(key({ key: "u", ctrlKey: true, bubbles: true }));
    expect(source?.hidden).toBe(false);
    expect(sheet?.hidden).toBe(true);
    expect(source?.textContent).toBe("# A\n\n*b*");
    const item = root.querySelector('.menu-item[data-action="viewSource"]');
    expect(item?.getAttribute("aria-checked")).toBe("true");
    // The outline lists rendered headings, so it is off while the source shows.
    expect(root.querySelector<HTMLButtonElement>('.bar [data-action="outline"]')?.disabled).toBe(
      true,
    );
    click(item);
    expect(source?.hidden).toBe(true);
    expect(sheet?.hidden).toBe(false);
    expect(item?.getAttribute("aria-checked")).toBe("false");
  });

  it("test_outline_hidden_on_a_tab_showing_source", async () => {
    const { root } = await open({ "/d/a.md": "# A", "/d/b.md": "# B" }, ["/d/a.md", "/d/b.md"]);
    const panel = root.querySelector<HTMLElement>(".outline");
    const press = (init: KeyboardEventInit) =>
      document.dispatchEvent(key({ bubbles: true, ...init }));
    press({ key: "u", ctrlKey: true }); // b.md shows its source
    press({ key: "Tab", ctrlKey: true }); // a.md
    press({ key: "b", ctrlKey: true }); // outline open on a.md
    expect(panel?.hidden).toBe(false);
    press({ key: "Tab", ctrlKey: true }); // back to b.md's source
    expect(panel?.hidden).toBe(true);
  });

  it("test_failed_navigation_clears_source", async () => {
    const { root } = await open({ "/d/a.md": "[gone](gone.md)" }, ["/d/a.md"]);
    click(root.querySelector(".sheet a"));
    await settle();
    await settle();
    expect(root.querySelector(".doc-error")).not.toBeNull();
    document.dispatchEvent(key({ key: "u", ctrlKey: true, bubbles: true }));
    expect(root.querySelector("pre.source")?.textContent).toBe("");
  });
});

describe("remote images setting", () => {
  it("test_remote_images_toggle_rerenders_off_and_reloads_on", async () => {
    const fake = fakeBackend({ "/n/a.md": "![r](https://example.com/a.png)" }, ["/n/a.md"]);
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    let reloads = 0;
    const shell = new Shell(root, fake.backend, () => reloads++);
    shells.push(shell);
    await shell.start();
    const img = () => root.querySelector(".sheet img");
    expect(img()?.getAttribute("src")).toBe("https://example.com/a.png");

    await shell.setRemoteImages(false);
    const meta = document.head.querySelector('meta[data-remote-images="off"]');
    try {
      expect(fake.state.config.remoteImages).toBe(false);
      expect(meta).not.toBeNull();
      expect(img()?.getAttribute("src")).toBeNull();
      expect(img()?.getAttribute("data-remote-src")).toBe("https://example.com/a.png");
      expect(reloads).toBe(0);

      await shell.setRemoteImages(true);
      expect(fake.state.config.remoteImages).toBe(true);
      expect(reloads).toBe(1);
    } finally {
      meta?.remove();
    }
  });

  it("test_remote_images_setting_not_saved_changes_nothing", async () => {
    const { root, shell, state } = await open({ "/n/a.md": "# A" }, ["/n/a.md"], (s) => {
      s.fail.setConfig = { kind: "io", message: "disk full" };
    });
    await shell.setRemoteImages(false);
    expect(state.config.remoteImages).toBe(true);
    expect(document.head.querySelector('meta[data-remote-images="off"]')).toBeNull();
    expect(notice(root)).toBe(strings.notices.settingNotSaved);
  });
});

describe("update item", () => {
  it("test_update_item_appears_only_when_available", async () => {
    const { root, state } = await open({ "/n/a.md": "# A" }, ["/n/a.md"]);
    // The check runs once the window is drawn (D-31), and finds nothing yet.
    expect(state.updateChecks).toBe(1);
    const item = () => root.querySelector<HTMLElement>('.menu [data-action="update"]');
    expect(item()).toBeNull();

    state.emitUpdateAvailable({ version: "0.1.1" });
    expect(item()?.textContent).toBe(strings.restartToUpdate("0.1.1"));
    click(item());
    await settle();
    expect(state.installs).toBe(1);

    // A failed install is a notice; the running version keeps working.
    state.fail.installUpdate = { kind: "io", message: "bad signature" };
    click(item());
    await settle();
    expect(notice(root)).toBe(strings.notices.updateFailed);
    // A second event updates the item rather than adding one.
    state.emitUpdateAvailable({ version: "0.1.2" });
    expect(root.querySelectorAll('.menu [data-action="update"]')).toHaveLength(1);
    expect(item()?.textContent).toBe(strings.restartToUpdate("0.1.2"));
  });
});
