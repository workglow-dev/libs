/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { issueTitle } from "./lib/ciAlert";

const SCRIPT = fileURLToPath(new URL("./ci-alert.ts", import.meta.url));
const REPO = "workglow-dev/libs";

interface Request {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

type Route = (req: Request) => { readonly status: number; readonly body: string } | undefined;

/** A GitHub API answering from `route`, recording every request it saw. */
async function fakeGitHub(
  route: Route
): Promise<{ url: string; seen: Request[]; close: () => void }> {
  const seen: Request[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const request = {
        method: req.method ?? "",
        path: req.url ?? "",
        body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(request);
      const answer = route(request) ?? { status: 404, body: "{}" };
      res.writeHead(answer.status).end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

function runScript(
  apiUrl: string,
  eventPath: string
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", [SCRIPT], {
      env: {
        ...process.env,
        GITHUB_API_URL: apiUrl,
        GITHUB_REPOSITORY: REPO,
        GITHUB_TOKEN: "test-token",
        GITHUB_EVENT_PATH: eventPath,
      },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output }));
  });
}

let dir: string | undefined;
let close: (() => void) | undefined;

afterEach(() => {
  close?.();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = close = undefined;
});

describe("ci-alert.ts against the GitHub API", () => {
  // The failed jobs only decorate the issue body. A proxy's HTML 502 on that one
  // call must not stop main's failure from being reported at all.
  it("opens the issue when listing the failed jobs fails", async () => {
    const api = await fakeGitHub(({ method, path }) => {
      if (method === "GET" && path.startsWith(`/repos/${REPO}/issues?`))
        return { status: 200, body: "[]" };
      if (path.includes("/jobs")) return { status: 502, body: "<html>Bad Gateway</html>" };
      if (method === "POST" && path === `/repos/${REPO}/labels`) return { status: 201, body: "{}" };
      if (method === "POST" && path === `/repos/${REPO}/issues`) {
        return { status: 201, body: JSON.stringify({ html_url: "https://example.test/issues/1" }) };
      }
      return undefined;
    });
    close = api.close;
    dir = mkdtempSync(join(tmpdir(), "ci-alert-"));
    const eventPath = join(dir, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        workflow_run: {
          id: 42,
          name: "Build & Test",
          event: "push",
          head_branch: "main",
          head_sha: "abc1234",
          conclusion: "failure",
          html_url: "https://example.test/runs/42",
          run_number: 7,
          run_attempt: 1,
          head_repository: { full_name: REPO },
          repository: { full_name: REPO },
        },
      })
    );

    const { code, output } = await runScript(api.url, eventPath);

    expect(code, output).toBe(0);
    expect(output).toContain("Could not list the failed jobs");
    expect(output).toContain("HTTP 502");
    const opened = api.seen.find((r) => r.method === "POST" && r.path === `/repos/${REPO}/issues`);
    expect(opened?.body).toMatchObject({ title: issueTitle("Build & Test") });
  }, 30_000);
});
