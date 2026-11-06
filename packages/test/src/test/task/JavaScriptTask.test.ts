/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { javaScript, JavaScriptTask } from "@workglow/javascript/task";
import { TaskAbortedError, TaskGraph, TaskStatus, Workflow } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, test } from "vitest";

describe("JavaScriptTask", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  test("executes simple JavaScript code", async () => {
    const result = await javaScript({
      javascript_code: "1 + 1",
    });
    expect(result.output).toBe(2);
  });

  test("executes code with string operations", async () => {
    const result = await javaScript({
      javascript_code: '"hello" + " " + "world"',
    });
    expect(result.output).toBe("hello world");
  });

  test("executes code with variables", async () => {
    const result = await javaScript({
      javascript_code: "var x = 10; var y = 20; x + y",
    });
    expect(result.output).toBe(30);
  });

  test("executes code with functions", async () => {
    const result = await javaScript({
      javascript_code: `
        function add(a, b) {
          return a + b;
        }
        add(5, 7)
      `,
    });
    expect(result.output).toBe(12);
  });

  test("executes code with arrays", async () => {
    const result = await javaScript({
      javascript_code: `
        var arr = [1, 2, 3, 4, 5];
        var sum = 0;
        for (var i = 0; i < arr.length; i++) {
          sum += arr[i];
        }
        sum
      `,
    });
    expect(result.output).toBe(15);
  });

  test("returns arrays as plain JavaScript arrays", async () => {
    const result = await javaScript({
      javascript_code: '["a", "b", "c"]',
    });
    expect(result.output).toEqual(["a", "b", "c"]);
  });

  test("returns objects as plain JavaScript objects", async () => {
    const result = await javaScript({
      javascript_code: '({ name: "Alice", tags: ["x", "y"] })',
    });
    expect(result.output).toEqual({ name: "Alice", tags: ["x", "y"] });
  });

  test("executes code with objects", async () => {
    const result = await javaScript({
      javascript_code: `
        var obj = { name: "Alice", age: 30 };
        obj.name + " is " + obj.age + " years old"
      `,
    });
    expect(result.output).toBe("Alice is 30 years old");
  });

  test("executes code with conditional statements", async () => {
    const result = await javaScript({
      javascript_code: `
        var x = 10;
        if (x > 5) {
          "greater";
        } else {
          "lesser";
        }
      `,
    });
    expect(result.output).toBe("greater");
  });

  test("executes code with loops", async () => {
    const result = await javaScript({
      javascript_code: `
        var result = "";
        for (var i = 0; i < 3; i++) {
          result += i;
        }
        result
      `,
    });
    expect(result.output).toBe("012");
  });
  test("should throw an error if the code is empty", async () => {
    const task = new JavaScriptTask({ defaults: { javascript_code: "" } });
    await expect(task.run()).rejects.toThrowError();
  });

  test("handles code with no return value", async () => {
    const result = await javaScript({
      javascript_code: "var x = 10;",
    });
    expect(result.output).toBeUndefined();
  });

  test("executes code with input parameter - simple value", async () => {
    const result = await javaScript({
      javascript_code: "input",
      input: 42,
    });
    expect(result.output).toBe(42);
  });

  test("executes code with multiple input parameters - simple values", async () => {
    const result = await javaScript({
      javascript_code: "a + b",
      a: 10,
      b: 20,
    });
    expect(result.output).toBe(30);
  });

  test("executes code with input parameter - object", async () => {
    const result = await javaScript({
      javascript_code: "input.value * 2",
      input: { value: 100 },
    });
    expect(result.output).toBe(200);
  });

  test("executes code with input parameter - array", async () => {
    const result = await javaScript({
      javascript_code: `
        var sum = 0;
        for (var i = 0; i < arr.length; i++) {
          sum += arr[i];
        }
        sum
      `,
      arr: [1, 2, 3, 4, 5],
    });
    expect(result.output).toBe(15);
  });

  test("executes code with input parameter - string manipulation", async () => {
    const result = await javaScript({
      javascript_code: "input.toUpperCase()",
      input: "hello world",
    });
    expect(result.output).toBe("HELLO WORLD");
  });

  test("executes code with input parameter - nested object", async () => {
    const result = await javaScript({
      javascript_code: "input.user.name + ' is ' + input.user.age + ' years old'",
      input: {
        user: {
          name: "Alice",
          age: 30,
        },
      },
    });
    expect(result.output).toBe("Alice is 30 years old");
  });

  test("executes code with input parameter - boolean", async () => {
    const result = await javaScript({
      javascript_code: "!input",
      input: false,
    });
    expect(result.output).toBe(true);
  });

  test("executes code with input parameter - null", async () => {
    const result = await javaScript({
      javascript_code: "input === null",
      input: null,
    });
    expect(result.output).toBe(true);
  });

  test("executes code with input parameter - undefined", async () => {
    const result = await javaScript({
      javascript_code: "typeof input === 'undefined'",
    });
    expect(result.output).toBe(true);
  });

  test("executes code with input parameter - complex calculation", async () => {
    const result = await javaScript({
      javascript_code: `
        var total = 0;
        for (var i = 0; i < input.items.length; i++) {
          total += input.items[i].price * input.items[i].quantity;
        }
        total * (1 - input.discount)
      `,
      input: {
        items: [
          { price: 10, quantity: 2 },
          { price: 5, quantity: 3 },
        ],
        discount: 0.1,
      },
    });
    expect(result.output).toBe(31.5); // (10*2 + 5*3) * 0.9 = 35 * 0.9 = 31.5
  });

  test("in task mode", async () => {
    const task = new JavaScriptTask({ id: "js-task", defaults: { javascript_code: "2 * 3" } });
    const result = await task.run();
    expect(result.output).toBe(6);
    expect(task.status).toBe(TaskStatus.COMPLETED);
  });

  test("in task mode with function", async () => {
    const task = new JavaScriptTask({
      id: "js-function",
      defaults: {
        javascript_code: `
          var double = function(n) {
            return n * 2;
          };
          double(7)
        `,
      },
    });
    const result = await task.run();
    expect(result.output).toBe(14);
    expect(task.status).toBe(TaskStatus.COMPLETED);
  });

  test("in task graph mode", async () => {
    const graph = new TaskGraph();
    graph.addTask(
      new JavaScriptTask({ id: "js-in-graph", defaults: { javascript_code: "10 * 10" } })
    );
    const results = await graph.run();
    expect(results[0].data.output).toBe(100);
  });

  test("in workflow mode", async () => {
    const workflow = new Workflow();
    workflow.javaScript({
      javascript_code: "5 + 5",
    });
    const results = await workflow.run();
    expect(results.output).toBe(10);
  });

  test("in task mode with input", async () => {
    const task = new JavaScriptTask({
      id: "js-with-input",
      defaults: {
        javascript_code: "input.x + input.y",
        input: { x: 15, y: 25 },
      },
    });
    const result = await task.run();
    expect(result.output).toBe(40);
    expect(task.status).toBe(TaskStatus.COMPLETED);
  });

  test("in workflow mode with input", async () => {
    const workflow = new Workflow();
    workflow.javaScript({
      javascript_code: "input.a + input.b + input.c",
      input: { a: 10, b: 20, c: 30 },
    });
    const results = await workflow.run();
    expect(results.output).toBe(60);
  });

  test("throws on syntax errors", async () => {
    await expect(
      javaScript({
        javascript_code: "var x = ;", // Invalid syntax
      })
    ).rejects.toThrow("JavaScript execution failed");
  });

  test("executes code with nested functions", async () => {
    const result = await javaScript({
      javascript_code: `
        function outer(x) {
          function inner(y) {
            return y * 2;
          }
          return inner(x) + 1;
        }
        outer(5)
      `,
    });
    expect(result.output).toBe(11); // (5 * 2) + 1
  });

  test("handles boolean operations", async () => {
    const result = await javaScript({
      javascript_code: `
        var a = true;
        var b = false;
        a && !b
      `,
    });
    expect(result.output).toBe(true);
  });

  test("multiple tasks in sequence", async () => {
    const results = await Promise.all([
      javaScript({ javascript_code: "1 + 1" }),
      javaScript({ javascript_code: "2 + 2" }),
      javaScript({ javascript_code: "3 + 3" }),
    ]);
    expect(results[0].output).toBe(2);
    expect(results[1].output).toBe(4);
    expect(results[2].output).toBe(6);
  });

  test("task metadata is preserved", async () => {
    const task = new JavaScriptTask({
      id: "test-metadata",
      defaults: { javascript_code: "42" },
    });
    await task.run();
    expect(task.id).toBe("test-metadata");
  });

  test("static properties are correct", () => {
    expect(JavaScriptTask.type).toBe("JavaScriptTask");
    expect(JavaScriptTask.category).toBe("Utility");
    expect(JavaScriptTask.title).toBe("JavaScript Interpreter");
    expect(JavaScriptTask.description).toContain("sandboxed interpreter");
  });

  test("input and output schemas are defined", () => {
    const inputSchema = JavaScriptTask.inputSchema();
    const outputSchema = JavaScriptTask.outputSchema();
    expect(inputSchema).toBeDefined();
    expect(outputSchema).toBeDefined();
  });

  // `Interpreter.run()` is a synchronous loop: a script that never ends held the
  // event loop forever, so no timer — and no abort — could ever run again.
  test("a script that never ends can still be aborted", async () => {
    const task = new JavaScriptTask();
    const timer = setTimeout(() => task.abort(), 100);
    const started = Date.now();
    await expect(task.run({ javascript_code: "while (true) {}" })).rejects.toBeInstanceOf(
      TaskAbortedError
    );
    clearTimeout(timer);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("timers keep running while a long script executes", async () => {
    let ticks = 0;
    const interval = setInterval(() => ticks++, 10);
    const result = await new JavaScriptTask().run({
      javascript_code: "var s = 0; for (var i = 0; i < 300000; i++) { s += i; } s",
    });
    clearInterval(interval);
    expect(result.output).toBe(44999850000);
    expect(ticks).toBeGreaterThan(0);
  });

  test("a script past its step budget is stopped, naming the budget", async () => {
    const task = new JavaScriptTask({ maxSteps: 10_000 } as never);
    await expect(task.run({ javascript_code: "while (true) {}" })).rejects.toThrow(/10000 steps/);
  });

  test("a preview of a script that never ends stops on its own", async () => {
    // A preview has no abort signal; without a bound it would spin until the page closed.
    const started = Date.now();
    // The runner reports a failed preview without rejecting; what matters is that it ends.
    await new JavaScriptTask()
      .runPreview({ javascript_code: "while (true) {}" })
      .catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a script inside its budget is unaffected", async () => {
    const task = new JavaScriptTask({ maxSteps: 10_000_000 } as never);
    const result = await task.run({
      javascript_code: "var s = 0; for (var i = 0; i < 1000; i++) { s += i; } s",
    });
    expect(result.output).toBe(499500);
  });
});
