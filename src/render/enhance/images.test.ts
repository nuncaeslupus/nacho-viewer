import { describe, expect, it } from "vitest";
import { render } from "../pipeline";
import { sanitize } from "../sanitize";
import { classify, imagePolicy } from "./images";

const DOC = "/home/u/notes/readme.md";
const image = (p: string) => `image://localhost/${encodeURIComponent(p)}`;

function images(markdown: string, remoteImages: boolean): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = sanitize(render(markdown), imagePolicy(DOC, remoteImages, image));
  return root;
}

const REMOTE = [
  "![a](https://example.com/a.png)",
  "![b](//example.com/b.png)",
  '<img src="http://example.com/c.png" srcset="https://example.com/c2.png 2x">',
  '<picture><source srcset="https://example.com/d.png"><img src="data:image/png;base64,AA=="></picture>',
  "![f](https:example.com/f.png) ![g](http:example.com/g.png) ![h](HTTPS://EXAMPLE.com/h.png)",
].join("\n\n");

describe("imagePolicy", () => {
  it("test_remote_images_off_sources_removed_before_insertion", () => {
    const root = images(REMOTE, false);
    expect(root.innerHTML).not.toMatch(/ (?:src|srcset)="[^"]*example\.com/i);
    const kept = Array.from(root.querySelectorAll("img[data-remote-src]"), (i) =>
      i.getAttribute("data-remote-src"),
    );
    expect(kept).toEqual([
      "https://example.com/a.png",
      "//example.com/b.png",
      "http://example.com/c.png",
      "https:example.com/f.png",
      "http:example.com/g.png",
      "HTTPS://EXAMPLE.com/h.png",
    ]);
    expect(root.querySelector('img[src^="data:"]')).not.toBeNull();
  });

  it("test_remote_images_on_sources_kept", () => {
    const root = images(REMOTE, true);
    const srcs = Array.from(root.querySelectorAll("img"), (i) => i.getAttribute("src"));
    expect(srcs).toContain("https://example.com/a.png");
    expect(srcs).toContain("https://example.com/b.png");
    expect(srcs).toContain("https://example.com/f.png");
    expect(srcs).toContain("https://example.com/g.png");
    expect(srcs).toContain("https://example.com/c.png");
    expect(srcs.some((s) => s?.startsWith("http:"))).toBe(false);
    expect(srcs).toContain("https://example.com/h.png");
    expect(root.querySelector("source")?.getAttribute("srcset")).toBe("https://example.com/d.png");
    const http = images('<img src="http://e.com/a.png" srcset="http://e.com/a2.png 2x">', true);
    expect(http.querySelector("img")?.getAttribute("srcset")).toBe("https://e.com/a2.png 2x");
  });

  it("test_local_images_use_image_protocol_and_svgs_marked", () => {
    const root = images("![x](img/my%20pic.png) ![y](../flow.SVG) ![z](/abs/z.png)", true);
    const [x, y, z] = Array.from(root.querySelectorAll("img"));
    expect(x.getAttribute("src")).toBe(image("/home/u/notes/img/my pic.png"));
    expect(y.getAttribute("src")).toBeNull();
    expect(y.getAttribute("data-svg-path")).toBe("/home/u/flow.SVG");
    expect(z.getAttribute("src")).toBe(image("/abs/z.png"));
  });

  it("test_classify_resolves_like_the_url_parser", () => {
    expect(classify("/a b/doc.md", "c%20d.png?x#y")).toEqual({ local: "/a b/c d.png" });
    expect(classify("/a/doc.md", "https:host/x.png")).toEqual({ remote: "https://host/x.png" });
    expect(classify("/a/doc.md", "HTTP:host/x.png")).toEqual({ remote: "http://host/x.png" });
    expect(classify("/a/doc.md", "//host/x.png")).toEqual({ remote: "https://host/x.png" });
    expect(classify("/a/doc.md", "%E0%A4%A")).toBeNull();
  });

  it("test_classify_windows_path_keeps_the_drive_letter_first", () => {
    expect(classify("C:\\a b\\doc.md", "docs/x.png")).toEqual({ local: "C:/a b/docs/x.png" });
    expect(classify("C:\\a\\doc.md", "/x.png")).toEqual({ local: "C:/x.png" });
  });
});
