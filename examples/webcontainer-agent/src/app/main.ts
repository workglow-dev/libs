/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatMessage } from "@workglow/ai";
import { bootWebContainer } from "../core/webContainerPort";
import { runSandboxAgent } from "../core/runSandboxAgent";
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

async function listTree(port: SandboxPort, dir = ".", prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of [...(await port.readdir(dir))].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    out.push(`${prefix}${entry.name}${entry.isDirectory ? "/" : ""}`);
    if (entry.isDirectory) out.push(...(await listTree(port, path, `${prefix}  `)));
  }
  return out;
}

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
  let dispose: (() => void) | undefined;

  const refreshFiles = async (): Promise<void> => {
    files.textContent = (await listTree(port)).join("\n") || "(no files yet)";
  };

  runButton.addEventListener("click", async () => {
    const choice = PROVIDER_CHOICES.find((c) => c.id === providerSelect.value)!;
    const apiKey = $<HTMLInputElement>("key").value.trim();
    if (apiKey === "") return void (status.textContent = "Enter an API key.");
    runButton.disabled = true;
    stopButton.disabled = false;
    stopper = new AbortController();
    status.textContent = "Working…";
    try {
      await choice.register();
      dispose?.();
      const result = await runSandboxAgent({
        instruction: $<HTMLTextAreaElement>("prompt").value,
        model: buildModelConfig(choice, modelInput.value.trim(), apiKey),
        sandbox: port,
        messages,
        signal: stopper.signal,
        onEvent: (event) => {
          if (event.type === "tool-call" && event.status === "running") {
            print(`→ ${event.name}`);
          } else if (event.type === "tool-call" && event.status === "completed") {
            void refreshFiles();
          } else if (event.type === "preview") {
            preview.src = event.url;
            print(`preview: ${event.url}`);
          }
        },
      });
      messages = result.messages;
      dispose = result.dispose;
      print(`\n${result.text}\n[${result.stopReason}, ${result.rounds} rounds]`);
      status.textContent = "Done.";
    } catch (error) {
      status.textContent = stopper.signal.aborted ? "Stopped." : "Failed.";
      print(error instanceof Error ? error.message : String(error));
    } finally {
      runButton.disabled = false;
      stopButton.disabled = true;
      await refreshFiles();
    }
  });
  stopButton.addEventListener("click", () => stopper?.abort());
}

void main();
