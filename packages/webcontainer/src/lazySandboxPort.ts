/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SandboxPort } from "./sandboxPort";

/**
 * A {@link SandboxPort} that boots the real one on first use.
 *
 * The tools have to be described to a model before anything has run, and
 * booting a WebContainer loads a runtime from the network and takes seconds.
 * Tools built over this port can be listed up front and cost nothing until the
 * model actually calls one. A failed boot is not remembered: the next call
 * tries again, so a transient network failure does not poison the page.
 */
export function lazySandboxPort(boot: () => Promise<SandboxPort>): SandboxPort {
  let booted: Promise<SandboxPort> | undefined;
  const real = (): Promise<SandboxPort> => {
    booted ??= boot().catch((error: unknown) => {
      booted = undefined;
      throw error;
    });
    return booted;
  };
  return {
    readFile: async (path) => (await real()).readFile(path),
    writeFile: async (path, content) => (await real()).writeFile(path, content),
    mkdir: async (path) => (await real()).mkdir(path),
    readdir: async (path) => (await real()).readdir(path),
    spawn: async (command, args) => (await real()).spawn(command, args),
    onServerReady: (listener) => {
      // Subscribed once the container exists; unsubscribing before then cancels it.
      let off: (() => void) | undefined;
      let cancelled = false;
      void real().then(
        (port) => {
          if (cancelled) return;
          off = port.onServerReady(listener);
        },
        () => {}
      );
      return () => {
        cancelled = true;
        off?.();
      };
    },
  };
}
