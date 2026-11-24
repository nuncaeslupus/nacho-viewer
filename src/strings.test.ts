import { describe, expect, it } from "vitest";
import { en } from "./locales/en";
import { LANGUAGES, LOCALES, resolveLanguage, strings } from "./strings";
import { actions } from "./ui/definition";
import { fakeBackend, settle } from "./ui/fake-backend";
import { Shell } from "./ui/shell";

function stringValues(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (typeof node === "object" && node !== null) return Object.values(node).flatMap(stringValues);
  return [];
}

/** Every piece of UI text in the window: text and labels, minus the user's own content. */
function uiText(el: Element, out: string[] = []): string[] {
  if (el.hasAttribute("data-user")) return out;
  // A rendered document is content; only the error box in a sheet is ours.
  if (el.parentElement?.classList.contains("sheet") && !el.classList.contains("doc-error")) {
    return out;
  }
  for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
    const value = el.getAttribute(attr);
    if (value) out.push(value);
  }
  for (const child of el.childNodes) {
    if (child instanceof Element) uiText(child, out);
    else if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      out.push(child.textContent.trim());
    }
  }
  return out;
}

describe("strings (D-14)", () => {
  it("test_strings_all_ui_text_from_strings_file", async () => {
    // The zoom readout is built by a function; at the default zoom it reads 100 %. Menu items
    // show their shortcut's key names, which the action definitions hold.
    const keys = Object.values(actions).map((a) => a.key);
    const allowed = new Set([
      ...stringValues(strings),
      ...Object.values(LANGUAGES),
      strings.zoomPercent(100),
      strings.recentRemove("old.md"),
      ...keys,
    ]);
    const { backend, state } = fakeBackend({ "/n/a.md": "# A\n\n[x](https://a.org)" });
    state.config.recentFiles = ["/n/old.md"];

    // The empty state with recent files.
    const empty = document.createElement("div");
    const emptyShell = new Shell(empty, backend);
    await emptyShell.start();
    expect(empty.querySelector(".recent")).not.toBeNull();

    // Two tabs, one that failed to load, with every menu open.
    const reading = document.createElement("div");
    const shell = new Shell(reading, backend);
    state.fail.setConfig = new Error("read-only");
    await shell.start();
    await shell.openPaths(["/n/a.md", "/n/missing.md"]);
    await settle();
    expect(reading.querySelector(".doc-error")).not.toBeNull();
    expect(reading.querySelector(".notice")?.textContent).toBe(strings.notices.recentFilesNotSaved);
    for (const menu of reading.querySelectorAll<HTMLElement>(".menu")) menu.hidden = false;
    expect(document.title).toBe(strings.windowTitle("missing.md"));

    const texts = [...uiText(empty), ...uiText(reading)];
    expect(texts.length).toBeGreaterThan(20);
    expect(texts.filter((t) => !allowed.has(t))).toEqual([]);
    emptyShell.dispose();
    shell.dispose();

    // No UI text is written into the code as a literal.
    const code: Record<string, string> = import.meta.glob(["./ui/*.ts", "!./ui/*.test.ts"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const literal = /(textContent|title|innerText|placeholder)\s*=\s*["'`]|aria-label",\s*["'`]/;
    expect(Object.keys(code).filter((f) => literal.test(code[f]))).toEqual([]);
  });

  it("test_strings_every_locale_has_every_string", () => {
    // Keys, nesting and which entries are functions (with the same arity) match English.
    const shape = (node: unknown): unknown =>
      typeof node === "function"
        ? `fn/${node.length}`
        : typeof node === "object" && node !== null
          ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, shape(v)]))
          : typeof node;
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(shape(locale), code).toEqual(shape(en));
      expect(locale.appName, code).toBe("Nacho Viewer");
    }
    // Every language but English is translated: most strings differ from English.
    const english = new Set(stringValues(en));
    for (const [code, locale] of Object.entries(LOCALES)) {
      if (code === "en") continue;
      const same = stringValues(locale).filter((v) => english.has(v));
      expect(same.length, code).toBeLessThan(stringValues(en).length / 5);
    }
  });

  it("test_strings_languages_listed_latin_alphabetically_first", () => {
    const names = Object.values(LANGUAGES);
    const latin = names.filter((n) => /^\p{Script=Latin}/u.test(n));
    expect(names.slice(0, latin.length)).toEqual(latin);
    expect(latin).toEqual([...latin].sort((a, b) => a.localeCompare(b)));
  });

  it("test_strings_language_follows_setting_then_system_then_english", () => {
    expect(resolveLanguage("es", ["de-DE"])).toBe("es");
    expect(resolveLanguage("auto", ["pt-BR", "en"])).toBe("pt");
    expect(resolveLanguage(null, ["zh-Hans-CN"])).toBe("zh");
    expect(resolveLanguage("auto", ["sv-SE", "fr-CA"])).toBe("fr");
    expect(resolveLanguage("auto", ["sv-SE"])).toBe("en");
    expect(resolveLanguage("xx", ["es"])).toBe("en");
    expect(resolveLanguage("constructor", [])).toBe("en");
    expect(resolveLanguage("auto", ["__proto__"])).toBe("en");
  });
});
