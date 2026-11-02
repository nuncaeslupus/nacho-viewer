import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "../render/pipeline";
import { sanitize } from "../render/sanitize";
import { strings } from "../strings";
import { fakeBackend, gate, settle } from "./fake-backend";
import {
  findTarget,
  type Gesture,
  History,
  type LinkAction,
  markForPdf,
  resolvePath,
  route,
} from "./links";
import { Shell } from "./shell";

const shells: Shell[] = [];
const scrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  for (const shell of shells.splice(0)) shell.dispose();
  Element.prototype.scrollIntoView = scrollIntoView;
});

/** The first link that `markdown` renders to, after sanitising, as the shell sees it. */
function link(markdown: string): Element {
  const sheet = document.createElement("article");
  sheet.innerHTML = sanitize(render(markdown));
  const a = sheet.querySelector("a[href]");
  if (!a) throw new Error(`no link in ${markdown}`);
  return a;
}

const entry = (path: string, fragment = "", alternates?: string[]) => ({
  path,
  fragment,
  scroll: 0,
  ...(alternates ? { alternates } : {}),
});

async function open(files: Record<string, string>, launch: string[]) {
  const fake = fakeBackend(files, launch);
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const shell = new Shell(root, fake.backend);
  shells.push(shell);
  await shell.start();
  return { root, shell, ...fake };
}

function press(el: Element | null, init: MouseEventInit = {}, type = "click"): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  el?.dispatchEvent(e);
  return e;
}

const backButton = (root: Element) =>
  root.querySelector<HTMLButtonElement>('.bar-button[data-action="back"]');
const forwardButton = (root: Element) =>
  root.querySelector<HTMLButtonElement>('.bar-button[data-action="forward"]');

