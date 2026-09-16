/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { A2UIComponent, A2UIServerMessage } from "./messages";
import { applyDataModelPatch } from "./dataModel";

/** The id every surface's component tree is rooted at. */
export const A2UI_ROOT_COMPONENT_ID = "root";

/** One surface, as the accumulated effect of every message naming it. */
export type A2UISurfaceState = {
  readonly surfaceId: string;
  readonly catalogId: string;
  readonly theme: Record<string, unknown> | undefined;
  readonly sendDataModel: boolean;
  /** Components by id. A later definition of an id replaces the earlier one. */
  readonly components: ReadonlyMap<string, A2UIComponent>;
  readonly dataModel: Readonly<Record<string, unknown>>;
};

/**
 * Folds a message stream into the surfaces it describes.
 *
 * A renderer keeps this state itself; this exists for everything that is not a
 * renderer — a test asserting what an agent drew, a transcript replaying a
 * conversation, a host deciding whether a batch is worth showing at all. It is
 * deliberately the same fold the protocol specifies rather than an
 * approximation, so what it reports is what a conforming renderer would show.
 *
 * Messages naming a surface that was never created are skipped rather than
 * thrown on: {@link validateServerMessages} is where that batch is refused, and
 * a fold that also threw would make every caller handle the same failure twice.
 */
export function foldSurfaces(
  messages: Iterable<A2UIServerMessage>,
  initial: Iterable<A2UISurfaceState> = []
): ReadonlyMap<string, A2UISurfaceState> {
  const surfaces = new Map<string, A2UISurfaceState>();
  for (const surface of initial) surfaces.set(surface.surfaceId, surface);

  for (const message of messages) {
    if ("createSurface" in message) {
      const { surfaceId, catalogId, theme, sendDataModel } = message.createSurface;
      surfaces.set(surfaceId, {
        surfaceId,
        catalogId,
        theme,
        sendDataModel: sendDataModel === true,
        components: new Map(),
        dataModel: {},
      });
      continue;
    }
    if ("deleteSurface" in message) {
      surfaces.delete(message.deleteSurface.surfaceId);
      continue;
    }
    if ("updateComponents" in message) {
      const { surfaceId, components } = message.updateComponents;
      const surface = surfaces.get(surfaceId);
      if (!surface) continue;
      const next = new Map(surface.components);
      for (const component of components) next.set(component.id, component);
      surfaces.set(surfaceId, { ...surface, components: next });
      continue;
    }
    const { surfaceId, path } = message.updateDataModel;
    const surface = surfaces.get(surfaceId);
    if (!surface) continue;
    const hasValue = "value" in message.updateDataModel;
    surfaces.set(surfaceId, {
      ...surface,
      dataModel: applyDataModelPatch(
        surface.dataModel,
        path,
        message.updateDataModel.value,
        hasValue
      ),
    });
  }
  return surfaces;
}
