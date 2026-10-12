/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from "ink";
import React from "react";
import { STREAM_PANEL_MAX_LINES, tailLines } from "../model/streamedText";

interface StreamedReasoningProps {
  readonly reasoning: string;
  /** Total height including the label; the thinking itself gets one line fewer. */
  readonly maxLines?: number;
}

/**
 * A model's thinking, drawn dim under a "thinking" label so it cannot be
 * mistaken for the answer. Bounded to `maxLines` rows like the answer panel.
 */
export function StreamedReasoning({
  reasoning,
  maxLines = STREAM_PANEL_MAX_LINES,
}: StreamedReasoningProps): React.ReactElement | null {
  if (!reasoning) return null;
  return (
    <Box flexDirection="column">
      <Text dimColor italic>
        thinking
      </Text>
      <Text dimColor>{tailLines(reasoning, Math.max(1, maxLines - 1))}</Text>
    </Box>
  );
}
