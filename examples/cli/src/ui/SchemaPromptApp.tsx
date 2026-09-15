/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import { ConfirmInput, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PromptFieldDescriptor } from "../input/prompt";
import { setNestedValue } from "../util";
import { CliPasswordInput } from "./CliPasswordInput";

interface SchemaPromptAppProps {
  readonly fields: readonly PromptFieldDescriptor[];
  readonly onComplete: (values: Record<string, unknown>) => void;
  readonly onCancel: () => void;
  /**
   * Offered as a third choice when present, and the reason the action row
   * below exists at all: submitting values, refusing to supply any, and walking
   * away undecided are three different answers. Callers that pass nothing here
   * keep the form exactly as it was — fields only, Enter and Esc — so the row
   * appears for the prompts that can actually be refused.
   */
  readonly onDecline?: () => void;
  /** When set, initial keyboard focus starts on this field key (e.g. `"value"` after a CLI pre-filled key). */
  readonly initialFocusedFieldKey?: string;
}

function initialFocusIndexForFields(
  fields: readonly PromptFieldDescriptor[],
  initialFocusedFieldKey: string | undefined
): number {
  if (!initialFocusedFieldKey) {
    return 0;
  }
  const idx = fields.findIndex((f) => f.key === initialFocusedFieldKey);
  return idx >= 0 ? idx : 0;
}

function coercePromptValue(raw: string, field: PromptFieldDescriptor): unknown {
  switch (field.type) {
    case "number":
      return parseFloat(raw);
    case "integer":
      return parseInt(raw, 10);
    case "boolean":
      return raw === "true" || raw === "1";
    case "array":
      try {
        return JSON.parse(raw);
      } catch {
        return raw.split(",").map((s) => s.trim());
      }
    case "object":
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    case "enum":
    case "string":
    default:
      return raw;
  }
}

/**
 * Validate a field value before accepting it.
 * Returns an error message string if invalid, or undefined if valid.
 */
