import { strings } from "../../strings";
import { scroller } from "./scroll";

const FENCES = "pre > code.language-mermaid";
const DRAWN = ".mermaid[data-source]";
/** On a fence's `pre` until its diagram is drawn: the source holds its place meanwhile. */
const PENDING = "mermaid-pending";
/** How near the view a diagram is drawn: one view's height above and below. */
const NEAR = "100% 0px";
/** How much one click on zoom in or out scales the diagram. */
const ZOOM_STEP = 1.25;
/** How long `renderMermaid` waits to learn which diagrams are near the view. */
const SEEN_MS = 1000;

type Mermaid = typeof import("mermaid")["default"];

let count = 0;
let mermaid: Mermaid | null = null;
let loading: Promise<Mermaid> | null = null;
let drawnDark = false;
/** Set while printing: paper is light whatever the screen's theme. */
let forPaper = false;
// One draw at a time: `initialize` sets the theme for every `render` after it.
let queue: Promise<void> = Promise.resolve();

/** Fences waiting for their diagram, by `pre`, with what to call once it is drawn. */
const pending = new Map<HTMLElement, () => void>();
/** Pending fences near the view, in the order they came near. */
const near = new Set<HTMLElement>();
let draining: Promise<void> | null = null;
const observers = new Map<Element, IntersectionObserver>();
/** Called with the `pre`s an observer has reported on at least once. */
let onSeen: ((pres: HTMLElement[]) => void)[] = [];

const nextFrame = () =>
  new Promise<void>((resolve) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 0),
  );

/** Whether the page is dark now: the theme sets `color-scheme` on the root. */
function dark(): boolean {
  return !forPaper && /dark/.test(getComputedStyle(document.documentElement).colorScheme);
}

function enqueue(work: () => Promise<void>): Promise<void> {
  queue = queue.then(work, work);
  return queue;
}

function load(): Promise<Mermaid> {
  loading ??= import("mermaid").then(({ default: loaded }) => {
    mermaid = loaded;
    followTheme();
    return loaded;
  });
  return loading;
}

/** Draws `source` with the page's current theme; throws when it does not parse. Mermaid
 * measures its drawing in the page: on a stage of its own, with layout contained, that never
 * lays out the document again. The stage is as wide as `spot`, where the drawing goes: a
 * Gantt chart is laid out at its container's width, and one laid out wider is squashed. */
async function draw(m: Mermaid, source: string, stage: HTMLElement, spot: HTMLElement) {
  const id = `nacho-mermaid-${++count}`;
  // A drawn spot in a hidden tab has no width: it keeps its drawing's.
  const width = spot.clientWidth || spot.querySelector("svg")?.viewBox.baseVal.width;
  stage.style.width = width ? `${width}px` : "";
  try {
    return (await m.render(id, source, stage)).svg;
  } catch (error) {
    // A failed draw can leave Mermaid's temporary element behind.
    stage.replaceChildren();
    throw error;
  }
}

/** Puts a drawing in `figure` with GitHub's controls: zoom in, zoom out, reset, and dragging
 * to pan a zoomed drawing, whose edges stay outside the frame. A redraw starts the view over. */
