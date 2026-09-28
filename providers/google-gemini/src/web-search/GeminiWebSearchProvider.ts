/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from "@google/genai";
import { resolveApiKey } from "@workglow/ai/provider-utils";
import type { IExecuteContext } from "@workglow/task-graph";
import { TaskFailedError } from "@workglow/task-graph";
import type {
  IWebSearchProvider,
  SearchResult,
  WebSearchCapabilities,
  WebSearchDateRange,
  WebSearchRequest,
  WebSearchResponse,
} from "@workglow/web-search";
import { limitResults } from "@workglow/web-search";

const DEFAULT_MODEL = "gemini-3.8-flash";
/** No lower bound: `timeRangeFilter` rejects an interval with only one side set. */
const OPEN_INTERVAL_START = "1970-01-01T00:00:00Z";

export interface GeminiWebSearchOptions {
  readonly client?: GoogleGenAI | undefined;
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
}

interface GroundingChunk {
  readonly web?: { readonly uri?: string; readonly title?: string; readonly domain?: string };
}

function rfc3339(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TaskFailedError(
      `GeminiWebSearchProvider: ${JSON.stringify(value)} is not a parseable date.`
    );
  }
  return parsed.toISOString();
}

/**
 * Gemini requires both ends of the interval — "if customers set a start time,
 * they must set an end time (and vice versa)" — while this task's `dateRange`
 * lets either side be open. The missing side is filled rather than refused, so
 * a half-open range still means what the caller asked.
 */
function timeRangeFilter(range: WebSearchDateRange): Record<string, string> | undefined {
  if (range.start === undefined && range.end === undefined) return undefined;
  return {
    startTime: range.start === undefined ? OPEN_INTERVAL_START : rfc3339(range.start),
    endTime: range.end === undefined ? new Date().toISOString() : rfc3339(range.end),
  };
}

export class GeminiWebSearchProvider implements IWebSearchProvider {
  public readonly name = "gemini";
  /** Reached through the vendor SDK, not a fetch this package owns. */
  public readonly endpoint = undefined;
  /** The SDK carries the key; `credentialKey` never reaches this request. */
  public readonly acceptsCredentialKey = false;
  public readonly capabilities: WebSearchCapabilities = {
    answer: true,
    content: false,
    // `GoogleSearch.excludeDomains` exists in the SDK but is documented
    // "not supported in Gemini API" (Vertex only), and there is no include
    // equivalent at all — so neither direction is offered here.
    domainFilter: false,
    // `timeRangeFilter` is the mirror image: supported on the Gemini API and
    // documented "not supported in Vertex AI".
    dateFilter: true,
    maxResultsCap: undefined,
  };

  private client: GoogleGenAI | undefined;
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor(options: GeminiWebSearchOptions = {}) {
    this.client = options.client;
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
  }

  /**
   * Built on first search, not in the constructor, so registering the provider
   * cannot warn or throw out of the vendor SDK on a machine that has no key
   * yet, and a missing key reports through this repo's named error rather than
   * as a header failure inside the SDK. The env vars are the pair the AI path
   * already reads, in the same order.
   */
  private getClient(): GoogleGenAI {
    this.client ??= new GoogleGenAI({
      apiKey: resolveApiKey({
        config: { api_key: this.apiKey },
        envVar: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        providerLabel: "Google",
      }),
    });
    return this.client;
  }

  async search(request: WebSearchRequest, context: IExecuteContext): Promise<WebSearchResponse> {
    context.signal.throwIfAborted();
    const client = this.getClient();

    const googleSearch: Record<string, unknown> = {};
    if (request.dateRange) {
      const range = timeRangeFilter(request.dateRange);
      if (range) googleSearch.timeRangeFilter = range;
    }

    const response = (await client.models.generateContent({
      model: this.model,
      contents: request.query,
      config: { tools: [{ googleSearch }], abortSignal: context.signal },
    } as never)) as {
      text?: string;
      candidates?: readonly {
        groundingMetadata?: { groundingChunks?: readonly GroundingChunk[] };
      }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const candidate = response.candidates?.[0];
    if (candidate === undefined) {
      throw new TaskFailedError("GeminiWebSearchProvider: response carried no candidates.");
    }

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const chunk of candidate.groundingMetadata?.groundingChunks ?? []) {
      const web = chunk.web;
      if (web?.uri === undefined) continue;
      if (seen.has(web.uri)) continue;
      seen.add(web.uri);
      results.push({
        title: web.title ?? web.domain ?? web.uri,
        url: web.uri,
        snippet: undefined,
        content: undefined,
        publishedDate: undefined,
        score: undefined,
        favicon: undefined,
      });
    }

    return {
      results: limitResults(results, request.maxResults),
      answer:
        request.includeAnswer === true && typeof response.text === "string" && response.text
          ? response.text
          : undefined,
      query: request.query,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}
