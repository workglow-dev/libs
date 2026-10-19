/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import type { SandboxPort } from "./sandboxPort";

/**
 * Boots the page's WebContainer. A page can hold one, and booting needs the
 * page to be cross-origin isolated (`Cross-Origin-Embedder-Policy:
 * require-corp` and `Cross-Origin-Opener-Policy: same-origin`), because the
 * container is built on SharedArrayBuffer.
 *
 * The API is imported here and nowhere else in `core`, so the tools and the
 * runner can be loaded, and tested, without it.
 */
export async function bootWebContainer(
  files?: FileSystemTree
): Promise<{ readonly container: WebContainer; readonly port: SandboxPort }> {
  if (typeof crossOriginIsolated !== "undefined" && !crossOriginIsolated) {
    throw new Error(
      "This page is not cross-origin isolated, so a WebContainer cannot boot. Serve it with " +
        "Cross-Origin-Embedder-Policy: require-corp and Cross-Origin-Opener-Policy: same-origin."
    );
  }
  const { WebContainer } = await import("@webcontainer/api");
  const container = await WebContainer.boot({ coep: "require-corp" });
  if (files !== undefined) await container.mount(files);
  return { container, port: webContainerPort(container) };
}

/** Adapts a booted WebContainer to the slice of it the tools use. */
export function webContainerPort(container: WebContainer): SandboxPort {
  return {
    readFile: (path) => container.fs.readFile(path, "utf-8"),
    writeFile: (path, content) => container.fs.writeFile(path, content),
    mkdir: async (path) => {
      await container.fs.mkdir(path, { recursive: true });
    },
    readdir: async (path) => {
      const entries = await container.fs.readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
    },
    spawn: async (command, args) => {
      const process = await container.spawn(command, [...args]);
      return { output: process.output, exit: process.exit, kill: () => process.kill() };
    },
    onServerReady: (listener) => container.on("server-ready", listener),
  };
}
