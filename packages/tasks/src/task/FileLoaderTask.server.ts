/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, TaskEntitlements } from "@workglow/task-graph";
import {
  CreateWorkflow,
  Entitlements,
  mergeEntitlements,
  TaskAbortedError,
  TaskConfigSchema,
  TaskEntitlementError,
  Workflow,
} from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { readFile } from "node:fs/promises";

import {
  isHttpUrl,
  localFilePathFromUrl,
  resolveLocalFilePath,
} from "../util/LocalFilePath.server";
import { fetchUrlEntitlementsFor } from "./FetchUrlTask";
import type {
  FileLoaderTaskConfig,
  FileLoaderTaskInput,
  FileLoaderTaskOutput,
} from "./FileLoaderTask";
import { FileLoaderTask as BaseFileLoaderTask } from "./FileLoaderTask";

export type { FileLoaderTaskConfig, FileLoaderTaskInput, FileLoaderTaskOutput };

const fileLoaderTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    roots: {
      type: "array",
      items: { type: "string" },
      title: "Roots",
      description:
        "Directories a local path must resolve inside (after symlink resolution). Defaults to the process working directory",
      "x-ui-hidden": true,
    },
    allowAnyRoot: {
      type: "boolean",
      title: "Allow Any Root",
      description: "Skip root containment entirely and read any path the process can open",
      "x-ui-hidden": true,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

/**
 * Server-only task for loading documents from the filesystem.
 * Uses Node.js/Bun file APIs directly for better performance.
 * Only available in Node.js and Bun environments.
 *
 * A local path is resolved and realpath'd before it is opened, and constrained
 * to `config.roots` — which defaults to the process working directory, so a
 * task with no stated root reads from there and nowhere else. Set
 * `config.allowAnyRoot` to opt out. Reading requires the `filesystem:read`
 * entitlement, declared scoped to the resolved path.
 *
 * For cross-platform document loading (including browser), use FileLoaderTask with URLs.
 */
export class FileLoaderTask extends BaseFileLoaderTask<FileLoaderTaskConfig> {
  public static override hasDynamicEntitlements: boolean = true;

  public static override configSchema(): DataPortSchema {
    return fileLoaderTaskConfigSchema as DataPortSchema;
  }

  /**
   * The owned `FetchUrlTask` does the network access for the http(s) branch,
   * but an owned child is created inside `execute()` and so is absent from the
   * graph-start snapshot `computeGraphEntitlements` takes. Declaring the
   * fetch's entitlements here is what puts them in front of the enforcer,
   * alongside the read this build adds.
   */
  public static override entitlements(): TaskEntitlements {
    return mergeEntitlements(super.entitlements(), {
      entitlements: [
        {
          id: Entitlements.FILESYSTEM_READ,
          reason: "Reads a local file or file:// URL from disk",
        },
      ],
    });
  }

  /**
   * Declares whichever half of the surface this url actually uses: the fetch
   * entitlements for http(s), otherwise `filesystem:read` scoped to the
   * resolved real path. An unknown url fails closed to both, unscoped.
   *
   * Never throws — entitlement evaluation runs before `execute()` and must
   * produce a declaration for any input, so an unresolvable path degrades to
   * the unscoped declaration and is refused later, at open time.
   */
  public override entitlements(): TaskEntitlements {
    const url = this.runInputData?.url;
    const unscopedRead: TaskEntitlements = {
      entitlements: [{ id: Entitlements.FILESYSTEM_READ, reason: "Reads a local file from disk" }],
    };

    // MapTask projection seeds the inner loader with the whole url[] rather
    // than one scalar per iteration. A non-empty all-http array uses only the
    // fetch half, so `fetchUrlEntitlementsFor` classifies it alone; anything
    // else adds an unscoped `filesystem:read` on top of whatever that
    // classification yields, because at least one entry may name a path. An
    // EMPTY array is unknown, not vacuously http — `every` says true for it —
    // so it has to fall through to the both-halves declaration.
    if (Array.isArray(url)) {
      const allHttp =
        url.length > 0 &&
        url.every((item) => typeof item === "string" && item.length > 0 && isHttpUrl(item));
      if (allHttp) return fetchUrlEntitlementsFor(url);
      return mergeEntitlements(fetchUrlEntitlementsFor(url), unscopedRead);
    }

    if (typeof url !== "string" || url.length === 0) {
      return mergeEntitlements(fetchUrlEntitlementsFor(undefined), unscopedRead);
    }

    if (isHttpUrl(url)) {
      return fetchUrlEntitlementsFor(url);
    }

    try {
      return {
        entitlements: [
          {
            id: Entitlements.FILESYSTEM_READ,
            reason: "Reads a local file from disk",
            resources: [
              resolveLocalFilePath(url, {
                roots: this.config.roots,
                allowAnyRoot: this.config.allowAnyRoot,
              }),
            ],
          },
        ],
      };
    } catch {
      return unscopedRead;
    }
  }

  /**
   * Refuses a path the instance did not declare. Entitlements are evaluated
   * on the unresolved input, so without this a declare-then-swap would let the
   * open authorize itself — and a standalone `fileLoader(...)` with no graph
   * and no enforcer would honour no `roots` at all.
   */
  private assertResolvedPathDeclared(file: string): void {
    const declared = this.entitlements().entitlements.find(
      (entitlement) => entitlement.id === Entitlements.FILESYSTEM_READ
    );
    if (declared?.resources === undefined) {
      throw new TaskEntitlementError(
        `Refusing to read ${file}: the path could not be resolved when entitlements were declared`
      );
    }
    if (!declared.resources.includes(file)) {
      throw new TaskEntitlementError(
        `Refusing to read ${file}: it differs from the declared path ${declared.resources.join(", ")}`
      );
    }
  }

  override async execute(
    input: FileLoaderTaskInput,
    context: IExecuteContext
  ): Promise<FileLoaderTaskOutput> {
    const { url: inputUrl, format = "auto" } = input;

    if (isHttpUrl(inputUrl)) {
      return super.execute(input, context);
    }

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(0, "Detecting file format");

    // The path as the caller named it, with a `file:` scheme decoded away: it
    // is what the output reports and what the extension sniffing reads. `file`
    // is the real, contained path, and is the only one opened.
    const url = localFilePathFromUrl(inputUrl);
    const file = resolveLocalFilePath(inputUrl, {
      roots: this.config.roots,
      allowAnyRoot: this.config.allowAnyRoot,
    });
    this.assertResolvedPathDeclared(file);

    const detectedFormat = this.detectFormat(url, format);
    const title = url.split("/").pop() || url;

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(10, `Reading ${detectedFormat} file from filesystem`);

    if (detectedFormat === "json") {
      const fileContent = await readFile(file, { encoding: "utf-8" });
      if (context.signal.aborted) {
        throw new TaskAbortedError("Task aborted");
      }
      await context.updateProgress(50, "Parsing JSON content");
      const jsonData = this.parseJsonContent(fileContent);
      const content = JSON.stringify(jsonData, null, 2);
      if (context.signal.aborted) {
        throw new TaskAbortedError("Task aborted");
      }
      await context.updateProgress(100, "File loaded successfully");
      return {
        text: undefined,
        json: jsonData,
        csv: undefined,
        image: undefined,
        pdf: undefined,
        frontmatter: undefined,
        metadata: {
          url,
          format: detectedFormat,
          size: content.length,
          title,
          mimeType: "application/json",
        },
      };
    }

    if (detectedFormat === "csv") {
      const fileContent = await readFile(file, { encoding: "utf-8" });
      if (!fileContent) {
        throw new Error(`Failed to load CSV from ${url}`);
      }
      if (context.signal.aborted) {
        throw new TaskAbortedError("Task aborted");
      }
      await context.updateProgress(50, "Parsing CSV content");
      const csvData = await this.parseCsvContent(fileContent);
      if (context.signal.aborted) {
        throw new TaskAbortedError("Task aborted");
      }
      await context.updateProgress(100, "File loaded successfully");
      return {
        text: undefined,
        json: undefined,
        csv: csvData,
        image: undefined,
        pdf: undefined,
        frontmatter: undefined,
        metadata: {
          url,
          format: detectedFormat,
          size: fileContent.length,
          title,
          mimeType: "text/csv",
        },
      };
    }

    if (detectedFormat === "image") {
      const fileBuffer = await readFile(file);
      if (context.signal.aborted) {
        throw new TaskAbortedError("Task aborted");
      }
      await context.updateProgress(50, "Converting image to base64");
      const mimeType = this.getImageMimeType(url);
      const blob = new Blob([fileBuffer], { type: mimeType });
      const imageData = await this.blobToBase64DataURL(blob, mimeType);
      if (context.signal.aborted) {
        throw new TaskAbortedError("Task aborted");
      }
      await context.updateProgress(100, "File loaded successfully");
      return {
        text: undefined,
        json: undefined,
        csv: undefined,
        image: imageData,
        pdf: undefined,
        frontmatter: undefined,
        metadata: {
          url,
          format: detectedFormat,
          size: fileBuffer.length,
          title,
          mimeType,
        },
      };
    }

    if (detectedFormat === "pdf") {
      const fileBuffer = await readFile(file);
      if (context.signal.aborted) {
        throw new TaskAbortedError("Task aborted");
      }
      await context.updateProgress(50, "Converting PDF to base64");
      const mimeType = "application/pdf";
      const blob = new Blob([fileBuffer], { type: mimeType });
      const pdfData = await this.blobToBase64DataURL(blob, mimeType);
      if (context.signal.aborted) {
        throw new TaskAbortedError("Task aborted");
      }
      await context.updateProgress(100, "File loaded successfully");
      return {
        text: undefined,
        json: undefined,
        csv: undefined,
        image: undefined,
        pdf: pdfData,
        frontmatter: undefined,
        metadata: {
          url,
          format: detectedFormat,
          size: fileBuffer.length,
          title,
          mimeType,
        },
      };
    }

    // text, markdown, or html
    const fileContent = await readFile(file, { encoding: "utf-8" });
    if (!fileContent) {
      throw new Error(`Failed to load content from ${url}`);
    }
    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(50, `Parsing ${detectedFormat} content`);
    const mimeType =
      detectedFormat === "markdown"
        ? "text/markdown"
        : detectedFormat === "html"
          ? "text/html"
          : "text/plain";
    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(100, "File loaded successfully");

    if (detectedFormat === "markdown") {
      const { frontmatter, body } = this.parseFrontmatter(fileContent);
      return {
        text: body,
        json: undefined,
        csv: undefined,
        image: undefined,
        pdf: undefined,
        frontmatter,
        metadata: {
          url,
          format: detectedFormat,
          size: fileContent.length,
          title,
          mimeType,
        },
      };
    }

    return {
      text: fileContent,
      json: undefined,
      csv: undefined,
      image: undefined,
      pdf: undefined,
      frontmatter: undefined,
      metadata: {
        url,
        format: detectedFormat,
        size: fileContent.length,
        title,
        mimeType,
      },
    };
  }
}

export const fileLoader = (input: FileLoaderTaskInput, config?: FileLoaderTaskConfig) => {
  return new FileLoaderTask(config).run(input);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    fileLoader: CreateWorkflow<FileLoaderTaskInput, FileLoaderTaskOutput, FileLoaderTaskConfig>;
  }
}

Workflow.prototype.fileLoader = CreateWorkflow(FileLoaderTask);
