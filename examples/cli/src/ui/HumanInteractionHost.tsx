/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IHumanRequest, IHumanResponse } from "@workglow/util";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { setCliHumanInteractionEnqueue } from "../cliHumanBridge";
import { prepareSchemaFormFields, type PromptFieldDescriptor } from "../input/prompt";
import { deepMerge } from "../input/resolve-input";
import { SchemaPromptApp } from "./SchemaPromptApp";
import { asDataPortSchemaObject } from "./humanSchema";
import { humanPromptModel } from "@workglow/util";

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

function HumanPressEnterRow({
  request,
  onFinish,
}: {
  readonly request: IHumanRequest;
  readonly onFinish: (r: IHumanResponse) => void;
}): React.ReactElement {
  useInput((_input, key) => {
    if (key.return) {
      onFinish({
        requestId: request.requestId,
        action: "accept",
        content: undefined,
        done: true,
      });
    }
    if (key.escape) {
      onFinish({
        requestId: request.requestId,
        action: "cancel",
        content: undefined,
        done: true,
      });
    }
  });

  return <Text dimColor>Enter to continue · Esc to cancel</Text>;
}

function HumanNotifyPanel({
  request,
  onFinish,
}: {
  readonly request: IHumanRequest;
  readonly onFinish: (r: IHumanResponse) => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold color="cyan">
        Notice
      </Text>
      {request.message ? <Text>{request.message}</Text> : null}
      <HumanPressEnterRow request={request} onFinish={onFinish} />
    </Box>
  );
}

function HumanDisplayPanel({
  request,
  onFinish,
}: {
  readonly request: IHumanRequest;
  readonly onFinish: (r: IHumanResponse) => void;
}): React.ReactElement {
  const payload =
    request.contentData !== undefined && Object.keys(request.contentData).length > 0
      ? JSON.stringify(request.contentData, null, 2)
      : "";

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="blue" padding={1}>
      <Text bold color="blue">
        Display
      </Text>
      {request.message ? <Text>{request.message}</Text> : null}
      {payload ? <Text>{payload}</Text> : null}
      <HumanPressEnterRow request={request} onFinish={onFinish} />
    </Box>
  );
}