function show(figure: HTMLElement, svg: string): void {
  figure.innerHTML = svg;
  const drawing = figure.querySelector("svg");
  if (!drawing) return;
  let scale = 1;
  let x = 0;
  let y = 0;
  /** How far a side may move: only as far as the scaled drawing overflows its frame. */
  const reach = (size: number, frame: number) => Math.max(0, (size * scale - frame) / 2);
  const clamp = (at: number, most: number) => Math.min(most, Math.max(-most, at));
  const apply = () => {
    const across = reach(drawing.clientWidth, figure.clientWidth);
    const down = reach(drawing.clientHeight, figure.clientHeight);
    x = clamp(x, across);
    y = clamp(y, down);
    drawing.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    drawing.style.cursor = across || down ? "grab" : "";
  };
  const button = (label: string, glyph: string, act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = glyph;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", () => {
      act();
      apply();
    });
    return b;
  };
  const controls = document.createElement("div");
  controls.className = "mermaid-controls";
  controls.append(
    button(strings.actions.zoomIn, strings.icons.zoomIn, () => {
      scale *= ZOOM_STEP;
    }),
    button(strings.actions.zoomOut, strings.icons.zoomOut, () => {
      scale /= ZOOM_STEP;
    }),
    button(strings.diagramReset, strings.icons.diagramReset, () => {
      scale = 1;
      x = 0;
      y = 0;
    }),
  );
  figure.append(controls);

  drawing.addEventListener("pointerdown", (down) => {
    const [x0, y0] = [x - down.clientX, y - down.clientY];
    const move = (e: PointerEvent) => {
      x = x0 + e.clientX;
      y = y0 + e.clientY;
      apply();
    };
    drawing.setPointerCapture(down.pointerId);
    drawing.addEventListener("pointermove", move);
    drawing.addEventListener(
      "lostpointercapture",
      () => drawing.removeEventListener("pointermove", move),
      {
        once: true,
      },
    );
  });
}

/** Runs `each` on items as `next` hands them out, one per frame, so many diagrams never
 * freeze the window. */
async function onePerFrame<T>(
  next: () => T | undefined,
  each: (item: T, stage: HTMLElement) => Promise<void>,
) {
  const stage = document.createElement("div");
  stage.className = "mermaid-stage";
  document.body.append(stage);
  try {
    for (let item = next(), first = true; item !== undefined; item = next(), first = false) {
      if (!first) await nextFrame();
      await each(item, stage);
    }
  } finally {
    stage.remove();
  }
}

function initialize(m: Mermaid): void {
  drawnDark = dark();
  m.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: drawnDark ? "dark" : "default",
  });
}

/** Draws the fences near the view, nearest first come, until none are left; Mermaid is
 * imported on the first. */
function drain(): Promise<void> {
  draining ??= enqueue(async () => {
    try {
      const m = await load();
      initialize(m);
      const next = () => {
        const [pre] = near;
        if (pre) near.delete(pre);
        return pre;
      };
      await onePerFrame(next, (pre, stage) => drawFence(m, pre, stage));
    } finally {
      draining = null;
      // Fences that came near while the last one was drawn.
      if (near.size > 0) void drain();
    }
  });
  return draining;
}

async function drawFence(m: Mermaid, pre: HTMLElement, stage: HTMLElement): Promise<void> {
  const done = pending.get(pre);
  pending.delete(pre);
  for (const observer of observers.values()) observer.unobserve(pre);
  pre.classList.remove(PENDING);
  try {
    if (!pre.isConnected) return;
    const source = pre.querySelector("code")?.textContent ?? "";
    try {
      const svg = await draw(m, source, stage, pre);
      const figure = document.createElement("div");
      figure.className = "mermaid";
      figure.dataset.source = source;
      show(figure, svg);
      pre.replaceWith(figure);
    } catch (error) {
      pre.classList.add("mermaid-error");
      pre.title = String(error);
    }
  } finally {
    done?.();
  }
}

/** The fence comes near the view: drawn in turn. */
function want(pre: HTMLElement): void {
  if (!pending.has(pre)) return;
  near.add(pre);
  void drain();
}

function observer(view: Element): IntersectionObserver {
  let found = observers.get(view);
  if (!found) {
    // The page's own scrolling is the implicit root; a scrolling box is its own.
    const root = view === document.scrollingElement ? null : view;
    found = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) want(e.target as HTMLElement);
        const pres = entries.map((e) => e.target as HTMLElement);
        for (const seen of onSeen) seen(pres);
      },
      { root, rootMargin: NEAR },
    );
    observers.set(view, found);
  }
  return found;
}

