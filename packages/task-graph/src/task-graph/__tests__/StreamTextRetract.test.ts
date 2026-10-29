/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `text-retract` takes back the tail of a port's streamed text. The processor
 * truncates its accumulator, gives up a cache sink it can no longer keep
 * honest, and the pump carries the retraction down the edge of its own port
 * only, so a consumer folding that port truncates too.
 */

import type { IExecuteContext, StreamEvent, StreamSink, TaskOutput } from "@workglow/task-graph";
import {
  Dataflow,
  isCacheRef,
  makeCacheRef,
  retractionLength,
  retractText,
  Task,
  TaskError,
  TaskGraph,
  TaskGraphRunner,
  TaskRegistry,
} from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { beforeAll, describe, expect, it } from "vitest";

type TextOut = { text: string };

const TEXT_SCHEMA = {
  type: "object",
  properties: { text: { type: "string", "x-stream": "append" } },
  additionalProperties: false,
} as const satisfies DataPortSchema;

/** Streams the events it was constructed with, verbatim. */
class ScriptedTextTask extends Task<Record<string, never>, TextOut> {
  public static override type = "StreamTextRetractTest_Scripted";
  public static override category = "Test";
  public static override cacheable = false;
  public script: readonly StreamEvent<TextOut>[] = [];

  public static override outputSchema(): DataPortSchema {
    return TEXT_SCHEMA;
  }

  async *executeStream(): AsyncIterable<StreamEvent<TextOut>> {
    for (const event of this.script) yield event;
  }
}

beforeAll(() => {
  TaskRegistry.registerTask(ScriptedTextTask as any);
});

const delta = (textDelta: string, port = "text"): StreamEvent<any> => ({
  type: "text-delta",
  port,
  textDelta,
});
const retract = (length: number, port = "text"): StreamEvent<any> => ({
  type: "text-retract",
  port,
  length,
});
const FINISH: StreamEvent<any> = { type: "finish", data: {} };

/** Folds a port's text the way every consumer of the event does. */
function fold(events: readonly StreamEvent[], port: string): string {
  let text = "";
  for (const event of events) {
    if (event.type === "text-delta" && event.port === port) text += event.textDelta;
    else if (event.type === "text-retract" && event.port === port) {
      text = retractText(text, event.length);
    }
  }
  return text;
}

function makeSink(): { sink: StreamSink; settled: Promise<"written" | Error> } {
  let settle: (v: "written" | Error) => void = () => {};
  const settled = new Promise<"written" | Error>((resolve) => {
    settle = resolve;
  });
  const sink: StreamSink = {
    mode: "append",
    write: async (chunks) => {
      try {
        for await (const _ of chunks) {
          // drain
        }
      } catch (err) {
        settle(err as Error);
        throw err;
      }
      settle("written");
      return makeCacheRef({ $ref: "inmem://retract/text", port: "text", mode: "append", size: 0 });
    },
  };
  return { sink, settled };
}

async function runProcessor(
  task: ScriptedTextTask,
  options: { shouldAccumulate: boolean; refSinks?: ReadonlyMap<string, StreamSink> }
): Promise<TextOut> {
  const processor = (task as any).runner.streamProcessor as {
    run(input: any, ctx: any, deps: any): Promise<TextOut | undefined>;
  };
  const ctx = {
    abortController: new AbortController(),
    shouldAccumulate: options.shouldAccumulate,
    registry: undefined,
    runOutputData: {},
    dispose: () => {},
  } as any;
  return (await processor.run({}, ctx, {
    registry: undefined as any,
    resourceScope: undefined,
    inputStreams: undefined,
    onProgress: async () => {},
    own: <T>(t: T) => t,
    refSinks: options.refSinks,
  })) as TextOut;
}

