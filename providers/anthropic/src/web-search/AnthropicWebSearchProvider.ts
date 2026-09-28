/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IExecuteContext } from "@workglow/task-graph";
import { TaskConfigurationError, TaskFailedError } from "@workglow/task-graph";
import type {
  IWebSearchProvider,
  SearchResult,
  WebSearchCapabilities,
  WebSearchRequest,
  WebSearchResponse,
} from "@workglow/web-search";
import { limitResults, toIsoPublishedDate } from "@workglow/web-search";

/**
 * Dynamic-filtering web search, available on Opus 5.5/5/4.8/4.7/4.6 and
 * Sonnet 5.5/5/4.6.
 * Older models take the basic `web_search_20250305` variant instead, which is
 * also the only one on Vertex AI.
 */
const WEB_SEARCH_TOOL_TYPE = "web_search_20260209";
const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_PAUSE_RESUMES = 4;

export interface AnthropicWebSearchOptions {
  readonly client?: Anthropic | undefined;
  /**
   * Key handed to the SDK. Left unset it reads `ANTHROPIC_API_KEY`, which is
   * the only other place this adapter looks — a credential-store key named for
   * it in the task's `credential_keys` is refused rather than sent.
   */
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly maxTokens?: number | undefined;
  /**
   * How many searches the model may run for one request — Anthropic's
   * `max_uses`. A budget on the work done, not on the results returned, and
   * exceeding it comes back as a tool error that fails the search. Left unset,
   * the API applies its own default.
   */
  readonly maxUses?: number | undefined;
}

interface AnthropicSearchResultBlock {
  readonly type?: string;
  readonly title?: string;
  readonly url?: string;
  /** Display text — "April 30, 2025", sometimes a relative phrase. */
  readonly page_age?: string;
}

export class AnthropicWebSearchProvider implements IWebSearchProvider {
  public readonly name = "anthropic";
  /** No endpoint: this adapter reaches Anthropic through the vendor SDK. */
  public readonly endpoint = undefined;
  /** The SDK carries the key; `credentialKey` never reaches this request. */
  public readonly acceptsCredentialKey = false;
  public readonly capabilities: WebSearchCapabilities = {
    answer: true,
    content: false,
    domainFilter: "native",
    // The tool takes allowed_domains or blocked_domains, never the pair — so
    // routing has to score a both-lists request as a gap and look elsewhere,
    // rather than land here and throw.
    exclusiveDomainDirections: true,
    dateFilter: false,
    maxResultsCap: undefined,
  };

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly maxUses: number | undefined;

  constructor(options: AnthropicWebSearchOptions = {}) {
    this.client =
      options.client ??
      (options.apiKey === undefined ? new Anthropic() : new Anthropic({ apiKey: options.apiKey }));
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? 16000;
    this.maxUses = options.maxUses;
  }

  async search(request: WebSearchRequest, context: IExecuteContext): Promise<WebSearchResponse> {
    const tool: Record<string, unknown> = { type: WEB_SEARCH_TOOL_TYPE, name: "web_search" };
    // `maxResults` is not `max_uses`. It bounds the results handed back, while
    // `max_uses` bounds the searches the model may run — and overrunning it is
    // a tool error that fails the whole request. Mapping one onto the other
    // turned a result-count hint into "the search worked, then failed".
    if (this.maxUses !== undefined) tool.max_uses = this.maxUses;

    const includes = request.includeDomains ?? [];
    const excludes = request.excludeDomains ?? [];
    if (includes.length > 0 && excludes.length > 0) {
      throw new TaskConfigurationError(
        "AnthropicWebSearchProvider: the web_search tool accepts allowed_domains or " +
          "blocked_domains, never both. Pass only one."
      );
    }
    if (includes.length > 0) tool.allowed_domains = [...includes];
    if (excludes.length > 0) tool.blocked_domains = [...excludes];

    const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
      { role: "user", content: request.query },
    ];

    const results: SearchResult[] = [];
    const answerParts: string[] = [];
    // Scoped to the whole search, not to one block: `max_uses` lets one turn
    // run several searches, and a resumed turn runs more, so overlapping
    // sources are the normal case rather than the exception.
    const seen = new Set<string>();
    let inputTokens = 0;
    let outputTokens = 0;

    // A server-tool turn can stop with `pause_turn`; resuming means pushing the
    // paused assistant content back. Without this the turn ends early and the
    // answer is silently truncated with no error raised anywhere.
    for (let attempt = 0; attempt <= MAX_PAUSE_RESUMES; attempt++) {
      context.signal.throwIfAborted();
      const message = (await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          tools: [tool] as never,
          messages: messages as never,
        },
        // Checking the signal only bounds how many turns start. Handing it to
        // the SDK is what stops the one already in flight, which is where the
        // tokens are being spent.
        { signal: context.signal }
      )) as {
        content: readonly unknown[];
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      inputTokens += message.usage?.input_tokens ?? 0;
      outputTokens += message.usage?.output_tokens ?? 0;
      this.collect(message.content, results, answerParts, seen);

      if (message.stop_reason !== "pause_turn") {
        return {
          results: limitResults(results, request.maxResults),
          // Gated on the caller asking, even though the model always produces
          // text: `answer` has to mean the same thing whichever provider routing
          // picked, and Tavily populates it only when requested. Reporting a
          // free byproduct here would make the port's meaning provider-dependent.
          answer:
            request.includeAnswer === true && answerParts.length > 0
              ? answerParts.join("")
              : undefined,
          query: request.query,
          usage: { inputTokens, outputTokens },
        };
      }
      messages.push({ role: "assistant", content: message.content });
    }

    throw new TaskFailedError(
      `AnthropicWebSearchProvider: the turn stayed paused after ${MAX_PAUSE_RESUMES} resumes.`
    );
  }

  /**
   * A successful `web_search_tool_result` carries a LIST of results; a failed one
   * carries an error OBJECT, and the request still returns HTTP 200 with nothing
   * thrown. Branching on that is what keeps a quota failure from being recorded
   * as a search that legitimately found nothing.
   */
  private collect(
    content: readonly unknown[],
    results: SearchResult[],
    answerParts: string[],
    seen: Set<string>
  ): void {
    for (const raw of content) {
      const block = raw as { type?: string; text?: string; content?: unknown };
      if (block.type === "text" && typeof block.text === "string") {
        answerParts.push(block.text);
        continue;
      }
      if (block.type !== "web_search_tool_result") continue;

      const inner = block.content;
      if (!Array.isArray(inner)) {
        const errorCode =
          (inner as { error_code?: string } | undefined)?.error_code ?? "unknown_error";
        throw new TaskFailedError(`AnthropicWebSearchProvider: web search failed (${errorCode}).`);
      }
      for (const entry of inner as readonly AnthropicSearchResultBlock[]) {
        if (entry.type !== "web_search_result") continue;
        // Results are a source list: one URL returned by two of the turn's
        // searches is one source, and keeping both spends the caller's
        // `maxResults` budget on a repeat.
        if (entry.url !== undefined) {
          if (seen.has(entry.url)) continue;
          seen.add(entry.url);
        }
        results.push({
          title: entry.title ?? entry.url ?? "",
          url: entry.url ?? "",
          snippet: undefined,
          content: undefined,
          publishedDate: toIsoPublishedDate(entry.page_age),
          score: undefined,
          favicon: undefined,
        });
      }
    }
  }
}
