/** @jsxImportSource preact */
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JSX, TargetedKeyboardEvent, TargetedPointerEvent } from "preact";
import { useCallback, useState } from "preact/hooks";
import { clampRailWidth, RAIL_DEFAULTS, type RailSide } from "../railWidths";

/** How far one arrow key moves a rail; Shift makes it a coarse move. */
const STEP = 16;
const STEP_COARSE = 64;

export interface RailResizerProps {
  readonly side: RailSide;
  /** Current width of the rail this handle drags. */
  readonly width: number;
  /** Width of the OTHER rail, which is part of what bounds this one. */
  readonly otherWidth: number;
  readonly onResize: (width: number) => void;
}

/** Where a drag started: the pointer's x and the width the rail had then. */
interface DragOrigin {
  readonly x: number;
  readonly width: number;
}

/**
 * The draggable seam between a rail and the centre column.
 *
 * Positioned against `.app` rather than parented to the rail: the status rail
 * scrolls, and an absolutely positioned child of a scrollport rides its
 * content instead of standing still at the edge.
 *
 * It is a `separator` with a value, so the keyboard gets the same range the
 * pointer does — a resize that only exists under a mouse is a resize half the
 * operators cannot make.
 */
export function RailResizer({ side, width, otherWidth, onResize }: RailResizerProps): JSX.Element {
  const [drag, setDrag] = useState<DragOrigin | undefined>(undefined);

  const apply = useCallback(
    (next: number) => {
      onResize(clampRailWidth(side, next, window.innerWidth, otherWidth));
    },
    [onResize, otherWidth, side]
  );

  const onPointerDown = useCallback(
    (event: TargetedPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      // The second press of a double-click restores the default width, the way
      // a split view does. Read off `detail` because Preact has no
      // double-click prop that survives its lowercase event names.
      if (event.detail === 2) {
        apply(RAIL_DEFAULTS[side]);
        return;
      }
      // Capture so the drag keeps tracking once the pointer leaves the 9px
      // handle, which it does immediately.
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ x: event.clientX, width });
    },
    [apply, side, width]
  );

  const onPointerMove = useCallback(
    (event: TargetedPointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      const delta = event.clientX - drag.x;
      // The right rail grows as the pointer moves LEFT: it is anchored to the
      // window edge, so its width runs opposite the axis.
      apply(drag.width + (side === "left" ? delta : -delta));
    },
    [apply, drag, side]
  );

  const endDrag = useCallback((event: TargetedPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(undefined);
  }, []);

  const onKeyDown = useCallback(
    (event: TargetedKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? STEP_COARSE : STEP;
      // Arrow keys move the SEAM, not the rail: left always takes space from
      // whatever is to its left, which for the status rail means growing it.
      const towardRail = side === "left" ? 1 : -1;
      if (event.key === "ArrowLeft") apply(width - step * towardRail);
      else if (event.key === "ArrowRight") apply(width + step * towardRail);
      else if (event.key === "Home" || event.key === "End") apply(RAIL_DEFAULTS[side]);
      else return;
      event.preventDefault();
    },
    [apply, side, width]
  );

  return (
    <div
      className={`resizer resizer-${side === "left" ? "l" : "r"}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side === "left" ? "commands" : "status"} panel`}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      data-dragging={drag ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
