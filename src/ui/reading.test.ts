import { afterEach, describe, expect, it } from "vitest";
import { strings } from "../strings";
import { matchesKey } from "./definition";
import { fakeBackend, settle } from "./fake-backend";
import { clearMatches, highlightMatches } from "./find";
import { Shell } from "./shell";
import { sheetLayout, stepZoom } from "./zoom";

const shells: Shell[] = [];
afterEach(() => {
  for (const shell of shells.splice(0)) shell.dispose();
});

async function open(files: Record<string, string>, launch: string[]) {
  const fake = fakeBackend(files, launch);
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const shell = new Shell(root, fake.backend);
  shells.push(shell);
  await shell.start();
  return { root, ...fake };
}

const press = (init: KeyboardEventInit) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
const click = (el: Element | null) => (el as HTMLElement | null)?.click();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Gives an element the layout jsdom does not compute. */
const layout = (el: Element, props: Record<string, number>) => {
  for (const [name, value] of Object.entries(props)) {
    Object.defineProperty(el, name, { configurable: true, value });
  }
};

describe("reading tools", () => {
  it("test_outline_lists_headings_and_follows_reload", async () => {
    const { root, state } = await open({ "/n/a.md": "# One\n\n## Two\n\ntext" }, ["/n/a.md"]);
    const panel = root.querySelector<HTMLElement>(".outline");
    expect(panel?.hidden).toBe(true);

    press({ key: "b", ctrlKey: true });
    expect(panel?.hidden).toBe(false);
    const items = () => [...(panel?.querySelectorAll<HTMLElement>(".outline-item") ?? [])];
    expect(items().map((i) => i.textContent)).toEqual(["One", "Two"]);
    expect(items()[1].style.getPropertyValue("--depth")).toBe("1");
    expect(panel?.querySelectorAll("[aria-current=location]")).toHaveLength(1);

    // Clicking scrolls to the heading and marks it current.
    let scrolled: Element | undefined;
    const heading = root.querySelector(".sheet h2") as HTMLElement;
    heading.scrollIntoView = function (this: Element) {
      scrolled = this;
    };
    click(items()[1]);
    expect(scrolled).toBe(heading);
    expect(items()[1].getAttribute("aria-current")).toBe("location");

    // A live reload rebuilds the outline.
    state.write("/n/a.md", "# One\n\n## Two\n\n## Three");
    await settle();
    await settle();
    expect(items().map((i) => i.textContent)).toEqual(["One", "Two", "Three"]);

    click(root.querySelector(".bar [data-action=outline]"));
    expect(panel?.hidden).toBe(true);
  });

  it("test_outline_click_stays_current_until_reader_scrolls", async () => {
    const { root } = await open({ "/n/a.md": "# One\n\n## Two\n\n## Three" }, ["/n/a.md"]);
    press({ key: "b", ctrlKey: true });
    const items = [...root.querySelectorAll<HTMLElement>(".outline-item")];
    const canvas = root.querySelector(".canvas") as HTMLElement;
    // Scrolled to the bottom, where the last section counts as current.
    layout(canvas, { scrollTop: 400, clientHeight: 600, scrollHeight: 1000 });

    click(items[0]);
    canvas.dispatchEvent(new Event("scroll"));
    expect(items[0].getAttribute("aria-current")).toBe("location");

    canvas.dispatchEvent(new Event("wheel"));
    canvas.dispatchEvent(new Event("scroll"));
    expect(items[2].getAttribute("aria-current")).toBe("location");
    expect(items[0].hasAttribute("aria-current")).toBe(false);
  });

  it("test_zoom_keys_step_and_persist_default_zoom", async () => {
    const { root, state } = await open({ "/n/a.md": "# A" }, ["/n/a.md"]);
    const readout = () => root.querySelector(".bar .zoom")?.textContent;
    const scale = () => root.querySelector<HTMLElement>(".view")?.style.getPropertyValue("--zoom");

    press({ key: "=", ctrlKey: true });
    expect(readout()).toBe(strings.zoomPercent(110));
    expect(scale()).toBe("1.1");
    press({ key: "+", ctrlKey: true, shiftKey: true });
    expect(readout()).toBe(strings.zoomPercent(125));
    // The zoom last used becomes the default once the keys settle, in one write.
    await settle();
    expect(state.config.defaultZoom).toBe(100);
    await wait(600);
    expect(state.config.defaultZoom).toBe(125);

    for (let i = 0; i < 3; i++) press({ key: "-", ctrlKey: true });
    expect(readout()).toBe(strings.zoomPercent(90));
    press({ key: "0", ctrlKey: true });
    expect(readout()).toBe(strings.zoomPercent(100));

    expect(stepZoom(300, 1)).toBe(300);
    expect(stepZoom(50, -1)).toBe(50);
    expect(stepZoom(133, -1)).toBe(125);
    // A book page while the window has room; the canvas width, less its margins, when wide.
    // The column is the same at every zoom — zoom grows the font, the text reflows inside it.
    expect(sheetLayout(2000, false)).toEqual({ maxWidth: 816, padScale: 1 });
    expect(sheetLayout(1000, false)).toEqual({ maxWidth: 816, padScale: 1 });
    expect(sheetLayout(2000, true)).toEqual({ maxWidth: 1952, padScale: 1 });
    // A window narrower than a book page: the sheet fills it and its padding shrinks.
    expect(sheetLayout(300, false)).toEqual({ maxWidth: 252, padScale: 252 / 816 });
    expect(sheetLayout(0, false).maxWidth).toBe(160);
  });

  it("test_zoom_grows_font_and_ctrl_9_widens_sheet", async () => {
    const { root, state } = await open({ "/n/a.md": "# A" }, ["/n/a.md"]);
    const view = root.querySelector<HTMLElement>(".view");
    const max = () => view?.style.getPropertyValue("--sheet-max");
    const scale = () => view?.style.getPropertyValue("--zoom");
    layout(root.querySelector(".canvas") as Element, { clientWidth: 1000 });
    window.dispatchEvent(new Event("resize"));
    expect(max()).toBe("816px");
    // Zooming grows the font (the text reflows in the column); the column itself is unchanged.
    press({ key: "=", ctrlKey: true });
    press({ key: "=", ctrlKey: true });
    expect(root.querySelector(".bar .zoom")?.textContent).toBe(strings.zoomPercent(125));
    expect(scale()).toBe("1.25");
    expect(max()).toBe("816px");
    // The readout returns to 100%.
    root.querySelector<HTMLElement>(".bar .zoom")?.click();
    expect(scale()).toBe("1");
    expect(max()).toBe("816px");
    // Ctrl+9 (or the bar's toggle) gives the sheet the whole window, and is remembered.
    press({ key: "9", ctrlKey: true });
    expect(max()).toBe("952px");
    const toggle = root.querySelector('.bar [data-action="wideSheet"]');
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    // Filling the window, the toggle now offers the way back to a fixed column.
    expect(toggle?.getAttribute("aria-label")).toBe(strings.sheetFixed);
    await settle();
    expect(state.config.wideSheet).toBe(true);
    click(toggle);
    expect(max()).toBe("816px");
    expect(toggle?.getAttribute("aria-label")).toBe(strings.sheetFill);
  });

  it("test_remote_images_menu_toggles_setting", async () => {
    const fake = fakeBackend({});
    fake.state.config.remoteImages = true;
    const root = document.createElement("div");
    let reloads = 0;
    const shell = new Shell(root, fake.backend, () => reloads++);
    shells.push(shell);
    await shell.start();
    press({ key: ",", ctrlKey: true });
    const item = root.querySelector<HTMLElement>(".settings-dialog [data-action=remoteImages]");
    expect(item?.getAttribute("role")).toBe("checkbox");
    expect(item?.getAttribute("aria-checked")).toBe("true");

    click(item);
    await settle();
    await settle();
    expect(fake.state.config.remoteImages).toBe(false);
    expect(item?.getAttribute("aria-checked")).toBe("false");

    // Turning them back on reloads the window, as the narrowed CSP cannot be lifted.
    click(item);
    await settle();
    expect(fake.state.config.remoteImages).toBe(true);
    expect(reloads).toBe(1);
  });

  it("test_saved_zoom_and_theme_apply_at_start", async () => {
    const fake = fakeBackend({});
    fake.state.config.defaultZoom = 150;
    fake.state.config.theme = "dark";
    const root = document.createElement("div");
    const shell = new Shell(root, fake.backend);
    shells.push(shell);
    await shell.start();
    expect(root.querySelector(".bar .zoom")?.textContent).toBe(strings.zoomPercent(150));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("test_theme_cycles_and_persists", async () => {
    const { root, state } = await open({}, []);
    click(root.querySelector(".menu-item[data-action=settings]"));
    const item = (theme: string) =>
      root.querySelector<HTMLElement>(`.settings-dialog [data-theme=${theme}]`);
    expect(item("system")?.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.theme).toBeUndefined();

    click(item("light"));
    expect(item("light")?.getAttribute("aria-checked")).toBe("true");
    expect(item("system")?.getAttribute("aria-checked")).toBe("false");
    expect(document.documentElement.dataset.theme).toBe("light");
    press({ key: "Escape" });
    expect(root.querySelector(".settings-dialog")).toBeNull();
    press({ key: "L", ctrlKey: true, shiftKey: true });
    expect(document.documentElement.dataset.theme).toBe("dark");
    await settle();
    expect(state.config.theme).toBe("dark");
    press({ key: "L", ctrlKey: true, shiftKey: true });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    await settle();
    expect(state.config.theme).toBe("system");
  });

  it("test_style_is_picked_in_settings_and_persists", async () => {
    const { root, state } = await open({}, []);
    expect(document.documentElement.dataset.style).toBe("classic");
    press({ key: ",", ctrlKey: true });
    const item = (style: string) =>
      root.querySelector<HTMLElement>(`.settings-dialog [data-style=${style}]`);
    click(item("paper"));
    expect(document.documentElement.dataset.style).toBe("paper");
    expect(item("paper")?.getAttribute("aria-checked")).toBe("true");
    expect(item("classic")?.getAttribute("aria-checked")).toBe("false");
    await settle();
    expect(state.config.style).toBe("paper");
    press({ key: "Escape" });
  });

  it("test_find_marks_matches_and_survives_reload", async () => {
    const { root, state } = await open({ "/n/a.md": "# Cat\n\ncat and CAT, `cat`" }, ["/n/a.md"]);
    press({ key: "f", ctrlKey: true });
    const input = root.querySelector<HTMLInputElement>(".find-input");
    expect(document.activeElement).toBe(input);
    if (!input) return;
    input.value = "cat";
    input.dispatchEvent(new Event("input"));
    const count = () => root.querySelector(".find-count")?.textContent;
    // Typing is debounced.
    expect(root.querySelectorAll(".sheet mark.find-match")).toHaveLength(0);
    await wait(150);
    expect(root.querySelectorAll(".sheet mark.find-match")).toHaveLength(4);
    expect(count()).toBe(strings.findCount(1, 4));

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(count()).toBe(strings.findCount(2, 4));
    press({ key: "F3", shiftKey: true });
    press({ key: "F3", shiftKey: true });
    expect(count()).toBe(strings.findCount(4, 4));
    expect(root.querySelectorAll(".sheet mark.current")).toHaveLength(1);

    // A reload keeps the search; the heading text is untouched by the marks.
    state.write("/n/a.md", "# Cat\n\ncat");
    await settle();
    await settle();
    expect(root.querySelectorAll(".sheet mark.find-match")).toHaveLength(2);
    expect(count()).toBe(strings.findCount(2, 2));

    input.value = "dog";
    input.dispatchEvent(new Event("input"));
    await wait(150);
    expect(count()).toBe(strings.findNone);

    // Enter straight after typing runs the search, then moves on.
    input.value = "cat";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(count()).toBe(strings.findCount(2, 2));

    press({ key: "Escape" });
    expect(root.querySelector<HTMLElement>(".find")?.hidden).toBe(true);
    expect(root.querySelectorAll(".sheet mark.find-match")).toHaveLength(0);
    expect(root.querySelector(".sheet h1")?.textContent).toBe("Cat");
  });

  it("test_find_skips_controls_and_restores_text", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>a<b>ab</b>a</p><button>a</button><svg><text>a</text></svg>";
    const before = root.innerHTML;
    expect(highlightMatches(root, "A")).toEqual({ marks: expect.any(Array), more: false });
    expect(highlightMatches(root, "A").marks).toHaveLength(3);
    expect(highlightMatches(root, "ab").marks).toHaveLength(1);
    // A capped search says there is more.
    const capped = highlightMatches(root, "a", 2);
    expect(capped.marks).toHaveLength(2);
    expect(capped.more).toBe(true);
    expect(root.querySelectorAll("mark")).toHaveLength(2);
    expect(highlightMatches(root, "a", 3).more).toBe(false);
    clearMatches(root);
    expect(root.innerHTML).toBe(before);
    expect(highlightMatches(root, "").marks).toEqual([]);
  });

  it("test_find_ignores_accents_and_case", () => {
    const root = document.createElement("div");
    // Precomposed, decomposed (e + combining acute), and an emoji before the match.
    root.innerHTML = "<p>Canción, cancion, CANCIÓN, cance\u0301 😀camión</p>";
    const text = (q: string) => highlightMatches(root, q).marks.map((m) => m.textContent);
    expect(text("cancion")).toEqual(["Canción", "cancion", "CANCIÓN"]);
    expect(text("canción")).toEqual(["Canción", "cancion", "CANCIÓN"]);
    expect(text("cance")).toEqual(["cance\u0301"]);
    expect(text("camion")).toEqual(["camión"]);
    clearMatches(root);
    expect(root.textContent).toBe("Canción, cancion, CANCIÓN, cance\u0301 😀camión");
    // Final sigma matches its capital; Hangul syllables are never split; a mark outside the
    // BMP stays with its letter.
    root.innerHTML = "<p>ΛΌΓΟΣ λόγος 한국 a\u{1D167}b</p>";
    expect(text("λόγος")).toEqual(["ΛΌΓΟΣ", "λόγος"]);
    expect(text("하")).toEqual([]);
    expect(text("한")).toEqual(["한"]);
    expect(text("a")).toEqual(["a\u{1D167}"]);
  });

  it("test_ctrl_plus_matches_zoom_in", () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(matchesKey("Ctrl+=", key({ key: "+", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesKey("Ctrl+=", key({ key: "+" }))).toBe(false);
    expect(matchesKey("Shift+F3", key({ key: "F3" }))).toBe(false);
  });
});
