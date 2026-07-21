import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);
const previewRoot = new URL("../app/_sites-preview/", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Aurous onboarding guide", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Aurous — Productivity Resolved<\/title>/i);
  assert.match(html, /Aurous turns your context into a ready-to-use workspace/);
  assert.match(html, /From your context to a working app in four clear steps/);
  assert.match(html, /Apps Aurous sets up/);
  assert.match(html, /Add context\. See everything\. Type <code>apply<\/code>\./);
  assert.match(html, /page IDs, team keys, base IDs, board IDs, schemas, destination selection/);
  assert.match(html, /src="\/aurous-logo\.png"/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Building your site/);
});

test("removes starter-only preview code and leaves the guide interactive", async () => {
  const [page, layout, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /useState/);
  assert.match(page, /navigator\.clipboard/);
  assert.match(page, /selectedTool/);
  assert.match(page, /selectedPreset/);
  assert.match(layout, /title: "Aurous — Productivity Resolved"/);
  assert.match(layout, /og\.png/);
  assert.match(css, /scroll-behavior:smooth/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(previewRoot),
  );
  await assert.rejects(access(new URL("public/_sites-preview", templateRoot)));
});
