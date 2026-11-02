import { expect, type Page, test } from "@playwright/test";

const MERMAID = /mermaid/i;

/** Open the harness, recording every request URL, and render `source` (the fixture when
 * omitted). */
async function show(page: Page, source?: string): Promise<string[]> {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/e2e/harness.html");
  await page.evaluate((s) => window.harness.show(s ?? window.harness.fixture), source);
  await drawDiagrams(page);
  return requests;
}

/** Scroll every diagram near the view, as a reader would, so it is drawn (or fails). A fence
 * leaves `mermaid-pending` when its draw starts, so wait for the draw itself to end too. */
async function drawDiagrams(page: Page): Promise<void> {
  const pending = page.locator("#doc pre.mermaid-pending");
  for (let left = await pending.count(); left > 0; left = await pending.count()) {
    // A diagram drawn meanwhile leaves the page; the count below sees it.
    await pending
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await expect(pending).not.toHaveCount(left, { timeout: 10_000 });
  }
  const drawing = page.locator("#doc pre:not(.mermaid-error) > code.language-mermaid");
  await expect(drawing).toHaveCount(0, { timeout: 10_000 });
}

test("test_user_guide_draws_every_diagram", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/e2e/harness.html");
  await page.evaluate(() => window.harness.show(window.harness.guide));
  await drawDiagrams(page);
  await expect(page.locator("#doc .mermaid > svg")).toHaveCount(5);
  await expect(page.locator("#doc .mermaid-error")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("test_feature_fixture_all_constructs_rendered", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = await show(page);
  const doc = page.locator("#doc");

  // One selector per construct in the fixture; each must match at least once.
  const constructs: Record<string, string> = {
    frontMatter: "table.front-matter",
    heading: "h1#user-content-all-features > a.anchor[href='#user-content-all-features']",
    emphasis: "em",
    strong: "strong",
    inlineCode: "p > code",
    link: "a[href='https://example.com'][data-external]",
    hardBreak: "p > br",
    blockquote: "blockquote",
    orderedList: "ol > li",
    nestedList: "ul > li > ul > li",
    rule: "hr",
    indentedCode: ".code-block > pre > code:not([class])",
    highlightedCode: ".code-block > pre > code.language-js.hljs span[class^='hljs-']",
    copyButton: ".code-block > button.copy[aria-label]",
    table: "table th[align='center']",
    taskList: "li > input[type='checkbox'][checked][disabled]",
    strikethrough: "del",
    autolink: "a[href='http://www.example.com']",
    footnoteRef: ".footnote-ref a[href^='#user-content-fn']",
    footnote: "section.footnotes li[id^='user-content-fn']",
    alert: ".markdown-alert-caution .markdown-alert-title",
    mathInline: ".math-inline > .katex",
    mathDisplay: ".math-display .katex-display",
    mermaid: ".mermaid > svg",
    mark: "mark",
    sup: "sup:not(.footnote-ref)",
    sub: "sub",
    wikiLink: "a.wikilink",
    abbr: "abbr[title]",
    definitionList: "dl > dt + dd",
    details: "details > summary",
    kbd: "kbd",
    image: "img[alt]",
  };
  const missing = [];
  for (const [name, selector] of Object.entries(constructs)) {
    if ((await doc.locator(selector).count()) === 0) missing.push(name);
  }
  // feature_fixture_constructs_rendered == 1.0
  expect(missing).toEqual([]);

  expect(await doc.locator(".katex-error, .mermaid-error").count()).toBe(0);
  expect(await doc.locator("pre > code.language-mermaid").count()).toBe(0);
  expect(await doc.textContent()).toContain("🎉");
  expect(requests.some((url) => MERMAID.test(url))).toBe(true);

  // Every in-document link lands on an element that exists.
  const dangling = await doc.evaluate((el) =>
    [...el.querySelectorAll("a[href^='#']")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => !document.getElementById(decodeURIComponent(href.slice(1)))),
  );
  expect(dangling).toEqual([]);
  // No id escapes the document prefix, Mermaid's own aside.
  const bare = await doc.evaluate((el) =>
    [...el.querySelectorAll("[id]")]
      .filter((n) => !n.closest(".mermaid") && !n.id.startsWith("user-content-"))
      .map((n) => n.id),
  );
  expect(bare).toEqual([]);
  expect(errors).toEqual([]);
});

test("test_mermaid_absent_not_loaded", async ({ page }) => {
  const source = "# No diagrams\n\n```js\nconst x = 1;\n```\n\nA mention of mermaid in prose.\n";
  const requests = await show(page, source);
  await expect(page.locator("#doc .hljs")).toHaveCount(1);
  expect(requests.filter((url) => MERMAID.test(url))).toEqual([]);
});

test("test_mermaid_broken_fence_left_as_source", async ({ page }) => {
  await page.goto("/e2e/harness.html");
  const outside = () =>
    page.locator("body > :not(#doc)").evaluateAll((els) => els.map((e) => e.outerHTML));
  const before = await outside();
  await page.evaluate(() => window.harness.show("```mermaid\ngraph LR\n  A -->\n```\n"));
  await expect(page.locator("#doc pre.mermaid-error > code.language-mermaid")).toHaveCount(1);
  await expect(page.locator("#doc svg")).toHaveCount(0);
  // Mermaid's temporary element and its "Syntax error" graphic are gone from `body`.
  expect(await outside()).toEqual(before);
});
