import { strings } from "../strings";
import { Anchors, type Enhanced, enhance, enhancePart, renderMermaid } from "./enhance";
import type { ImagePolicy } from "./enhance/images";
import { scroller } from "./enhance/scroll";
import type { ParseRequest, ParseResult } from "./parse.worker";
import { render, renderChunks } from "./pipeline";
import { sanitizeFragment } from "./sanitize";

/** Sources from this size are large: parsed in a worker and built in slices. Below it the
 * whole render is one short task, done before the next paint. */
const LARGE = 64_000;
/** How long the UI thread works on a large document before letting the window respond. */
const SLICE_MS = 40;
/** About how many characters of HTML make a pixel of height, to size boxes not laid out yet. */
const CHARS_PER_PX = 8;
/** A worker that has not answered by then is given up on, and the document is not shown. */
const WORKER_TIMEOUT_MS = 10_000;

let worker: Worker | null | undefined;
let requests = 0;
const pending = new Map<number, (chunks: string[] | null) => void>();

function parseWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<ParseResult>) => {
      pending.get(data.id)?.(data.chunks);
      pending.delete(data.id);
    };
    // A worker that cannot start (or dies) leaves parsing to the UI thread.
    worker.onerror = () => dropWorker(null);
  } catch {
    worker = null;
  }
  return worker;
}

/** Ends the worker and answers what it still owes with nothing. `next` is what the next
 * parse finds: `null` for none ever again, `undefined` for a fresh one. */
function dropWorker(next: null | undefined): void {
  worker?.terminate();
  worker = next;
  for (const done of pending.values()) done(null);
  pending.clear();
}

async function parseLarge(source: string): Promise<string[]> {
  const off = typeof Worker === "function" && parseWorker();
  if (off) {
    const id = ++requests;
    let timedOut = false;
    const chunks = await new Promise<string[] | null>((resolve) => {
      const timer = setTimeout(() => {
        // A worker stuck on one document holds up every later one: a fresh one starts.
        timedOut = pending.has(id);
        if (timedOut) dropWorker(undefined);
      }, WORKER_TIMEOUT_MS);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      off.postMessage({ id, source } satisfies ParseRequest);
    });
    // Parsing the same document on the UI thread would freeze the window for at least as long.
    if (timedOut) throw new Error(strings.renderTimedOut);
    if (chunks) return chunks;
  }
  return renderChunks(source);
}

// A task boundary without `setTimeout`'s 4 ms clamp on chained timers.
const yieldTask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** The render each root is showing; a newer one stops an older one between slices. */
const latest = new WeakMap<HTMLElement, object>();

export interface Rendered extends Enhanced {
  /** Settles once a large document is laid out in full (see `settle`). */
  settled: Promise<void>;
}

/** Render `source` into `root`, replacing what it shows. A large document is parsed in a
 * worker, then sanitised and enhanced a piece at a time, never holding the UI thread for
 * much more than `SLICE_MS`; each piece goes in a box that skips layout while off screen,
 * and the boxes replace the old content at once. Settles once the new content is in;
 * `ready` once the Mermaid diagrams are drawn; `settled` once the boxes are laid out. A render
 * superseded by a newer one into the same root, or once `current` turns false, stops early
 * and leaves the root alone. `images` is the sanitiser's image policy. */
export async function renderDocument(
  root: HTMLElement,
  source: string,
  { current = () => true, images }: { current?: () => boolean; images?: ImagePolicy } = {},
): Promise<Rendered> {
  const token = {};
  latest.set(root, token);
  const live = () => latest.get(root) === token && current();
  const done = Promise.resolve();
  if (source.length < LARGE) {
    root.replaceChildren(sanitizeFragment(render(source), images));
    return { ...enhance(root), settled: done };
  }

  const anchors = new Anchors();
  const stopped = { outline: anchors.outline, ready: done, settled: done };
  const chunks = await parseLarge(source);
  const boxes: HTMLElement[] = [];
  let deadline = performance.now() + SLICE_MS;
  for (const html of chunks) {
    if (!live()) return stopped;
    if (performance.now() > deadline) {
      await yieldTask();
      deadline = performance.now() + SLICE_MS;
    }
    const box = document.createElement("div");
    box.className = "chunk";
    box.style.containIntrinsicSize = `auto ${Math.round(html.length / CHARS_PER_PX)}px`;
    box.append(sanitizeFragment(html, images));
    enhancePart(box, anchors);
    boxes.push(box);
  }
  if (!live()) return stopped;
  root.replaceChildren(...boxes);
  anchors.link(root);
  const ready = renderMermaid(root);
  // After the diagrams near the view: drawn into laid-out boxes, each would lay out the
  // document again.
  const after = () => settle(root, boxes, live);
  return { outline: anchors.outline, ready, settled: ready.then(after, after) };
}

/** The first child of `parent` that reaches below `top`, by binary search. */
function childAt(parent: Element, top: number): Element | undefined {
  const children = parent.children;
  let lo = 0;
  let hi = children.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (children[mid].getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  return children[lo];
}

/** Lay out the boxes, nearest the view first, a slice at a time, until they are plain
 * `div`s that the document's margins collapse through as if it were inserted whole. They
 * stay: a parent of thousands of blocks is slow to lay out again. Boxes off screen were
 * sized by estimate, so whatever is at the top of the view is kept in place. The first slice runs
 * before the browser lays out the boxes near the view by itself, and does only those: it
 * shares a frame with that layout. */
async function settle(root: HTMLElement, boxes: HTMLElement[], live: () => boolean) {
  await nextFrame();
  const view = scroller(root);
  const viewTop = () => (view === document.scrollingElement ? 0 : view.getBoundingClientRect().top);
  const first = childAt(root, viewTop());
  const at = Math.max(0, boxes.indexOf(first as HTMLElement));
  const order = boxes.map((_, i) => i).sort((a, b) => Math.abs(a - at) - Math.abs(b - at));
  // The browser's own scroll anchoring would add its correction to this one.
  root.style.overflowAnchor = "none";
  let slice = 0;
  while (order.length > 0 && live()) {
    const top = viewTop();
    let anchor = childAt(root, top);
    // The box's child at the top: margins collapse through a box once it is laid out.
    if (boxes.includes(anchor as HTMLElement)) anchor = childAt(anchor as Element, top) ?? anchor;
    const before = anchor?.getBoundingClientRect().top ?? 0;
    const deadline = performance.now() + SLICE_MS;
    for (let n = 0; order.length > 0 && (slice > 0 ? performance.now() < deadline : n < 2); n++) {
      const box = boxes[order.shift() as number];
      box.removeAttribute("class");
      box.removeAttribute("style");
      // Lay it out now, inside the slice, rather than all at the next paint.
      void root.offsetHeight;
    }
    slice++;
    if (anchor?.isConnected) view.scrollTop += anchor.getBoundingClientRect().top - before;
    await yieldTask();
  }
  root.style.removeProperty("overflow-anchor");
}
