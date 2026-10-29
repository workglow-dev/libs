/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import type { SandboxPort } from "./sandboxPort";

export interface BootWebContainerOptions {
  /**
   * Cross-origin embedder policy the page was served with. The container's
   * preview frames must match the page, so this has to agree with the header.
   * `credentialless` is the gentler one for an app that loads third-party
   * resources it does not control; it is not supported by Safari.
   */
  readonly coep?: "require-corp" | "credentialless" | undefined;
  /** Files to mount in the project directory before returning. */
  readonly files?: FileSystemTree | undefined;
}

/**
 * Boots the page's WebContainer. A page can hold one, and booting needs the
 * page to be cross-origin isolated (`Cross-Origin-Embedder-Policy`
 * and `Cross-Origin-Opener-Policy: same-origin`), because the
 * container is built on SharedArrayBuffer.
 *
 * The API is imported here and nowhere else in `core`, so the tools and the
 * runner can be loaded, and tested, without it.
 */
export async function bootWebContainer(
  options: BootWebContainerOptions = {}
): Promise<{ readonly container: WebContainer; readonly port: SandboxPort }> {
  if (typeof crossOriginIsolated !== "undefined" && !crossOriginIsolated) {
    throw new Error(
      "This page is not cross-origin isolated, so a WebContainer cannot boot. Serve it with " +
        "Cross-Origin-Embedder-Policy (require-corp or credentialless) and " +
        "Cross-Origin-Opener-Policy: same-origin."
    );
  }
  const { WebContainer } = await import("@webcontainer/api");
  const container = await WebContainer.boot({ coep: options.coep ?? "require-corp" });
  if (options.files !== undefined) await container.mount(options.files);
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