describe("links", () => {
  it("test_link_routing_table_all_cases", () => {
    const from = "/n/docs/a.md";
    const cases: [string, Gesture, LinkAction][] = [
      ["[x](https://a.org/p)", "click", { type: "external", url: "https://a.org/p" }],
      ["[x](https://a.org/p)", "newTab", { type: "external", url: "https://a.org/p" }],
      ["[x](mailto:me@a.org)", "click", { type: "external", url: "mailto:me@a.org" }],
      ["[x](#goal)", "click", { type: "scroll", fragment: "goal" }],
      ["[x](#goal)", "newTab", { type: "scroll", fragment: "goal" }],
      ["[x](b.md)", "click", { type: "navigate", entry: entry("/n/docs/b.md") }],
      ["[x](b.md)", "newTab", { type: "newTab", entry: entry("/n/docs/b.md") }],
      [
        "[x](./sub/b.md#part)",
        "click",
        { type: "navigate", entry: entry("/n/docs/sub/b.md", "part") },
      ],
      ["[x](../B%20c.markdown)", "click", { type: "navigate", entry: entry("/n/B c.markdown") }],
      ["[x](/abs/c.md?raw=1)", "newTab", { type: "newTab", entry: entry("/abs/c.md") }],
      ["[x](a.md#goal)", "click", { type: "scroll", fragment: "goal" }],
      ["[x](a.md#goal)", "newTab", { type: "newTab", entry: entry(from, "goal") }],
      ["[[Page]]", "click", { type: "navigate", entry: entry("/n/docs/Page.md") }],
      [
        "[[Page#Intro|see]]",
        "newTab",
        { type: "newTab", entry: entry("/n/docs/Page.md", "Intro") },
      ],
      [
        "[[My Page]]",
        "click",
        { type: "navigate", entry: entry("/n/docs/My Page.md", "", ["/n/docs/My-Page.md"]) },
      ],
      ["[x](notes.txt)", "click", { type: "unsupported" }],
      ["[x](pic.png)", "newTab", { type: "unsupported" }],
    ];
    const failed = cases.filter(([md, gesture, want]) => {
      const got = route(link(md), from, gesture);
      return JSON.stringify(got) !== JSON.stringify(want);
    });
    expect(failed).toEqual([]);
    expect(resolvePath("/n/a.md", "../../x.md")).toBe("/x.md");
  });

  it("test_history_back_after_two_links_returns_first", async () => {
    const files = {
      "/n/a.md": "# A\n\n[to b](b.md)",
      "/n/b.md": "# B\n\n[to c](c.md)",
      "/n/c.md": "# C",
    };
    const { root } = await open(files, ["/n/a.md"]);
    const heading = () => root.querySelector(".sheet h1")?.textContent;
    expect(backButton(root)?.disabled).toBe(true);

    press(root.querySelector(".sheet a:not(.anchor)"));
    await settle();
    press(root.querySelector(".sheet a:not(.anchor)"));
    await settle();
    expect(heading()).toBe("C");
    expect(root.querySelectorAll(".tab")).toHaveLength(1);
    expect(root.querySelector(".tab-label")?.textContent).toBe("c.md");

    press(backButton(root));
    await settle();
    expect(heading()).toBe("B");
    root.ownerDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }),
    );
    await settle();
    expect(heading()).toBe("A");
    expect(backButton(root)?.disabled).toBe(true);
    expect(forwardButton(root)?.disabled).toBe(false);

    root.ownerDocument.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true }),
    );
    await settle();
    expect(heading()).toBe("B");
    // A new link drops the forward entries.
    press(root.querySelector(".sheet a:not(.anchor)"));
    await settle();
    expect(heading()).toBe("C");
    expect(forwardButton(root)?.disabled).toBe(true);
  });

  it("test_back_restores_scroll_offset", async () => {
    const files = { "/n/a.md": "# A\n\n[to b](b.md)", "/n/b.md": "# B" };
    const { root } = await open(files, ["/n/a.md"]);
    const canvas = () => root.querySelector<HTMLElement>(".canvas:not([hidden])");
    const a = canvas();
    if (a) a.scrollTop = 120;
    press(root.querySelector(".sheet a:not(.anchor)"));
    await settle();
    expect(canvas()?.scrollTop).toBe(0);
    press(backButton(root));
    await settle();
    expect(canvas()?.scrollTop).toBe(120);
  });

  it("test_ctrl_and_middle_click_open_new_tab", async () => {
    const md = "[b](b.md) [c](c.md#end)";
    const files = {
      "/n/a.md": md,
      "/n/b.md": "# B",
      "/n/c.md": '# C\n\n<p id="user-content-end">e</p>',
    };
    const { root } = await open(files, ["/n/a.md"]);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const [b, c] = root.querySelectorAll(".sheet a:not(.anchor)");

    expect(press(b, { ctrlKey: true }).defaultPrevented).toBe(true);
    await settle();
    expect(root.querySelectorAll(".tab")).toHaveLength(2);
    expect(root.querySelector(".tab.active .tab-label")?.textContent).toBe("b.md");

    expect(press(c, { button: 1 }, "auxclick").defaultPrevented).toBe(false);
    // The middle click lands on the first tab's link, which is hidden now: switch back.
    press(root.querySelector(".tab-label"));
    expect(press(c, { button: 1 }, "auxclick").defaultPrevented).toBe(true);
    await settle();
    expect(root.querySelectorAll(".tab")).toHaveLength(3);
    expect(root.querySelector(".tab.active .tab-label")?.textContent).toBe("c.md");
    expect((scroll.mock.contexts.at(-1) as Element).id).toBe("user-content-end");
    // The first tab did not move.
    expect(root.querySelector(".tab .tab-label")?.textContent).toBe("a.md");
  });

  it("test_missing_targets_show_in_sheet_not_dialog", async () => {
    const md = "[gone](gone.md) [nowhere](#nowhere) [txt](notes.txt) [[Wiki Page]]";
    const files = { "/n/a.md": md, "/n/Wiki-Page.md": "# Wiki" };
    const { root } = await open(files, ["/n/a.md"]);
    Element.prototype.scrollIntoView = vi.fn();
    const notice = () => root.querySelector(".bar .notice")?.textContent;
    const links = () => root.querySelectorAll(".sheet a:not(.anchor)");

    press(links()[1]);
    expect(notice()).toBe(strings.notices.sectionNotFound);
    press(links()[2]);
    expect(notice()).toBe(strings.notices.notMarkdown);

    press(links()[3]);
    await settle();
    expect(root.querySelector(".sheet h1")?.textContent).toBe("Wiki");
    expect(root.querySelector(".tab-label")?.textContent).toBe("Wiki-Page.md");
    press(backButton(root));
    await settle();

    press(links()[0]);
    await settle();
    const error = root.querySelector(".sheet .doc-error");
    expect(error?.textContent).toContain(strings.documentError);
    expect(error?.textContent).toContain("/n/gone.md: not found");
    expect(backButton(root)?.disabled).toBe(false);
  });

  it("test_find_target_accepts_user_content_prefix", () => {
    const sheet = document.createElement("div");
    sheet.innerHTML = '<h2 id="user-content-intro">i</h2><a name="old">o</a><p id="a b">s</p>';
    expect(findTarget(sheet, "intro")?.id).toBe("user-content-intro");
    expect(findTarget(sheet, "user-content-intro")?.id).toBe("user-content-intro");
    expect(findTarget(sheet, "old")?.textContent).toBe("o");
    expect(findTarget(sheet, "a%20b")?.textContent).toBe("s");
    expect(findTarget(sheet, "missing")).toBeNull();
  });

  it("test_find_target_falls_back_to_github_slug", () => {
    const sheet = document.createElement("div");
    sheet.innerHTML = '<h2 id="user-content-my-section-2">m</h2><h3 id="über-uns">u</h3>';
    expect(findTarget(sheet, "My%20Section%202!")?.textContent).toBe("m");
    expect(findTarget(sheet, "My Section 2")?.textContent).toBe("m");
    expect(findTarget(sheet, "Über Uns")?.textContent).toBe("u");
    expect(findTarget(sheet, "Other Section")).toBeNull();
  });

  it("test_back_restores_scroll_not_fragment", async () => {
    const files = { "/n/a.md": "[b](b.md#end)", "/n/b.md": '[c](c.md)\n\n<p id="end">e</p>' };
    const { root } = await open(files, ["/n/a.md"]);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const canvas = () => root.querySelector<HTMLElement>(".canvas:not([hidden])");

    press(root.querySelector(".sheet a:not(.anchor)"));
    await settle();
    expect(scroll).toHaveBeenCalledTimes(1);
    const b = canvas();
    if (b) b.scrollTop = 300;
    press(root.querySelector(".sheet a:not(.anchor)"));
    await settle();
    press(backButton(root));
    await settle();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(canvas()?.scrollTop).toBe(300);
  });

  it("test_new_tab_link_to_open_file_lands_after_its_load", async () => {
    const md = "[b](b.md#end)";
    const files = { "/n/a.md": md, "/n/b.md": '# B\n\n<p id="end">e</p>' };
    const { root, shell, state } = await open(files, ["/n/a.md"]);
    const pending = gate();
    state.readGate = pending.promise;
    const loading = shell.openPaths(["/n/b.md"]);
    press(root.querySelector(".tab-label"));
    const activeOnScroll: (string | null | undefined)[] = [];
    Element.prototype.scrollIntoView = () => {
      activeOnScroll.push(root.querySelector(".tab.active .tab-label")?.textContent);
    };

    press(root.querySelector(".canvas:not([hidden]) .sheet a:not(.anchor)"), { ctrlKey: true });
    await settle();
    expect(root.querySelector(".bar .notice")?.textContent).toBe("");
    expect(activeOnScroll).toEqual([]);
    pending.open();
    await loading;
    await settle();
    expect(activeOnScroll).toEqual(["b.md"]);
    expect(root.querySelector(".bar .notice")?.textContent).toBe("");
    expect(root.querySelectorAll(".tab")).toHaveLength(2);
  });

  it("test_history_push_drops_forward_entries", () => {
    const history = new History(entry("/a.md"));
    history.push(entry("/b.md"));
    history.push(entry("/c.md"));
    expect(history.back()?.path).toBe("/b.md");
    history.push(entry("/d.md"));
    expect(history.canGoForward).toBe(false);
    expect(history.back()?.path).toBe("/b.md");
    expect(history.back()?.path).toBe("/a.md");
    expect(history.back()).toBeNull();
  });
});

