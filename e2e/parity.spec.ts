import { expect, test } from "@playwright/test";

test("heading anchor shows when its own spot is hovered", async ({ page }) => {
  await page.goto("/e2e/shell.html");
  const anchor = page.locator(".sheet h1 > .anchor");
  await expect(anchor).toHaveCSS("opacity", "0");

  // GitHub's chain icon, not a "#".
  const icon = await anchor.evaluate((a) => {
    const s = getComputedStyle(a, "::before");
    return { content: s.content, mask: s.maskImage || s.webkitMaskImage };
  });
  expect(icon.content).not.toContain("#");
  expect(icon.mask).toContain("svg");

  // Hovering the icon's own spot, left of the heading text, shows it.
  const box = await anchor.boundingBox();
  if (!box) throw new Error("anchor has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(anchor).toHaveCSS("opacity", "1");
});

test("img height attribute sizes the image", async ({ page }) => {
  // A 600×300 picture with only height="150", like the mermaid-js README logo, in a sheet
  // styled as the app is.
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='300'/>";
  await page.goto("/e2e/theme.html");
  const sheet = page.locator(".sheet").first();
  await sheet.evaluate(
    (el, src) => {
      el.insertAdjacentHTML("afterbegin", `<img alt="logo" height="150" src="${src}">`);
    },
    `data:image/svg+xml,${encodeURIComponent(svg)}`,
  );
  const img = page.locator(".sheet img[alt=logo]");
  await expect(img).toHaveJSProperty("complete", true);
  const box = await img.boundingBox();
  expect(box?.height).toBe(150);
  expect(box?.width).toBe(300);

  // Both attributes, wider than the sheet: scaled down whole, not squashed.
  await sheet.evaluate(
    (el, src) => {
      el.insertAdjacentHTML(
        "afterbegin",
        `<img alt="wide" width="4000" height="2000" src="${src}">`,
      );
    },
    `data:image/svg+xml,${encodeURIComponent(svg)}`,
  );
  const wide = await page.locator(".sheet img[alt=wide]").boundingBox();
  expect(wide?.width).toBeLessThan(4000);
  expect(wide?.height).toBeCloseTo((wide?.width ?? 0) / 2, 0);
});

test("gantt chart keeps its natural height", async ({ page }) => {
  // Mermaid lays a Gantt chart out at its container's width: laid out wider than the sheet,
  // it is then shrunk to fit, and its bars squashed.
  await page.goto("/e2e/theme.html?gantt");
  const svg = page.locator(".sheet .mermaid > svg[aria-roledescription=gantt]");
  await expect(svg).toHaveCount(1);
  const { drawn, natural } = await svg.evaluate((el) => ({
    drawn: el.getBoundingClientRect().width,
    natural: (el as SVGSVGElement).viewBox.baseVal.width,
  }));
  expect(drawn / natural).toBeGreaterThan(0.95);

  // Redrawn for a new theme while its tab is hidden, it keeps its width.
  const id = await svg.getAttribute("id");
  await page.evaluate(() => {
    (document.querySelector(".canvas") as HTMLElement).hidden = true;
    document.documentElement.dataset.theme = "dark";
  });
  await expect(svg).not.toHaveAttribute("id", id ?? "");
  expect(await svg.evaluate((el) => (el as SVGSVGElement).viewBox.baseVal.width)).toBe(natural);
});

test("body text is sans-serif", async ({ page }) => {
  // The owner's call: body text in the headings' sans (Inter), as on GitHub.
  await page.goto("/e2e/theme.html");
  const p = page.locator(".sheet p").first();
  await expect(p).toHaveCSS("font-family", /^"?Inter Variable/);
});

test("issues image matches GitHub size", async ({ page }) => {
  // The Mermaid README's "Git Issues" chart: GitHub lays it out across the column, unshrunk.
  await page.goto("/e2e/theme.html?issues");
  const svg = page.locator(".sheet .mermaid > svg[aria-roledescription=gantt]");
  await expect(svg).toHaveCount(1);
  const { drawn, natural, column } = await svg.evaluate((el) => ({
    drawn: el.getBoundingClientRect().width,
    natural: (el as SVGSVGElement).viewBox.baseVal.width,
    column: (el.parentElement as HTMLElement).clientWidth,
  }));
  expect(drawn / column).toBeGreaterThan(0.95);
  expect(drawn / natural).toBeGreaterThan(0.95);
});

test("copy button is always visible with the copy icon", async ({ page }) => {
  // GitHub's two-squares icon, shown without hovering the block, and no text label.
  await page.goto("/e2e/theme.html");
  const copy = page.locator(".sheet .code-block > .copy").first();
  await expect(copy).toHaveCSS("opacity", "1");
  const icon = await copy.evaluate((b) => {
    const s = getComputedStyle(b, "::before");
    return { content: s.content, mask: s.maskImage || s.webkitMaskImage };
  });
  expect(icon.content).not.toContain("Copy");
  // The Octicons "copy" path, not a check or a text label.
  expect(icon.mask).toContain("M0 6.75");
});

test("front matter renders one row per key", async ({ page }) => {
  // GitHub shows front matter as key/value rows, not one row of columns.
  await page.goto("/e2e/theme.html");
  const rows = page.locator(".sheet table.front-matter tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator("th")).toHaveText("title");
  await expect(rows.nth(0).locator("td")).toHaveCount(1);
});

test("mermaid diagram zooms and pans", async ({ page }) => {
  // GitHub's controls on a diagram: zoom in and out, reset, and dragging to pan.
  await page.goto("/e2e/theme.html?gantt");
  const figure = page.locator(".sheet .mermaid").first();
  const svg = figure.locator("svg");
  await expect(svg).toHaveCount(1);
  const box = async () => {
    const b = await svg.boundingBox();
    if (!b) throw new Error("diagram has no box");
    return b;
  };
  const start = await box();

  await figure.hover();
  await figure.getByRole("button", { name: "Zoom in" }).click();
  const zoomed = await box();
  expect(zoomed.width).toBeGreaterThan(start.width * 1.1);

  const fig = await figure.boundingBox();
  if (!fig) throw new Error("figure has no box");
  await page.mouse.move(fig.x + fig.width / 2, fig.y + fig.height / 2);
  await page.mouse.down();
  await page.mouse.move(fig.x + fig.width / 2 + 40, fig.y + fig.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  const panned = await box();
  expect(panned.x - zoomed.x).toBeCloseTo(40, 0);
  expect(panned.y - zoomed.y).toBeCloseTo(10, 0);

  await figure.getByRole("button", { name: "Zoom out" }).click();
  expect((await box()).width).toBeLessThan(panned.width);
  await figure.getByRole("button", { name: "Reset view" }).click();
  expect(await box()).toEqual(start);
});

test("test_wide_sheet_keeps_the_reading_place", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/e2e/shell.html?big");
  const heading = page.locator(".sheet h2").nth(100);
  // Headings first: before the document arrives there are no chunks either. With several WebKit
  // pages loading at once, one can freeze for over 5 s once the document is in.
  await expect(heading).toBeAttached({ timeout: 20_000 });
  await expect(page.locator(".sheet .chunk")).toHaveCount(0);
  // Just past the top of the view: a heading exactly on that line may not be the one kept.
  await heading.evaluate((el) => {
    el.scrollIntoView();
    el.closest(".canvas")?.scrollBy(0, 20);
  });
  const top = () => heading.evaluate((el) => el.getBoundingClientRect().top);
  const before = await top();
  await page.keyboard.press("Control+9");
  await expect.poll(top).toBeCloseTo(before, 0);
});

test("test_browser_menu_stays_only_for_copying_selected_text", async ({ page }) => {
  await page.goto("/e2e/shell.html?demo");
  const text = page.locator(".sheet p").first();
  await expect(text).toBeAttached();
  const menu = (selected: boolean) =>
    text.evaluate((el, select) => {
      const picked = document.getSelection();
      if (select) picked?.selectAllChildren(el);
      else picked?.collapse(el, 0);
      return el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    }, selected);
  expect(await menu(false)).toBe(false);
  expect(await menu(true)).toBe(true);
});

test("test_start_page_stays_put_when_recent_files_go", async ({ page }) => {
  await page.goto("/e2e/shell.html?demo");
  while (await page.locator(".tab-close").count()) await page.locator(".tab-close").first().click();
  const place = () =>
    page.evaluate(() =>
      [".drop", ".recent"].map((s) => {
        const { x, y, width } = (document.querySelector(s) as Element).getBoundingClientRect();
        return { x, y, width };
      }),
    );
  const before = await place();
  await page.locator(".recent-remove").first().click();
  await expect(page.locator(".recent-remove")).toHaveCount(1);
  expect(await place()).toEqual(before);

  const box = before[0];
  await page.locator(".recent-clear").click();
  await expect(page.locator(".recent")).toHaveCount(0);
  await expect(page.locator(".drop")).toHaveCSS("grid-row-start", "2");
  expect((await page.locator(".drop").boundingBox())?.y).toBe(box?.y);
});
