/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatMessage } from "@workglow/ai";
import { bootWebContainer } from "../core/webContainerPort";
import { runSandboxAgent } from "../core/runSandboxAgent";
import { createSandboxTools, listSandboxFiles } from "../core/sandboxTools";
import type { SandboxPort } from "../core/sandboxPort";
import { buildModelConfig, PROVIDER_CHOICES } from "./models";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = $("status");
const log = $("log");
const files = $("files");
const preview = $<HTMLIFrameElement>("preview");
const runButton = $<HTMLButtonElement>("run");
const stopButton = $<HTMLButtonElement>("stop");
const providerSelect = $<HTMLSelectElement>("provider");
const modelInput = $<HTMLInputElement>("model");

function print(line: string): void {
  log.append(document.createTextNode(`${line}\n`));
  log.scrollTop = log.scrollHeight;
}

function syncModelDefault(): void {
  const choice = PROVIDER_CHOICES.find((c) => c.id === providerSelect.value)!;
  modelInput.value = choice.defaultModel;
}
providerSelect.addEventListener("change", syncModelDefault);
syncModelDefault();

async function main(): Promise<void> {
  let port: SandboxPort;
  try {
    ({ port } = await bootWebContainer());
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    return;
  }
  status.textContent = "Sandbox ready.";
  runButton.disabled = false;

  let messages: readonly ChatMessage[] = [];
  let stopper: AbortController | undefined;
  // One set of tools for the page: servers outlive a turn, so the preview stays live
  // across follow-ups. The container goes away with the page.
  const sandboxTools = createSandboxTools(port, {
    onPreview: (url) => {
      preview.src = url;
      print(`preview: ${url}`);
    },
  });

  const refreshFiles = async (): Promise<void> => {
    const { lines, truncated } = await listSandboxFiles(port);
    files.textContent =
      lines.length === 0 ? "(no files yet)" : lines.join("\n") + (truncated ? "\n…" : "");
  };

  runButton.addEventListener("click", async () => {
    const choice = PROVIDER_CHOICES.find((c) => c.id === providerSelect.value)!;
    const apiKey = $<HTMLInputElement>("key").value.trim();
    // Read now: provider and model are one choice, and registering below is async.
    const model = modelInput.value.trim();
    if (apiKey === "") return void (status.textContent = "Enter an API key.");
    runButton.disabled = true;
    providerSelect.disabled = true;
    modelInput.disabled = true;
    stopButton.disabled = false;
    stopper = new AbortController();
    status.textContent = "Working…";
    try {
      await choice.register();
      const result = await runSandboxAgent({
        instruction: $<HTMLTextAreaElement>("prompt").value,
        model: buildModelConfig(choice, model, apiKey),
        sandbox: port,
        sandboxTools,
        messages,
        signal: stopper.signal,
        onEvent: (event) => {
          if (event.type === "tool-call" && event.status === "running") {
            print(`→ ${event.name}`);
          } else if (event.type === "tool-call" && event.status === "completed") {
            void refreshFiles();
          }
        },
      });
      messages = result.messages;
      print(`\n${result.text}\n[${result.stopReason}, ${result.rounds} rounds]`);
      status.textContent = "Done.";
    } catch (error) {
      status.textContent = stopper.signal.aborted ? "Stopped." : "Failed.";
      print(error instanceof Error ? error.message : String(error));
    } finally {
      runButton.disabled = false;
      providerSelect.disabled = false;
      modelInput.disabled = false;
      stopButton.disabled = true;
      await refreshFiles();
    }
  });
  stopButton.addEventListener("click", () => stopper?.abort());
}

void main();
