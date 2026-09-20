/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, measureElement, Text, type DOMElement } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { useCliTheme } from "../CliThemeContext";
import { scrollGutter, stickyRegionHeight, tailScrollOffset } from "../model/runViewport";

/** How often the region re-measures what it is holding. */
const MEASURE_MS = 120;

interface MeasuredSize {
  /** Rows the content wants right now. */
  readonly naturalRows: number;
  /** The most it has ever wanted, within the window it has to live in. */
  readonly heldRows: number;
}

/**
 * A live region that grows to fit its content, never shrinks on its own, and
 * never outgrows the terminal.
 *
 * The no-shrink rule is the point. A block sized to its content drags
 * everything below it — the footer most of all — up the screen every time a
 * list gets shorter, and a run whose footer is a moving target is a run nobody
 * can read while it works. Here the height is a high-water mark: it rises as
 * rows arrive, holds when they leave (the extra rows are simply blank), and
 * comes back down only when the window itself does.
 *
 * The plan sizes the rows to the region, so what is left to clip here is what
 * the plan could not see: a label that wrapped, a subgraph the rows drew before
 * the census walked it. The region gives that back off the top, where the rows
 * are the settled context above each list's window rather than the work in
 * flight inside it, and draws a one-column gutter beside what remains. The
 * gutter costs no rows, which matters most exactly when rows are what ran out.
 */
export function ScrollRegion({
  budgetRows,
  children,
}: {
  /** Rows the region may occupy at most; recomputed by the caller on resize. */
  readonly budgetRows: number;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  const theme = useCliTheme();
  const innerRef = useRef<DOMElement | null>(null);
  const [size, setSize] = useState<MeasuredSize>({ naturalRows: 0, heldRows: 0 });

  // Re-armed when the budget changes so a resize re-measures immediately and
  // the high-water mark is clamped to the window that exists now.
  useEffect(() => {
    const measure = (): void => {
      const node = innerRef.current;
      if (!node) return;
      const naturalRows = measureElement(node).height;
      setSize((prev) => {
        const heldRows = Math.min(Math.max(prev.heldRows, naturalRows), Math.max(0, budgetRows));
        if (prev.naturalRows === naturalRows && prev.heldRows === heldRows) return prev;
        return { naturalRows, heldRows };
      });
    };
    measure();
    const id = setInterval(measure, MEASURE_MS);
    return () => clearInterval(id);
  }, [budgetRows]);

  const height = stickyRegionHeight({ ...size, budgetRows });
  const offset = tailScrollOffset(size.naturalRows, height);
  const clipped = offset > 0;
  const gutter = clipped
    ? scrollGutter({ totalRows: size.naturalRows, visibleRows: height, offsetRows: offset })
    : [];

  const gutterColor = theme.level === "advanced" ? theme.medium : undefined;

  return (
    <Box flexDirection="row" width="100%">
      {clipped && (
        <Box flexDirection="column" flexShrink={0} marginRight={1}>
          {gutter.map((glyph, index) => (
            // Gutter cells are positions in a bar, not identities; the index is
            // the only key they have and the only one they need.
            <Text key={index} color={gutterColor}>
              {glyph}
            </Text>
          ))}
        </Box>
      )}
      <Box
        flexGrow={1}
        minWidth={0}
        flexDirection="column"
        height={height > 0 ? height : undefined}
        overflow="hidden"
      >
        <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={-offset}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}
