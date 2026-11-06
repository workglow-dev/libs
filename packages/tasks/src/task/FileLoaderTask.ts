/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CachePolicy,
  IExecuteContext,
  TaskConfig,
  TaskEntitlements,
} from "@workglow/task-graph";
import { CreateWorkflow, Task, TaskAbortedError, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import type { FetchUrlResponseType, FetchUrlTaskOutput } from "./FetchUrlTask";
import { fetchUrlEntitlementsFor, FetchUrlTask } from "./FetchUrlTask";

let _papaParse: typeof import("papaparse").parse | undefined;

async function getPapaParse(): Promise<typeof import("papaparse").parse> {
  if (!_papaParse) {
    try {
      const mod = await import("papaparse");
      _papaParse = mod.parse;
    } catch {
      throw new Error(
        "CSV parsing requires the optional 'papaparse' package. " +
          "Install it with: npm install papaparse (or bun add papaparse)"
      );
    }
  }
  return _papaParse;
}

const inputSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      title: "URL",
      description: "URL to load document from (http://, https://)",
      format: "uri",
    },
    format: {
      type: "string",
      enum: ["text", "markdown", "json", "csv", "pdf", "image", "html", "auto"],
      title: "Format",
      description: "File format (auto-detected from URL if 'auto')",
      default: "auto",
    },
  },
  required: ["url"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      description: "Text content (for text, markdown, html formats)",
    },
    json: {
      title: "JSON",
      description: "Parsed JSON object or array",
    },
    csv: {
      type: "array",
      title: "CSV",
      description: "Parsed CSV data as array of objects",
    },
    image: {
      type: "string",
      title: "Image",
      description: "Base64 data URL for image files",
      format: "image:data-uri",
    },
    pdf: {
      type: "string",
      title: "PDF",
      description: "Base64 data URL for PDF files",
    },
    frontmatter: {
      type: "object",
      title: "Frontmatter",
      description: "Parsed YAML frontmatter from markdown/MDX files",
    },
    metadata: {
      type: "object",
      properties: {
        url: { type: "string" },
        format: { type: "string" },
        size: { type: "number" },
        title: { type: "string" },
        mimeType: { type: "string" },
      },
      additionalProperties: false,
      title: "Metadata",
      description: "File metadata",
    },
  },
  required: ["metadata"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type FileLoaderTaskInput = FromSchema<typeof inputSchema>;
export type FileLoaderTaskOutput = FromSchema<typeof outputSchema>;

/**
 * Task for loading documents from URLs (including file:// URLs).
 * Works in all environments (browser, Node.js, Bun) by using fetch API.
 * For server-only filesystem path access, see FileLoaderServerTask.
 */
export class FileLoaderTask<Config extends TaskConfig = TaskConfig> extends Task<
  FileLoaderTaskInput,
  FileLoaderTaskOutput,
  Config
> {
  public static override type = "FileLoaderTask";
  public static override category = "Document";
  public static override title = "File Loader";
  public static override description = "Load documents from URLs (http://, https://)";
  /**
   * Not cached: the result is the document as it is now, and the cache key is only the
   * url — a file or resource changed between runs would be answered as it was.
   * `cachePolicy` rather than `cacheable = false`: the server variants extend this class,
   * and the resolver honours `cacheable` only where a class declares it itself.
   */
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override hasDynamicEntitlements: boolean = true;

  /**
   * The owned `FetchUrlTask` does the network access, but an owned child is
   * created inside `execute()` and so is absent from the graph-start snapshot
   * `computeGraphEntitlements` takes over `graph.getTasks()`. Declaring the
   * fetch's entitlements here is what puts them in front of the enforcer.
   */
  public static override entitlements(): TaskEntitlements {
    return FetchUrlTask.entitlements();
  }

  public override entitlements(): TaskEntitlements {
    return fetchUrlEntitlementsFor(this.runInputData?.url);
  }

  public static override inputSchema(): DataPortSchema {
    return inputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return outputSchema as DataPortSchema;
  }

  override async execute(
    input: FileLoaderTaskInput,
    context: IExecuteContext
  ): Promise<FileLoaderTaskOutput> {
    const { url, format = "auto" } = input;

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(0, "Detecting file format");

    const detectedFormat = this.detectFormat(url, format);
    const responseType = this.detectResponseType(detectedFormat);

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(10, `Fetching ${detectedFormat} file from ${url}`);

    // Uncached like this task: the file is read afresh each run, not from the fetch cache.
    const fetchTask = context.own(new FetchUrlTask({ queue: false }, { cacheable: false }));
    const response = await fetchTask.run({
      url,
      response_type: responseType,
    });

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(60, "Parsing file content");

    const title = url.split("/").pop() || url;
    const { text, json, csv, image, pdf, frontmatter, size, mimeType } = await this.parseResponse(
      response,
      url,
      detectedFormat
    );

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(100, "File loaded successfully");

    return {
      text,
      json,
      csv,
      image,
      pdf,
      frontmatter,
      metadata: {
        url,
        format: detectedFormat,
        size,
        title,
        mimeType,
      },
    };
  }

  protected parseJsonContent(content: string): unknown {
    return JSON.parse(content);
  }

  protected async parseCsvContent(content: string): Promise<Array<Record<string, string>>> {
    try {
      const parse = await getPapaParse();
      const result = parse<Record<string, string>>(content, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header: string) => header.trim(),
      });
      return result.data;
    } catch (error) {
      if (error instanceof Error && error.message.includes("optional 'papaparse'")) {
        throw error;
      }
      throw new Error(
        `Failed to parse CSV: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Parse YAML frontmatter from markdown/MDX content.
   * Supports common frontmatter patterns: strings, numbers, booleans, arrays, and nested objects.
   */
  protected parseFrontmatter(content: string): {
    readonly frontmatter: Record<string, unknown> | undefined;
    readonly body: string;
  } {
    const trimmed = content.replace(/^\uFEFF/, "");
    if (!trimmed.startsWith("---\n") && !trimmed.startsWith("---\r\n")) {
      return { frontmatter: undefined, body: content };
    }

    const firstDelimEnd = trimmed.indexOf("\n") + 1;
    const closingIdx = trimmed.indexOf("\n---", firstDelimEnd);
    if (closingIdx === -1) {
      return { frontmatter: undefined, body: content };
    }

    const yamlBlock = trimmed.slice(firstDelimEnd, closingIdx);
    const afterClosing = closingIdx + 4; // "\n---".length
    let bodyStart = afterClosing;
    if (trimmed[bodyStart] === "\r") bodyStart++;
    if (trimmed[bodyStart] === "\n") bodyStart++;
    const body = trimmed.slice(bodyStart).replace(/^\r?\n/, "");

    const frontmatter = this.parseSimpleYaml(yamlBlock);
    return { frontmatter, body };
  }

  private parseSimpleYaml(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = yaml.split(/\r?\n/);
    let i = 0;

    while (i < lines.length) {
      i = this.parseYamlLine(lines, i, result, 0);
    }

    return result;
  }

  private parseYamlLine(
    lines: readonly string[],
    index: number,
    target: Record<string, unknown>,
    indent: number
  ): number {
    if (index >= lines.length) return index + 1;
    const line = lines[index];

    if (line.trim() === "" || line.trim().startsWith("#")) {
      return index + 1;
    }

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) return index;

    const content = line.trimStart();
    const colonIndex = content.indexOf(":");
    if (colonIndex === -1) return index + 1;

    const key = content.slice(0, colonIndex).trim();
    if (!key || key.includes("#")) return index + 1;
    const rawValue = content.slice(colonIndex + 1).trim();

    if (rawValue === "" || rawValue === "|" || rawValue === ">") {
      const nextIndex = index + 1;
      if (nextIndex < lines.length) {
        const nextLine = lines[nextIndex];
        const nextTrimmed = nextLine.trimStart();
        const nextIndent = nextLine.length - nextTrimmed.length;

        if (nextIndent > lineIndent && nextTrimmed.startsWith("- ")) {
          const arr: unknown[] = [];
          let j = nextIndex;
          while (j < lines.length) {
            const arrLine = lines[j];
            const arrTrimmed = arrLine.trimStart();
            const arrIndent = arrLine.length - arrTrimmed.length;
            if (arrTrimmed === "" || arrTrimmed.startsWith("#")) {
              j++;
              continue;
            }
            if (arrIndent < nextIndent) break;
            if (arrTrimmed.startsWith("- ")) {
              arr.push(this.parseYamlValue(arrTrimmed.slice(2).trim()));
              j++;
            } else {
              break;
            }
          }
          target[key] = arr;
          return j;
        } else if (nextIndent > lineIndent) {
          const nested: Record<string, unknown> = {};
          let j = nextIndex;
          while (j < lines.length) {
            const nestedLine = lines[j];
            const nestedTrimmed = nestedLine.trimStart();
            const nestedIndent = nestedLine.length - nestedTrimmed.length;
            if (nestedTrimmed === "" || nestedTrimmed.startsWith("#")) {
              j++;
              continue;
            }
            if (nestedIndent < nextIndent) break;
            j = this.parseYamlLine(lines, j, nested, nextIndent);
          }
          target[key] = nested;
          return j;
        }
      }
      target[key] = rawValue === "" ? null : rawValue;
      return index + 1;
    }

    target[key] = this.parseYamlValue(rawValue);
    return index + 1;
  }

  private parseYamlValue(raw: string): unknown {
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    if (raw === "true" || raw === "True" || raw === "TRUE") return true;
    if (raw === "false" || raw === "False" || raw === "FALSE") return false;
    if (raw === "null" || raw === "~") return null;
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    if (raw.startsWith("[") && raw.endsWith("]")) {
      return raw
        .slice(1, -1)
        .split(",")
        .map((item) => this.parseYamlValue(item.trim()));
    }
    return raw;
  }

  protected async parseResponse(
    response: FetchUrlTaskOutput,
    url: string,
    detectedFormat: "text" | "markdown" | "json" | "csv" | "pdf" | "image" | "html"
  ): Promise<{
    readonly text: string | undefined;
    readonly json: unknown;
    readonly csv: Array<Record<string, string>> | undefined;
    readonly image: string | undefined;
    readonly pdf: string | undefined;
    readonly frontmatter: Record<string, unknown> | undefined;
    readonly size: number;
    readonly mimeType: string;
  }> {
    const responseMimeType = response.metadata?.contentType || "";

    if (detectedFormat === "json") {
      if (!response.json) {
        throw new Error(`Failed to load JSON from ${url}`);
      }
      const jsonData = response.json;
      const content = JSON.stringify(jsonData, null, 2);
      return {
        text: undefined,
        json: jsonData,
        csv: undefined,
        image: undefined,
        pdf: undefined,
        frontmatter: undefined,
        size: content.length,
        mimeType: responseMimeType || "application/json",
      };
    }

    if (detectedFormat === "csv") {
      const content = response.text || "";
      if (!content) {
        throw new Error(`Failed to load CSV from ${url}`);
      }
      const csvData = await this.parseCsvContent(content);
      return {
        text: undefined,
        json: undefined,
        csv: csvData,
        image: undefined,
        pdf: undefined,
        frontmatter: undefined,
        size: content.length,
        mimeType: responseMimeType || "text/csv",
      };
    }

    if (detectedFormat === "image") {
      if (!response.blob) {
        throw new Error(`Failed to load image from ${url}`);
      }
      const blob = response.blob as Blob;
      const mimeType =
        responseMimeType ||
        (blob.type && blob.type !== "" ? blob.type : this.getImageMimeType(url));
      const imageData = await this.blobToBase64DataURL(blob, mimeType);
      return {
        text: undefined,
        json: undefined,
        csv: undefined,
        image: imageData,
        pdf: undefined,
        frontmatter: undefined,
        size: blob.size,
        mimeType,
      };
    }

    if (detectedFormat === "pdf") {
      if (!response.blob) {
        throw new Error(`Failed to load PDF from ${url}`);
      }
      const blob = response.blob as Blob;
      const mimeType = responseMimeType || "application/pdf";
      const pdfData = await this.blobToBase64DataURL(blob, mimeType);
      return {
        text: undefined,
        json: undefined,
        csv: undefined,
        image: undefined,
        pdf: pdfData,
        frontmatter: undefined,
        size: blob.size,
        mimeType,
      };
    }

    // text, markdown, or html
    const content = response.text ?? "";
    const mimeType =
      responseMimeType ||
      (detectedFormat === "markdown"
        ? "text/markdown"
        : detectedFormat === "html"
          ? "text/html"
          : "text/plain");

    if (detectedFormat === "markdown") {
      const { frontmatter, body } = this.parseFrontmatter(content);
      return {
        text: body,
        json: undefined,
        csv: undefined,
        image: undefined,
        pdf: undefined,
        frontmatter,
        size: content.length,
        mimeType,
      };
    }

    return {
      text: content,
      json: undefined,
      csv: undefined,
      image: undefined,
      pdf: undefined,
      frontmatter: undefined,
      size: content.length,
      mimeType,
    };
  }

  protected detectResponseType(detectedFormat: string): FetchUrlResponseType {
    let responseType: FetchUrlResponseType = "text";
    if (detectedFormat === "json") {
      responseType = "json";
    } else if (detectedFormat === "image" || detectedFormat === "pdf") {
      responseType = "blob";
    } else if (
      detectedFormat === "csv" ||
      detectedFormat === "text" ||
      detectedFormat === "markdown" ||
      detectedFormat === "html"
    ) {
      responseType = "text";
    }
    return responseType;
  }

  protected detectFormat(
    url: string,
    format: "text" | "markdown" | "json" | "csv" | "pdf" | "image" | "html" | "auto"
  ): "text" | "markdown" | "json" | "csv" | "pdf" | "image" | "html" {
    if (format === "auto") {
      const urlLower = url.toLowerCase();
      if (urlLower.endsWith(".md") || urlLower.endsWith(".mdx") || urlLower.endsWith(".markdown")) {
        return "markdown";
      } else if (urlLower.endsWith(".json")) {
        return "json";
      } else if (urlLower.endsWith(".csv")) {
        return "csv";
      } else if (urlLower.endsWith(".pdf")) {
        return "pdf";
      } else if (urlLower.match(/\.(jpg|jpeg|png|gif|bmp|webp|svg|ico)$/)) {
        return "image";
      } else if (urlLower.endsWith(".html") || urlLower.endsWith(".htm")) {
        return "html";
      } else {
        return "text";
      }
    }
    return format;
  }

  protected getImageMimeType(url: string): string {
    const urlLower = url.toLowerCase();
    if (urlLower.endsWith(".png")) return "image/png";
    if (urlLower.endsWith(".jpg") || urlLower.endsWith(".jpeg")) return "image/jpeg";
    if (urlLower.endsWith(".gif")) return "image/gif";
    if (urlLower.endsWith(".webp")) return "image/webp";
    if (urlLower.endsWith(".bmp")) return "image/bmp";
    if (urlLower.endsWith(".svg")) return "image/svg+xml";
    if (urlLower.endsWith(".ico")) return "image/x-icon";
    return "image/jpeg";
  }

  protected async blobToBase64DataURL(blob: Blob, mimeType: string): Promise<string> {
    if (typeof Buffer !== "undefined") {
      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return `data:${mimeType};base64,${buffer.toString("base64")}`;
    }

    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        if (result.startsWith("data:;base64,")) {
          resolve(`data:${mimeType};base64,${result.substring(13)}`);
        } else {
          resolve(result);
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

/**
 * Config for both builds. `roots` is declared here rather than beside the
 * server subclass because a `declare module` augmentation must state one type
 * across every file that contributes it, and both files augment `Workflow`
 * with `fileLoader`.
 */
export interface FileLoaderTaskConfig extends TaskConfig {
  /**
   * Directories a local path must resolve inside, checked after symlinks are
   * resolved. Omitted means `[process.cwd()]`, NOT unrestricted — the
   * `filesystem:read` entitlement is only consulted when the embedder runs
   * with `enforceEntitlements` and a registered enforcer, so it cannot stand
   * in as the default fence. State {@link allowAnyRoot} to opt out.
   *
   * Honored only by the server build — the cross-platform class reaches
   * http(s) through `FetchUrlTask` and touches no filesystem.
   */
  readonly roots?: readonly string[] | undefined;
  /**
   * Read any path the process can open, skipping containment entirely. Only
   * the literal `true` does so, and it is never implied by leaving `roots`
   * unset.
   */
  readonly allowAnyRoot?: boolean | undefined;
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