describe("markForPdf", () => {
  const sheet = (html: string) => {
    const el = document.createElement("article");
    el.innerHTML = html;
    return el;
  };

  it("test_marks_give_each_link_its_action", () => {
    const el = sheet(`
      <a href="https://a.example" data-external>out</a>
      <a href="#there">in</a>
      <a href="#gone">broken</a>
      <a href="other.md">file</a>
      <h2 id="there">There</h2>`);
    const { marks } = markForPdf(el);
    expect(marks).toEqual([{ uri: "https://a.example" }, { to: 2 }, {}]);
    expect(el.querySelector("h2")?.style.backgroundColor).toBe("rgba(1, 0, 2, 0.004)");
  });

  it("test_marks_share_one_for_a_link_that_is_also_a_target", () => {
    const { marks } = markForPdf(sheet(`<a id="a" href="#b">1</a><a id="b" href="#a">2</a>`));
    expect(marks).toEqual([{ to: 1 }, { to: 0 }]);
  });

  it("test_marks_clear_leaves_the_page_as_it_was", () => {
    const el = sheet(`<a href="#x">in</a><p id="x">x</p>`);
    markForPdf(el).clear();
    expect(el.querySelector("a")?.getAttribute("style")).toBe("");
    expect(el.querySelector("p")?.style.backgroundColor).toBe("");
  });
});