describe("retractText", () => {
  it("drops the tail, clamps at the start, and ignores a non-positive length", () => {
    expect(retractText("Hello there", 5)).toBe("Hello ");
    expect(retractText("Hi", 10)).toBe("");
    expect(retractText("Hi", 0)).toBe("Hi");
    expect(retractText("Hi", -3)).toBe("Hi");
  });

  it("removes a whole number of characters: a fraction rounds down and NaN removes nothing", () => {
    expect(retractionLength(1.5)).toBe(1);
    expect(retractText("Pabc", 1.5)).toBe("Pab");
    expect(retractionLength(Number.NaN)).toBe(0);
    expect(retractText("Hi", Number.NaN)).toBe("Hi");
    expect(retractText("Hi", Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("StreamProcessor — text-retract", () => {
  it("truncates the accumulated port, so later deltas append after what remains", async () => {
    const task = new ScriptedTextTask();
    task.script = [delta("Hello "), delta("there"), retract(5), delta("world"), FINISH];
    const chunks: StreamEvent[] = [];
    task.on("stream_chunk", (event: StreamEvent) => chunks.push(event));

    const output = await task.run({});

    expect(output.text).toBe("Hello world");
    // The retraction reaches subscribers, and the enriched finish carries the
    // folded value rather than every delta ever sent.
    expect(chunks.filter((event) => event.type === "text-retract")).toEqual([retract(5)]);
    const finish = chunks.find(
      (event): event is Extract<StreamEvent, { type: "finish" }> => event.type === "finish"
    );
    expect(finish?.data.text).toBe("Hello world");
    expect(fold(chunks, "text")).toBe("Hello world");
  });

  it("clamps a retraction longer than the port at the start", async () => {
    const task = new ScriptedTextTask();
    task.script = [delta("abc"), retract(100), delta("x"), FINISH];
    expect((await task.run({})).text).toBe("x");
  });

  it("settles a port retracted to nothing on the finish payload", async () => {
    const task = new ScriptedTextTask();
    task.script = [delta("partial"), retract(7), { type: "finish", data: { text: "stated" } }];
    expect((await task.run({})).text).toBe("stated");
  });

  it("fails a port's cache sink once text it holds is retracted, and settles the port inline", async () => {
    const task = new ScriptedTextTask();
    task.script = [delta("Hello "), delta("there"), retract(5), delta("world"), FINISH];
    const { sink, settled } = makeSink();

    const output = await runProcessor(task, {
      shouldAccumulate: true,
      refSinks: new Map([["text", sink]]),
    });

    // The bytes already teed were "Hello there": the sink must not commit them.
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(TaskError);
    expect(String(outcome)).toMatch(/retracted/);
    // No ref minted from withdrawn text; the accumulator holds the real value.
    expect(isCacheRef(output.text)).toBe(false);
    expect(output.text).toBe("Hello world");
  });

  it("keeps a sink that was never written to before the retraction", async () => {
    const task = new ScriptedTextTask();
    task.script = [retract(3), delta("fresh"), FINISH];
    const { sink, settled } = makeSink();

    const output = await runProcessor(task, {
      shouldAccumulate: true,
      refSinks: new Map([["text", sink]]),
    });

    expect(await settled).toBe("written");
    expect(isCacheRef(output.text)).toBe(true);
  });

  it("refuses to settle a sunk port it kept no copy of, unless the finish states it", async () => {
    const lost = new ScriptedTextTask();
    lost.script = [delta("Hello there"), retract(5), delta("world"), FINISH];
    const lostSink = makeSink();
    await expect(
      runProcessor(lost, { shouldAccumulate: false, refSinks: new Map([["text", lostSink.sink]]) })
    ).rejects.toThrow(/retracted text on port "text"/);
    expect(await lostSink.settled).toBeInstanceOf(TaskError);

    const stated = new ScriptedTextTask();
    stated.script = [
      delta("Hello there"),
      retract(5),
      delta("world"),
      { type: "finish", data: { text: "Hello world" } },
    ];
    const statedSink = makeSink();
    const output = await runProcessor(stated, {
      shouldAccumulate: false,
      refSinks: new Map([["text", statedSink.sink]]),
    });
    expect(output.text).toBe("Hello world");
  });
});

// ==========================================================================
// Edges: a retraction travels with its port's deltas, and only with them.
// ==========================================================================

type TwoPorts = { text: string; notes: string };

class TwoPortSource extends Task<Record<string, never>, TwoPorts> {
  public static override type = "StreamTextRetractTest_TwoPortSource";
  public static override category = "Test";
  public static override cacheable = false;

  public static override inputSchema(): DataPortSchema {
    return { type: "object", properties: {}, additionalProperties: false } as const;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        text: { type: "string", "x-stream": "append" },
        notes: { type: "string", "x-stream": "append" },
      },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  async *executeStream(): AsyncIterable<StreamEvent<TwoPorts>> {
    yield delta("Hello there") as StreamEvent<TwoPorts>;
    yield delta("note", "notes") as StreamEvent<TwoPorts>;
    yield retract(5) as StreamEvent<TwoPorts>;
    yield delta("world") as StreamEvent<TwoPorts>;
    yield { type: "finish", data: {} as TwoPorts };
  }
}

/** Append passthrough that records what reached it and re-streams it as its own. */
class RecordingConsumer extends Task<{ text: string }, TextOut> {
  public static override type = "StreamTextRetractTest_RecordingConsumer";
  public static override category = "Test";
  public static override cacheable = false;
  public received: StreamEvent[] = [];

  public static override inputSchema(): DataPortSchema {
    return TEXT_SCHEMA;
  }
  public static override outputSchema(): DataPortSchema {
    return TEXT_SCHEMA;
  }
  async *executeStream(
    _input: { text: string },
    ctx: IExecuteContext
  ): AsyncIterable<StreamEvent<TextOut>> {
    const stream = ctx.inputStreams?.get("text");
    if (stream) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.type === "text-delta" || value.type === "text-retract") {
            this.received.push(value);
            yield { ...value, port: "text" } as StreamEvent<TextOut>;
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    yield { type: "finish", data: {} as TextOut };
  }
}

describe("StreamPump — text-retract on a port-filtered edge", () => {
  it("forwards a retraction to its own port's consumer and to no other", async () => {
    const graph = new TaskGraph();
    const source = new TwoPortSource({ id: "source" });
    const textConsumer = new RecordingConsumer({ id: "textConsumer" });
    const notesConsumer = new RecordingConsumer({ id: "notesConsumer" });
    graph.addTasks([source, textConsumer, notesConsumer]);
    graph.addDataflow(new Dataflow("source", "text", "textConsumer", "text"));
    graph.addDataflow(new Dataflow("source", "notes", "notesConsumer", "text"));

    const results = await new TaskGraphRunner(graph).runGraph({});

    expect(textConsumer.received).toEqual([delta("Hello there"), retract(5), delta("world")]);
    expect(notesConsumer.received).toEqual([delta("note", "notes")]);
    const text = results.find((r) => r.id === "textConsumer")!.data as TaskOutput;
    expect(text.text).toBe("Hello world");
    const notes = results.find((r) => r.id === "notesConsumer")!.data as TaskOutput;
    expect(notes.text).toBe("note");
  });
});
