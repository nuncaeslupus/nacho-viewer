import { describe, expect, it } from "vitest";
import { inlineSvgs, sanitizeSvg } from "./svg";

const FLOW = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">
  <style>body { display: none } path { fill: red }</style>
  <defs><linearGradient id="g"><stop offset="0"/></linearGradient><path id="p" d="M0 0h1"/></defs>
  <path fill="url(#g)" stroke="currentColor" d="M0 0h10"/>
  <use href="#p"/><use xlink:href="#p"/>
  <script>alert(1)</script>
  <path onclick="alert(1)" d="M1 1h1"/>
  <image href="https://example.com/track.png"/>
  <use href="other.svg#p"/>
  <rect style="fill: url(https://example.com/x)" filter="url('#g')"/>
</svg>`;

describe("sanitizeSvg", () => {
  it("test_svg_root_style_dropped", () => {
    const svg = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" style="position:fixed;inset:0;z-index:99999"><rect style="fill:red"/></svg>',
    );
    expect(svg?.hasAttribute("style")).toBe(false);
    expect(svg?.querySelector("rect")?.getAttribute("style")).toBe("fill:red");
  });

  it("test_svg_inline_style_tags_stripped", () => {
    const svg = sanitizeSvg(FLOW);
    expect(svg).not.toBeNull();
    expect(svg?.querySelector("style")).toBeNull();
    expect(svg?.outerHTML).not.toMatch(/display: none|fill: red/);
    expect(svg?.querySelector("script")).toBeNull();
    expect(svg?.outerHTML).not.toMatch(/onclick|alert/);
    expect(svg?.querySelector("path[stroke]")?.getAttribute("stroke")).toBe("currentColor");
  });

  it("test_svg_inline_ids_and_references_prefixed", () => {
    const a = sanitizeSvg(FLOW);
    const b = sanitizeSvg(FLOW);
    const id = a?.querySelector("linearGradient")?.id ?? "";
    expect(id).toMatch(/^gm-svg\d+-g$/);
    expect(b?.querySelector("linearGradient")?.id).not.toBe(id);
    expect(a?.querySelector("path[fill]")?.getAttribute("fill")).toBe(`url(#${id})`);
    const p = a?.querySelector("defs path")?.id;
    const uses = Array.from(a?.querySelectorAll("use") ?? []);
    const refs = uses.map((u) => u.getAttribute("href") ?? u.getAttribute("xlink:href"));
    expect(refs.slice(0, 2)).toEqual([`#${p}`, `#${p}`]);
    expect(a?.querySelector("rect")?.getAttribute("filter")).toBe(`url('#${id}')`);
  });

  it("test_svg_inline_external_references_dropped", () => {
    const html = sanitizeSvg(FLOW)?.outerHTML ?? "";
    expect(html).not.toMatch(/example\.com|other\.svg/);
  });

  it("test_svg_inline_dom_property_ids_kept_and_prefixed", () => {
    const svg = sanitizeSvg(
      '<svg><linearGradient id="title"/><rect fill="url(#title)"/><g id="forms"/></svg>',
    );
    const id = svg?.querySelector("linearGradient")?.id ?? "";
    expect(id).toMatch(/^gm-svg\d+-title$/);
    expect(svg?.querySelector("rect")?.getAttribute("fill")).toBe(`url(#${id})`);
    expect(svg?.querySelector("g")?.id).toMatch(/^gm-svg\d+-forms$/);
  });

  it("test_svg_inline_not_svg_returns_null", () => {
    expect(sanitizeSvg("<p>hi</p>")).toBeNull();
    expect(sanitizeSvg("")).toBeNull();
  });
});

describe("inlineSvgs", () => {
  it("test_svg_inline_replaces_img_or_falls_back", async () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<img data-svg-path="/n/a.svg" alt="Flow" width="40"><img data-svg-path="/n/big.svg">';
    const read = async (path: string) => {
      if (path === "/n/a.svg") return FLOW;
      throw { kind: "too_large" };
    };
    await inlineSvgs(root, read, (p) => `image://localhost${p}`);
    const svg = root.querySelector("svg");
    expect(svg?.getAttribute("aria-label")).toBe("Flow");
    expect(svg?.getAttribute("width")).toBe("40");
    expect(root.querySelector("img")?.getAttribute("src")).toBe("image://localhost/n/big.svg");
    expect(root.querySelector("[data-svg-path]")).toBeNull();
  });
});