function HumanConfirmPanel({
  request,
  onFinish,
}: {
  readonly request: IHumanRequest;
  readonly onFinish: (r: IHumanResponse) => void;
}): React.ReactElement {
  const model = humanPromptModel({
    kind: request.kind,
    message: request.message,
    schema: request.contentSchema,
    data: request.contentData,
  });

  useInput((input, key) => {
    const answer = (action: IHumanResponse["action"]): void =>
      onFinish({ requestId: request.requestId, action, content: undefined, done: true });
    const typed = input.toLowerCase();
    if (typed === "y" || key.return) {
      answer("accept");
    } else if (typed === "n") {
      answer("decline");
    } else if (key.escape) {
      answer("cancel");
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="double" borderColor="yellow" padding={1}>
      <Text bold color="yellow">
        {model.title}
      </Text>
      {model.message ? <Text>{model.message}</Text> : null}
      {model.details.map((detail) => (
        <Text key={detail.label}>
          <Text dimColor>{detail.label}: </Text>
          {detail.value}
        </Text>
      ))}
      <Text dimColor>y/Enter to approve · n to decline · Esc to cancel</Text>
    </Box>
  );
}

function HumanElicitPanel({
  request,
  onFinish,
}: {
  readonly request: IHumanRequest;
  readonly onFinish: (r: IHumanResponse) => void;
}): React.ReactElement {
  const [fields, setFields] = useState<PromptFieldDescriptor[] | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const schema = asDataPortSchemaObject(request.contentSchema);
        const base = (request.contentData as Record<string, unknown> | undefined) ?? {};
        const f = await prepareSchemaFormFields(base, schema);
        if (!cancelled) {
          setFields(f);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  if (loadError !== undefined) {
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">Form error: {loadError}</Text>
        <HumanPressEnterRow
          request={request}
          onFinish={(response) => {
            onFinish({
              requestId: response.requestId,
              action: "cancel",
              content: undefined,
              done: true,
            });
          }}
        />
      </Box>
    );
  }

  if (fields === null) {
    return (
      <Box marginTop={1} padding={1}>
        <Text dimColor>Loading form…</Text>
      </Box>
    );
  }

  if (fields.length === 0) {
    return (
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="double"
        borderColor="magenta"
        padding={1}
      >
        <Text bold color="magenta">
          Input required
        </Text>
        {request.message ? <Text>{request.message}</Text> : null}
        <HumanPressEnterRow
          request={request}
          onFinish={(r) => {
            if (r.action === "accept") {
              onFinish({
                requestId: request.requestId,
                action: "accept",
                content: {},
                done: true,
              });
            } else {
              onFinish(r);
            }
          }}
        />
      </Box>
    );
  }

  const baseData = (request.contentData as Record<string, unknown> | undefined) ?? {};

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="double"
      borderColor="magenta"
      padding={1}
    >
      <Text bold color="magenta">
        Input required
      </Text>
      {request.message ? <Text>{request.message}</Text> : null}
      <SchemaPromptApp
        fields={fields}
        onComplete={(values) => {
          const merged = deepMerge(baseData, values);
          onFinish({
            requestId: request.requestId,
            action: "accept",
            content: merged,
            done: true,
          });
        }}
        onCancel={() => {
          onFinish({
            requestId: request.requestId,
            action: "cancel",
            content: undefined,
            done: true,
          });
        }}
      />
    </Box>
  );
}

function HumanInteractionPanel({
  request,
  onFinish,
}: {
  readonly request: IHumanRequest;
  readonly onFinish: (r: IHumanResponse) => void;
}): React.ReactElement {
  switch (request.kind) {
    case "notify":
      return <HumanNotifyPanel request={request} onFinish={onFinish} />;
    case "display":
      return <HumanDisplayPanel request={request} onFinish={onFinish} />;
    case "elicit":
      return <HumanElicitPanel request={request} onFinish={onFinish} />;
    case "confirm":
      return <HumanConfirmPanel request={request} onFinish={onFinish} />;
    default:
      return <HumanElicitPanel request={request} onFinish={onFinish} />;
  }
}

interface HumanInteractionHostProps {
  readonly children: ReactNode;
}

/**
 * Bridges {@link InkHumanConnector} into this Ink tree so human elicit/notify/display use the same UI stack as workflow progress.
 */
export function HumanInteractionHost({ children }: HumanInteractionHostProps): React.ReactElement {
  const [queue, setQueue] = useState<IHumanRequest[]>([]);
  const pendingRef = useRef(
    new Map<
      string,
      {
        resolve: (r: IHumanResponse) => void;
        reject: (e: Error) => void;
        detachAbort: () => void;
      }
    >()
  );

  const removeFromQueue = (rid: string): void => {
    setQueue((prev) => prev.filter((r) => r.requestId !== rid));
  };

  useLayoutEffect(() => {
    const pending = pendingRef.current;

    setCliHumanInteractionEnqueue((request, signal) => {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(abortError());
          return;
        }

        const rid = request.requestId;
        const onAbort = () => {
          const p = pendingRef.current.get(rid);
          if (p) {
            p.reject(abortError());
          }
        };

        signal.addEventListener("abort", onAbort);

        const detachAbort = () => signal.removeEventListener("abort", onAbort);

        pendingRef.current.set(rid, {
          resolve: (r: IHumanResponse) => {
            detachAbort();
            pendingRef.current.delete(rid);
            removeFromQueue(rid);
            resolve(r);
          },
          reject: (e: Error) => {
            detachAbort();
            pendingRef.current.delete(rid);
            removeFromQueue(rid);
            reject(e);
          },
          detachAbort,
        });

        setQueue((prev) => [...prev, request]);
      });
    });

    return () => {
      setCliHumanInteractionEnqueue(undefined);
      for (const [, p] of pending) {
        p.detachAbort();
        p.reject(new Error("CLI human UI unmounted"));
      }
      pending.clear();
    };
  }, []);

  const complete = (requestId: string, response: IHumanResponse): void => {
    const p = pendingRef.current.get(requestId);
    if (p) {
      p.resolve(response);
    }
  };

  const activeRequest = queue[0] ?? null;

  return (
    <Box flexDirection="column">
      {children}
      {activeRequest !== null && (
        <HumanInteractionPanel
          request={activeRequest}
          onFinish={(r) => complete(activeRequest.requestId, r)}
        />
      )}
    </Box>
  );
}