/** Redraws every diagram if the page turned light or dark since: Mermaid bakes its colours in.
 * Fences not drawn yet take the theme of the moment they are reached. */
function redraw(): Promise<void> {
  if (!mermaid || dark() === drawnDark) return queue;
  const m = mermaid;
  return enqueue(async () => {
    initialize(m);
    const figures = [...document.querySelectorAll<HTMLElement>(DRAWN)];
    await onePerFrame(
      () => figures.shift(),
      async (figure, stage) => {
        try {
          show(figure, await draw(m, figure.dataset.source ?? "", stage, figure));
          figure.classList.remove("mermaid-error");
        } catch (error) {
          // The old drawing stays, in the other theme, so it is marked as a first draw's would be.
          figure.classList.add("mermaid-error");
          figure.title = String(error);
          console.error(error);
        }
      },
    );
  });
}

function followTheme(): void {
  new MutationObserver(() => void redraw()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => void redraw());
}

/** Draws every diagram, light, for paper, those never scrolled near included; the returned
 * function puts the screen theme back. Mermaid draws asynchronously, so this is awaited
 * before `print()`: `beforeprint` cannot wait. `afterprint` restores too, for a webview
 * whose `print()` does not block. */
export async function diagramsForPaper(): Promise<() => void> {
  forPaper = true;
  const back = () => {
    if (!forPaper) return;
    forPaper = false;
    void redraw();
  };
  addEventListener("afterprint", back, { once: true });
  // Drawn ones first, so the pending ones are not drawn twice.
  await redraw();
  // Only the shown tab prints; the others' are drawn when they come near the view.
  for (const pre of pending.keys()) if (pre.isConnected && pre.clientWidth) near.add(pre);
  if (near.size > 0) await drain();
  return back;
}

/** Turn each `mermaid` fence into its diagram, in the page's light or dark theme, once it
 * comes within a view's height of the view. Mermaid (~2 MB) is imported only when the first
 * diagram does. Its SVG is inserted after sanitising: trusted code drew it, with
 * `securityLevel: 'strict'` so labels cannot carry HTML or script. A diagram that fails to
 * parse stays as its source. Settles once the diagrams near the view now are drawn. */
export async function renderMermaid(root: ParentNode): Promise<void> {
  prune();
  const pres = [...root.querySelectorAll<HTMLElement>(FENCES)]
    .map((code) => code.parentElement as HTMLElement)
    .filter((pre) => pre && !pending.has(pre));
  if (pres.length === 0) return;
  const drawn = pres.map(
    (pre) =>
      new Promise<void>((resolve) => {
        pending.set(pre, resolve);
        pre.classList.add(PENDING);
      }),
  );
  if (typeof IntersectionObserver !== "function") {
    for (const pre of pres) want(pre);
    await Promise.all(drawn);
    return;
  }

  // Which of these the observer finds near the view on its first report, at the latest
  // after `SEEN_MS`: a sheet that is not shown is never reported on.
  const unseen = new Set(pres);
  await new Promise<void>((resolve) => {
    const seen = (reported: HTMLElement[]) => {
      for (const pre of reported) unseen.delete(pre);
      if (unseen.size === 0) finish();
    };
    const timer = setTimeout(() => finish(), SEEN_MS);
    const finish = () => {
      clearTimeout(timer);
      onSeen = onSeen.filter((f) => f !== seen);
      resolve();
    };
    onSeen.push(seen);
    for (const pre of pres) observer(scroller(pre)).observe(pre);
  });
  // Those no longer pending are being drawn, or are drawn.
  await Promise.all(drawn.filter((_, i) => !pending.has(pres[i]) || near.has(pres[i])));
}

/** Forgets fences of documents no longer shown. */
function prune(): void {
  for (const [pre, done] of pending) {
    if (pre.isConnected) continue;
    for (const observer of observers.values()) observer.unobserve(pre);
    pending.delete(pre);
    near.delete(pre);
    done();
  }
}