function validateFieldValue(raw: string, field: PromptFieldDescriptor): string | undefined {
  // Required fields cannot be empty
  if (field.required && raw.trim() === "") {
    return `${field.label} is required`;
  }

  // Skip further validation for empty optional fields
  if (raw.trim() === "") return undefined;

  switch (field.type) {
    case "number": {
      const n = parseFloat(raw);
      if (isNaN(n)) return `"${raw}" is not a valid number`;
      return undefined;
    }
    case "integer": {
      const n = parseInt(raw, 10);
      if (isNaN(n)) return `"${raw}" is not a valid integer`;
      if (String(n) !== raw.trim()) return `"${raw}" is not a valid integer`;
      return undefined;
    }
    case "array": {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return `Expected a JSON array, got ${typeof parsed}`;
      } catch {
        // Comma-separated fallback is always valid
      }
      return undefined;
    }
    case "object": {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return `Expected a JSON object`;
        }
      } catch {
        return `Invalid JSON: ${raw}`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function isTextField(field: PromptFieldDescriptor): boolean {
  return field.type !== "enum" && field.type !== "boolean";
}

function formatCompletedFieldValue(
  field: PromptFieldDescriptor,
  rawValue: string | undefined
): string {
  if (field.format === "password" && rawValue !== undefined) {
    return rawValue.length > 0 ? "•".repeat(rawValue.length) : "(empty)";
  }
  return rawValue ?? "";
}

/**
 * What the action row offers, in the order it draws them. No enum, per the
 * repo's TypeScript rules; the labels live beside the row that renders it.
 */
const ACTION_ROW_ITEMS = ["accept", "decline", "cancel"] as const;
const ACTION_ROW_LABELS: Readonly<Record<(typeof ACTION_ROW_ITEMS)[number], string>> = {
  accept: "Submit",
  decline: "Decline",
  cancel: "Cancel",
};

export function SchemaPromptApp({
  fields,
  onComplete,
  onCancel,
  onDecline,
  initialFocusedFieldKey,
}: SchemaPromptAppProps): React.ReactElement {
  // Seed refs with pre-populated defaultValues so untouched fields are included in output
  const { initialValues, initialRaw } = useMemo(() => {
    const values: Record<string, unknown> = {};
    const raw: Record<string, string> = {};
    for (const field of fields) {
      if (field.defaultValue !== undefined && field.defaultValue !== null) {
        const rawStr =
          typeof field.defaultValue === "string"
            ? field.defaultValue
            : JSON.stringify(field.defaultValue);
        setNestedValue(values, field.key, field.defaultValue);
        raw[field.key] = rawStr;
      }
    }
    return { initialValues: values, initialRaw: raw };
  }, [fields]);

  const [focusedIndex, setFocusedIndex] = useState(() =>
    initialFocusIndexForFields(fields, initialFocusedFieldKey)
  );
  const valuesRef = useRef<Record<string, unknown>>(initialValues);
  const rawValuesRef = useRef<Record<string, string>>(initialRaw);
  const [rawValues, setRawValues] = useState<Record<string, string>>(initialRaw);
  const pendingTextRef = useRef("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  // Which of the row's actions is highlighted. Only meaningful while
  // `onActionRow`, and reset to Submit each time the row is entered so a
  // previous visit cannot leave Decline under the next Enter.
  const [actionIndex, setActionIndex] = useState(0);
  const onActionRow = onDecline !== undefined && focusedIndex === fields.length;

  useLayoutEffect(() => {
    const field = fields[focusedIndex];
    if (field && isTextField(field)) {
      pendingTextRef.current = rawValuesRef.current[field.key] ?? "";
    } else {
      pendingTextRef.current = "";
    }
    // Intentionally only focusedIndex: avoid resetting pending input when `fields` gets a new array reference.
  }, [focusedIndex, fields]);

  const saveRawValue = useCallback((key: string, raw: string) => {
    rawValuesRef.current[key] = raw;
    setRawValues((prev) => ({ ...prev, [key]: raw }));
  }, []);

  const submitForm = useCallback(() => {
    // Save the currently focused field before submitting
    const currentField = fields[focusedIndex];
    if (currentField && isTextField(currentField) && pendingTextRef.current) {
      const error = validateFieldValue(pendingTextRef.current, currentField);
      if (error) {
        setFieldError(error);
        return;
      }
      const coerced = coercePromptValue(pendingTextRef.current, currentField);
      setNestedValue(valuesRef.current, currentField.key, coerced);
      saveRawValue(currentField.key, pendingTextRef.current);
    }

    // Validate all required fields before submitting
    for (const field of fields) {
      const raw = rawValuesRef.current[field.key];
      if (field.required && (raw === undefined || raw.trim() === "")) {
        setFieldError(`${field.label} is required`);
        const idx = fields.indexOf(field);
        if (idx >= 0) {
          pendingTextRef.current = rawValuesRef.current[field.key] ?? "";
          setFocusedIndex(idx);
        }
        return;
      }
    }

    onComplete(valuesRef.current);
  }, [fields, focusedIndex, onComplete, saveRawValue]);

  const handleFieldSubmit = useCallback(
    (raw: string, field: PromptFieldDescriptor) => {
      const error = validateFieldValue(raw, field);
      if (error) {
        setFieldError(error);
        return;
      }
      setFieldError(undefined);

      const coerced = coercePromptValue(raw, field);
      setNestedValue(valuesRef.current, field.key, coerced);
      saveRawValue(field.key, raw);
      pendingTextRef.current = "";

      submitForm();
    },
    [saveRawValue, submitForm]
  );

  const navigateBy = useCallback(
    (direction: number) => {
      const currentField = fields[focusedIndex];

      // Save pending text value when leaving a text field. Guarded on the field
      // rather than returning early, because `focusedIndex` also addresses the
      // action row, which is one past the last field and has no value to save.
      if (currentField && isTextField(currentField) && pendingTextRef.current) {
        const coerced = coercePromptValue(pendingTextRef.current, currentField);
        setNestedValue(valuesRef.current, currentField.key, coerced);
        saveRawValue(currentField.key, pendingTextRef.current);
      }

      const lastIndex = onDecline ? fields.length : fields.length - 1;
      const newIndex = focusedIndex + direction;
      if (newIndex >= 0 && newIndex <= lastIndex) {
        setFieldError(undefined);
        const nextField = fields[newIndex];
        pendingTextRef.current = nextField ? (rawValuesRef.current[nextField.key] ?? "") : "";
        if (nextField === undefined) setActionIndex(0);
        setFocusedIndex(newIndex);
      }
    },
    [focusedIndex, fields, onDecline, saveRawValue]
  );

  useInput((_input, key) => {
    // The action row sits one past the last field. Handled before the field
    // guard below, which would otherwise return early and leave the row inert.
    if (onActionRow) {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        const chosen = ACTION_ROW_ITEMS[actionIndex];
        if (chosen === "accept") submitForm();
        else if (chosen === "decline") onDecline?.();
        else onCancel();
        return;
      }
      if (key.rightArrow || (key.tab && !key.shift)) {
        setActionIndex((i) => Math.min(i + 1, ACTION_ROW_ITEMS.length - 1));
        return;
      }
      if (key.leftArrow) {
        setActionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      // Back to the fields: from the first action, or on Shift+Tab / Up from
      // anywhere in the row, since the row is a dead end otherwise.
      if (key.upArrow || (key.tab && key.shift)) {
        navigateBy(-1);
        return;
      }
      return;
    }

    const currentField = fields[focusedIndex];
    if (!currentField) return;

    const isSelect = currentField.type === "enum";

    // Tab / Shift+Tab always navigate
    if (key.tab && !key.shift) {
      navigateBy(1);
      return;
    }
    if (key.tab && key.shift) {
      navigateBy(-1);
      return;
    }

    // Up/Down navigate between fields (except on Select, which uses them for options)
    if (key.downArrow && !isSelect) {
      navigateBy(1);
      return;
    }
    if (key.upArrow && !isSelect) {
      navigateBy(-1);
      return;
    }

    // Escape cancels the form
    if (key.escape) {
      onCancel();
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Fill in the fields below
        </Text>
        <Text dimColor>
          {" "}
          {"\u2014"} Tab/arrows to navigate, Enter to submit, Esc to cancel
          {onDecline ? ", Tab past the last field to decline" : ""}
        </Text>
      </Box>

      {fields.map((field, index) => {
        const isFocused = index === focusedIndex;
        const rawValue = rawValues[field.key];
        const isCompleted = rawValue !== undefined;

        return (
          <Box key={field.key} flexDirection="column">
            <Box>
              <Text color={isFocused ? "cyan" : isCompleted ? "green" : "gray"}>
                {isFocused ? "\u25B8 " : isCompleted ? "\u2713 " : "\u25CB "}
              </Text>
              <Text bold={isFocused} dimColor={!isFocused && !isCompleted}>
                {field.label}
              </Text>
              {field.required && isFocused && (
                <>
                  <Text> </Text>
                  <Text color="red">(required)</Text>
                </>
              )}
              {!isFocused && isCompleted && (
                <Text color="green"> = {formatCompletedFieldValue(field, rawValue)}</Text>
              )}
              {!isFocused && !isCompleted && <Text dimColor> {"\u2014"}</Text>}
            </Box>

            {isFocused && field.description && (
              <Box marginLeft={2}>
                <Text dimColor>{field.description}</Text>
              </Box>
            )}

            {isFocused && (
              <Box marginLeft={2}>
                <FieldWidget
                  field={field}
                  previousValue={rawValue}
                  onSubmit={(raw) => handleFieldSubmit(raw, field)}
                  onTextChange={(value) => {
                    pendingTextRef.current = value;
                    if (fieldError) setFieldError(undefined);
                  }}
                  onNavigate={(dir) => navigateBy(dir)}
                />
              </Box>
            )}

            {isFocused && fieldError && (
              <Box marginLeft={2}>
                <Text color="red">{fieldError}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {onDecline ? (
        <Box marginTop={1}>
          {ACTION_ROW_ITEMS.map((item, index) => {
            const selected = onActionRow && index === actionIndex;
            return (
              <Box key={item} marginRight={2}>
                <Text color={selected ? "cyan" : undefined} bold={selected} dimColor={!onActionRow}>
                  {selected ? "\u25B8 " : "  "}
                  {ACTION_ROW_LABELS[item]}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {onActionRow
            ? "Left/right to choose, Enter to confirm, Esc to cancel"
            : `Field ${focusedIndex + 1} of ${fields.length}`}
        </Text>
      </Box>
    </Box>
  );
}

interface FieldWidgetProps {
  readonly field: PromptFieldDescriptor;
  readonly previousValue: string | undefined;
  readonly onSubmit: (value: string) => void;
  readonly onTextChange: (value: string) => void;
  readonly onNavigate?: (direction: 1 | -1) => void;
}

function InlineSelect({
  options,
  defaultValue,
  onChange,
  onOverflow,
}: {
  readonly options: readonly string[];
  readonly defaultValue: string | undefined;
  readonly onChange: (value: string) => void;
  readonly onOverflow?: (direction: 1 | -1) => void;
}): React.ReactElement {
  const initialIndex = defaultValue ? Math.max(0, options.indexOf(defaultValue)) : 0;
  const [focusedIndex, setFocusedIndex] = useState(initialIndex);

  useInput((_input, key) => {
    if (key.upArrow) {
      if (focusedIndex === 0) {
        onOverflow?.(-1);
      } else {
        setFocusedIndex((i) => i - 1);
      }
    } else if (key.downArrow) {
      if (focusedIndex === options.length - 1) {
        onOverflow?.(1);
      } else {
        setFocusedIndex((i) => i + 1);
      }
    } else if (key.return) {
      onChange(options[focusedIndex]!);
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((option, index) => {
        const isFocused = index === focusedIndex;
        return (
          <Box key={option}>
            <Text color={isFocused ? "cyan" : undefined}>
              {isFocused ? "\u276F " : "  "}
              {option}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function FieldWidget({
  field,
  previousValue,
  onSubmit,
  onTextChange,
  onNavigate,
}: FieldWidgetProps): React.ReactElement {
  if (field.type === "enum" && field.enumValues) {
    return (
      <InlineSelect
        options={field.enumValues}
        defaultValue={previousValue}
        onChange={(value) => onSubmit(value)}
        onOverflow={onNavigate}
      />
    );
  }

  if (field.type === "boolean") {
    return (
      <Box>
        <Text dimColor>(y/n) </Text>
        <ConfirmInput
          defaultChoice={previousValue === "false" ? "cancel" : "confirm"}
          onConfirm={() => onSubmit("true")}
          onCancel={() => onSubmit("false")}
        />
      </Box>
    );
  }

  const placeholder =
    field.type === "array"
      ? "JSON array or comma-separated"
      : field.type === "object"
        ? "JSON object"
        : undefined;

  if (field.format === "password") {
    const initial =
      previousValue ?? (field.defaultValue !== undefined ? asText(field.defaultValue) : "");
    return (
      <CliPasswordInput
        defaultValue={initial}
        placeholder={placeholder}
        onChange={onTextChange}
        onSubmit={onSubmit}
      />
    );
  }

  return (
    <TextInput
      placeholder={placeholder}
      defaultValue={
        previousValue ?? (field.defaultValue !== undefined ? asText(field.defaultValue) : undefined)
      }
      onChange={onTextChange}
      onSubmit={onSubmit}
    />
  );
}
