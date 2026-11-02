// The render pipeline without the Tauri shell, for Playwright: parse → sanitise → insert →
// enhance, into `#doc`. `app` starts the real shell on the in-memory core instead. Built only
// in `--mode e2e`, never into the app.
import fixture from "../docs/fixtures/all-features.md?raw";
import guide from "../docs/guide.md?raw";
import { renderDocument } from "../src/render/document";
import { fakeBackend } from "../src/ui/fake-backend";
import type { Config } from "../src/ui/ipc";
import { Shell } from "../src/ui/shell";
import { bigDocument } from "./big";

export interface Timing {
  /** From the start of the render until all of it is in and painted, before any diagram. */
  interactiveMs: number;
  /** Until the diagrams near the view are drawn too, and painted. Off-screen parts of a large
   * document may still be laid out by estimate. */
  totalMs: number;
  /** Until the off-screen parts are laid out too, in the background. */
  settledMs: number;
  /** The longest the main thread went without running a timer, until settled: the worst
   * freeze. */
  longestTaskMs: number;
}

declare global {
  interface Window {
    harness: {
      fixture: string;
      guide: string;
      big: typeof bigDocument;
      show(source: string): Promise<void>;
      measure(source: string): Promise<Timing>;
      app(files: Record<string, string>, launch: string[], config?: Partial<Config>): Promise<void>;
    };
  }
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Render `source` and wait for its diagrams; the result also says when it settles. */
async function render(source: string) {
  const rendered = await renderDocument(document.getElementById("doc") as HTMLElement, source);
  await rendered.ready;
  return rendered;
}

window.harness = {
  fixture,
  guide,
  big: bigDocument,
  async show(source) {
    await render(source);
  },
  async measure(source) {
    // A timer chain beats every few ms while the main thread is free; the widest gap between
    // two beats is the longest task (script, style or layout) that blocked it.
    let last = performance.now();
    let longestTaskMs = 0;
    let beating = true;
    const beat = () => {
      const now = performance.now();
      longestTaskMs = Math.max(longestTaskMs, now - last);
      last = now;
      if (beating) setTimeout(beat, 0);
    };
    setTimeout(beat, 0);
    await frame();
    const start = performance.now();
    const { ready, settled } = await renderDocument(
      document.getElementById("doc") as HTMLElement,
      source,
    );
    await frame();
    const interactiveMs = performance.now() - start;
    await ready;
    await frame();
    const totalMs = performance.now() - start;
    await settled;
    await frame();
    const settledMs = performance.now() - start;
    beating = false;
    beat();
    return { interactiveMs, totalMs, settledMs, longestTaskMs };
  },
  async app(files, launch, config = {}) {
    const { backend, state } = fakeBackend(files, launch);
    state.config = { ...state.config, ...config };
    await new Shell(document.getElementById("doc") as HTMLElement, backend).start();
  },
};
