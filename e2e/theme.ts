// The shell over the in-memory core with the all-features fixture open, styled as the app is.
// `?theme=light|dark` is the saved View › Theme; without it, System. `&far` adds a second
// diagram far below the first, `&gantt` a Gantt chart, `&issues` the Mermaid README's
// "Git Issues" chart, `&guide` the user guide instead of the fixture. Built only in `--mode e2e`.
import fixture from "../docs/fixtures/all-features.md?raw";
import svg from "../docs/fixtures/currentcolor.svg?raw";
import readme from "../docs/fixtures/readmes/mermaid.md?raw";
import guide from "../docs/guide.md?raw";
import { fakeBackend } from "../src/ui/fake-backend";
import type { Config } from "../src/ui/ipc";
import { Shell } from "../src/ui/shell";

const DOC = "/fixtures/all-features.md";
const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "system";
const filler = Array.from({ length: 200 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");
const far = "```mermaid\ngraph LR\n  Far --> Below\n```\n";
const gantt =
  "```mermaid\ngantt\n  dateFormat YYYY-MM-DD\n  A task :a1, 2026-01-01, 30d\n  Another :after a1, 20d\n```\n";
let text = params.has("far") ? `${fixture}\n\n${filler}\n\n${far}` : fixture;
if (params.has("guide")) text = guide;
if (params.has("gantt")) text = `${gantt}\n${text}`;
if (params.has("issues"))
  text = `${readme.match(/```mermaid\ngantt\n {4}title Git Issues[^`]*```/)?.[0]}\n${text}`;
const { backend, state } = fakeBackend({ [DOC]: text, "/fixtures/currentcolor.svg": svg }, [DOC]);
state.config.theme = theme as Config["theme"];
void new Shell(document.getElementById("app") as HTMLElement, backend).start();
