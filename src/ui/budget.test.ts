import { describe, expect, it } from "vitest";
import { actions, barButtons, menus, settings } from "./definition";
import { fakeBackend } from "./fake-backend";
import { Shell } from "./shell";

// Vite reads these options statically, so they are spelled out twice.
const sources: Record<string, string> = import.meta.glob(["../**/*.ts", "!../**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const capabilities: Record<string, string> = import.meta.glob(
  "../../src-tauri/capabilities/*.json",
  { query: "?raw", import: "default", eager: true },
);

describe("simplicity budget (D-11)", () => {
  it("test_ui_definition_within_simplicity_budget", () => {
    const toolbarButtons = barButtons().length;
    // Nine since the page-width toggle beside zoom, at the owner's request.
    expect(toolbarButtons).toBeLessThanOrEqual(9);
    // Five since Settings › Language, at the owner's request.
    expect(settings.length).toBeLessThanOrEqual(5);
    expect(menus.length).toBeLessThanOrEqual(4);

    // The shell draws exactly what the definition says.
    const root = document.createElement("div");
    new Shell(root, fakeBackend({}).backend).dispose();
    expect(root.querySelectorAll(".bar .bar-button")).toHaveLength(toolbarButtons);
    expect(root.querySelectorAll(".bar")).toHaveLength(1);

    // Dialogs while reading: only Open, Export (D-20) and Print show one, and only when asked for.
    const dialogs = Object.values(actions).filter((a) => a.dialog);
    const whileReading = dialogs.filter((a) => !["open", "export", "print"].includes(a.id));
    expect(whileReading).toEqual([]);
    // Nothing else in the frontend can raise one: no alert/confirm/prompt, no dialog plugin.
    const raising = Object.keys(sources).filter((f) =>
      /\b(alert|confirm|prompt)\s*\(|plugin-dialog/.test(sources[f]),
    );
    expect(raising).toEqual([]);
    expect(Object.keys(capabilities).length).toBeGreaterThan(0);
    for (const caps of Object.values(capabilities)) expect(caps).not.toMatch(/dialog/);
  });
});
