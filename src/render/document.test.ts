import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import { expect, test, vi } from "vitest";
import fixture from "../../docs/fixtures/all-features.md?raw";
import { bigDocument } from "../../e2e/big";
import { strings } from "../strings";
import { renderDocument } from "./document";
import { enhance } from "./enhance";
import { linearFootnoteTail } from "./extras";
import { MAX_CHUNK_FACTOR, render, renderChunks } from "./pipeline";
import { sanitize } from "./sanitize";

test("test_chunks_join_to_the_whole_render", () => {
  for (const source of [fixture, bigDocument(200_000, 3), ""]) {
    const chunks = renderChunks(source, 2_000);
    expect(chunks.join("")).toBe(render(source));
    if (source.length > 100_000) expect(chunks.length).toBeGreaterThan(50);
  }
});

test("test_chunks_keep_raw_html_elements_whole", () => {
  const long = "Some words to fill the piece. ".repeat(20);
  const source = `<details>\n<summary>More</summary>\n\n${long}\n\n${long}\n\n</details>\n\n${long}\n`;
  const chunks = renderChunks(source, 1_000);
  expect(chunks[0]).toMatch(/^<details>[\s\S]*<\/details>\n$/);
  expect(chunks.join("")).toBe(render(source));
});

test("test_chunks_not_stopped_by_unclosed_or_commented_html", () => {
  const body = bigDocument(100_000);
  for (const head of [
    '<p align="center">\n<img src="logo.png" alt="logo">\n',
    "<!-- <div> left open in a comment -->\n",
    "<details><summary>Closed</summary>\n\nText\n\n</details>\n",
    "<br>\n<hr/>\n",
  ]) {
    const source = `${head}\n${body}`;
    const chunks = renderChunks(source, 2_000);
    expect(chunks.length, head).toBeGreaterThan(30);
    expect(chunks.join("")).toBe(render(source));
  }
});

test("test_chunks_capped_when_raw_html_never_closes", () => {
  const source = `<div align="center">\n\n${bigDocument(100_000)}`;
  const chunks = renderChunks(source, 2_000);
  expect(chunks.length).toBeGreaterThan(3);
  expect(Math.max(...chunks.slice(0, -1).map((c) => c.length))).toBeLessThan(
    2_000 * MAX_CHUNK_FACTOR + 4_000,
  );
  expect(chunks.join("")).toBe(render(source));
});

test("test_large_render_applies_image_policy", async () => {
  const root = document.createElement("article");
  const source = `${bigDocument(100_000)}\n\n![late](late.png)\n`;
  const seen: string[] = [];
  const rendered = await renderDocument(root, source, {
    images: (img) => {
      seen.push(img.getAttribute("src") ?? "");
      img.setAttribute("src", "asset://late.png");
    },
  });
  await rendered.settled;
  expect(seen).toEqual(["late.png"]);
  expect(root.querySelector("img")?.getAttribute("src")).toBe("asset://late.png");
});

test("test_footnote_tail_unchanged_by_linear_rewrite", () => {
  const source =
    "One[^a], two[^b], again[^a] and inline^[an inline note].\n\n" +
    "[^a]: First, with\n\n    a second paragraph.\n\nMiddle text.\n\n[^b]: Second.\n\n[^unused]: Never cited.\n";
  const plain = new MarkdownIt().use(footnote);
  const linear = new MarkdownIt().use(footnote).use(linearFootnoteTail);
  expect(linear.render(source)).toBe(plain.render(source));
  expect(linear.render("No notes.")).toBe(plain.render("No notes."));
});

test("test_large_render_matches_the_whole", async () => {
  const source = bigDocument(150_000);
  const whole = document.createElement("article");
  whole.innerHTML = sanitize(render(source));
  const expected = enhance(whole).outline;

  const root = document.createElement("article");
  document.body.append(root);
  const rendered = await renderDocument(root, source);
  expect(root.querySelector(".chunk")).not.toBeNull();
  await rendered.settled;
  // Plain boxes are left around the pieces, nothing else differs.
  expect(root.querySelector(":scope > :is(.chunk, [style])")).toBeNull();
  expect([...root.children].map((box) => box.innerHTML).join("")).toBe(whole.innerHTML);
  expect(rendered.outline).toEqual(expected);
  root.remove();
});

test("test_superseded_render_leaves_the_root", async () => {
  const root = document.createElement("article");
  const first = renderDocument(root, bigDocument(150_000));
  await renderDocument(root, "# Second\n");
  await first;
  expect(root.querySelectorAll("h1")).toHaveLength(1);
  expect(root.textContent).toContain("Second");

  let current = true;
  const stale = renderDocument(root, bigDocument(150_000), { current: () => current });
  current = false;
  await stale;
  expect(root.textContent).toContain("Second");
});

test("test_worker_that_never_answers_fails_after_timeout_without_parsing_on_the_ui_thread", async () => {
  const terminate = vi.fn();
  vi.stubGlobal(
    "Worker",
    class {
      onmessage = null;
      onerror = null;
      postMessage() {}
      terminate = terminate;
    },
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const root = document.createElement("article");
    const pending = renderDocument(root, bigDocument(100_000));
    const outcome = expect(pending).rejects.toThrow(strings.renderTimedOut);
    await Promise.resolve();
    expect(root.childElementCount).toBe(0);
    vi.advanceTimersByTime(10_000);
    await outcome;
    expect(terminate).toHaveBeenCalled();
    expect(root.childElementCount).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
