import { expect, type Page, test } from "@playwright/test";

type Scheme = "light" | "dark";

// Both ways a theme is chosen: System following the OS, and View › Theme overriding it.
const CASES: { setting: string; os: Scheme; expected: Scheme }[] = [
  { setting: "system", os: "light", expected: "light" },
  { setting: "system", os: "dark", expected: "dark" },
  { setting: "light", os: "dark", expected: "light" },
  { setting: "dark", os: "light", expected: "dark" },
];

async function open(page: Page, setting: string, os: Scheme) {
  await page.emulateMedia({ colorScheme: os });
  await page.goto(`/e2e/theme.html?theme=${setting}`);
  await expect(page.locator(".sheet svg[role=img] text")).toHaveCount(1);
  // The diagram is drawn once it nears the view.
  await page.locator(".sheet :is(pre.mermaid-pending, .mermaid)").scrollIntoViewIfNeeded();
  await expect(page.locator(".sheet .mermaid > svg")).toHaveCount(1);
}

/** sRGB relative luminance of a computed `rgb(…)` colour (WCAG 2). */
function luminance(colour: string): number {
  const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("test_currentcolor_svg_follows_theme_light_and_dark", async ({ page }) => {
  const ink: Record<string, Set<string>> = { light: new Set(), dark: new Set() };
  for (const { setting, os, expected } of CASES) {
    await open(page, setting, os);
    const seen = await page.evaluate(() => {
      const style = (selector: string) =>
        getComputedStyle(document.querySelector(selector) as Element);
      return {
        text: style(".sheet p").color,
        fill: style(".sheet svg[role=img] text").fill,
        stroke: style(".sheet svg[role=img] rect").stroke,
      };
    });
    console.log(`${setting}/${os}: ${JSON.stringify(seen)}`);
    expect(seen.fill, `${setting} theme, ${os} OS`).toBe(seen.text);
    expect(seen.stroke, `${setting} theme, ${os} OS`).toBe(seen.text);
    ink[expected].add(seen.text);
  }
  // One text colour per theme, and the two differ.
  expect(ink.light.size).toBe(1);
  expect(ink.dark.size).toBe(1);
  expect([...ink.light][0]).not.toBe([...ink.dark][0]);
  console.log("themed_svg_fill_matches_text_colour=true");
});

test("test_body_text_contrast_at_least_aa", async ({ page }) => {
  // Body text and the text styles a page is made of, each against the background it sits on.
  const selectors = [
    ".sheet p",
    ".sheet p a",
    ".sheet h2",
    ".sheet blockquote p",
    ".sheet li",
    ".sheet table:not(.front-matter) td",
    ".sheet :not(pre) > code",
    ".sheet pre code",
    ".sheet .hljs-comment",
    ".sheet .hljs-keyword",
    ".sheet .front-matter td",
    ".sheet .footnotes li",
    ".sheet .markdown-alert-note .markdown-alert-title",
    ".sheet .markdown-alert-tip .markdown-alert-title",
    ".sheet .markdown-alert-important .markdown-alert-title",
    ".sheet .markdown-alert-warning .markdown-alert-title",
    ".sheet .markdown-alert-caution .markdown-alert-title",
  ];
  for (const scheme of ["light", "dark"] as const) {
    await open(page, scheme, scheme);
    const pairs = await page.evaluate((list) => {
      const background = (el: Element | null): string => {
        for (; el; el = el.parentElement) {
          const bg = getComputedStyle(el).backgroundColor;
          if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
        }
        return "rgb(255, 255, 255)";
      };
      return list.map((selector) => {
        const el = document.querySelector(selector);
        return { selector, fg: el && getComputedStyle(el).color, bg: background(el) };
      });
    }, selectors);
    for (const { selector, fg, bg } of pairs) {
      expect(fg, `${selector} is in the fixture`).not.toBeNull();
      const ratio = contrast(fg as string, bg);
      console.log(`${scheme} ${selector}: ${ratio.toFixed(2)}`);
      expect(ratio, `${scheme}: ${selector} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("test_mermaid_redrawn_when_theme_changes", async ({ page }) => {
  await open(page, "light", "light");
  const node = page.locator(".sheet .mermaid > svg .node :is(rect, polygon)").first();
  const fill = () => node.evaluate((el) => getComputedStyle(el).fill);
  const light = await fill();
  await page.locator(".menu-button").click();
  await page.locator(".menu-item[data-action=settings]").click();
  await page.locator(".settings-dialog [data-theme=dark]").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(fill).not.toBe(light);
  await expect(page.locator(".sheet .mermaid > svg")).toHaveCount(1);
});

test("test_settings_keeps_page_scrollable_and_takes_arrow_keys", async ({ page }) => {
  await page.goto("/e2e/shell.html");
  await expect(page.locator(".sheet h1")).toBeVisible();
  await page.locator(".menu-button").click();
  await page.locator(".menu-item[data-action=settings]").click();

  // The wheel beside the panel scrolls the page; the panel stays open.
  const top = async () => (await page.locator(".sheet h1").boundingBox())?.y ?? 0;
  const before = await top();
  await page.mouse.move(150, 400);
  await page.mouse.wheel(0, 400);
  await expect.poll(top).toBeLessThan(before);
  await expect(page.locator(".settings-dialog")).toBeVisible();

  // Focus starts on the current theme; arrows pick within a group, Tab goes to the next one.
  await expect(page.locator(".settings-dialog [data-theme=system]")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".settings-dialog [data-style=newspaper]")).toBeFocused();
  await expect(page.locator(".settings-dialog [data-style=newspaper]")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Modal: the toolbar sits under the overlay, and a click beside the panel only closes it.
  const covered = await page.locator(".menu-button").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return !!document
      .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      ?.closest(".print-overlay");
  });
  expect(covered).toBe(true);
  await page.mouse.click(150, 400);
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
});
