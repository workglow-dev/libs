/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared base for AI tasks that produce a single ImageValue output, with
 * streaming partial-image support. The streaming convention follows the
 * existing snapshot/finish contract on StreamingAiTask: providers yield
 * `{ type: "snapshot", data: { image: ImageValue } }` for each partial image
 * (and the final), then `{ type: "finish", data: {} }`.
 *
 * This base class:
 * - Tracks the latest partial in `_latestPartial`. ImageValue lifetime is
 *   JS GC; there is no retain/release. When a new snapshot arrives, the
 *   prior partial is simply replaced and becomes garbage-collectable.
 * - Exposes the latest partial via `executePreview()` so downstream image
 *   tasks can refresh their preview chains live as the image refines.
 * - Returns `undefined` (no output) when no partial and no prior run exist,
 *   so the UI shows nothing rather than a synthetic placeholder.
 * - Treats the task as not cacheable when `input.seed` is undefined, since
 *   image generation without a seed is non-deterministic.
 */

import type {
  CachePolicy,
  IExecuteContext,
  IExecutePreviewContext,
  StreamEvent,
  TaskConfig,
  TaskOutput,
} from "@workglow/task-graph";
import type { ImageValue } from "@workglow/util/media";

import { ProviderUnsupportedFeatureError } from "../../errors/ImageGenerationErrors";
import type { ModelConfig } from "../../model/ModelSchema";
import type { AiTaskInput } from "./AiTask";
import { StreamingAiTask } from "./StreamingAiTask";

export interface AiImageOutput extends TaskOutput {
  image: ImageValue;
}

export interface AiImageInputBase extends AiTaskInput {
  prompt: string;
  seed?: number | undefined;
}

export class AiImageOutputTask<
  Input extends AiImageInputBase = AiImageInputBase,
  Config extends TaskConfig<Input> = TaskConfig<Input>,
> extends StreamingAiTask<Input, AiImageOutput, Config> {
  public static override type: string = "AiImageOutputTask";
  protected static override readonly streamingPhaseLabel = "Rendering";

  /** The most recent partial received from the provider stream. ImageValue
   *  lifetime is JS GC — replacing the slot lets the prior become collectable. */
  protected _latestPartial: ImageValue | undefined = undefined;

  public override getCachePolicy(inputs: Input): CachePolicy {
    // The base resolution first, so a caller's `cacheable: false` still wins: a seed
    // makes the output reproducible, it does not override the caller opting out.
    const base = super.getCachePolicy(inputs);
    if (base.kind === "none") return base;
    const seed = (inputs as { seed?: number | null } | undefined)?.seed;
    if (seed === undefined || seed === null) return { kind: "private" };
    return { kind: "deterministic" };
  }

  /**
   * Called by executeStream() (or directly by tests) for each partial image
   * delivered by the provider. Replaces the prior `_latestPartial`. ImageValue
   * lifetime is JS GC — no retain/release dance required.
   */
  protected ingestPartial(image: ImageValue): void {
    this._latestPartial = image;
  }

  /**
   * Transfers the latest partial out of the task, clearing the internal slot.
   * Used to hand the final image to the runner via the snapshot/finish path
   * so the output port owns the reference.
   */
  protected takeFinalPartial(): ImageValue | undefined {
    const partial = this._latestPartial;
    this._latestPartial = undefined;
    return partial;
  }

  /**
   * Clears the latest partial. Used on abort/error.
   */
  protected discardPartial(): void {
    this._latestPartial = undefined;
  }

  /**
   * Wraps the StreamingAiTask stream to track partial images via ingestPartial,
   * so executePreview() can surface the latest partial mid-stream.
   *
   * Providers yield `{ type: "snapshot", data: { image: ImageValue } }` for each
   * partial (and the final). On `finish`, we clear `_latestPartial` — the final
   * image is owned by `runOutputData`.
   *
   * Note: this relies on the runner's snapshot-mode accumulator falling back
   * to `runOutputData` when `finish.data` is empty (see `TaskRunner` finish
   * handling). Providers MUST yield the final image as a `snapshot` event
   * before `finish`, and `finish.data` MUST stay empty — otherwise the
   * runner would overwrite the accumulated snapshot with empty data.
   */
  override async *executeStream(
    input: Input,
    context: IExecuteContext
  ): AsyncIterable<StreamEvent<AiImageOutput>> {
    try {
      for await (const event of super.executeStream(input, context)) {
        if (event.type === "snapshot") {
          const newImage = (event.data as AiImageOutput | undefined)?.image;
          if (newImage) {
            this.ingestPartial(newImage);
          }
          yield event;
        } else if (event.type === "finish") {
          this._latestPartial = undefined;
          yield event;
        } else {
          yield event;
        }
      }
    } catch (err) {
      // Drop any retained partial on error so the task doesn't surface a
      // stale preview. The normal completion path clears _latestPartial in
      // the "finish" branch; this only fires when an exception escapes.
      this.discardPartial();
      throw err;
    }
  }

  /**
   * Cheap UI preview path. NEVER calls the provider.
   * Order of preference:
   *   1. Live partial currently in `_latestPartial`.
   *   2. Last completed run's output (`runOutputData.image`).
   *   3. `undefined` — no output, so the UI shows nothing instead of a
   *      synthetic placeholder.
   */
  override async executePreview(
    _input: Input,
    _context: IExecutePreviewContext
  ): Promise<AiImageOutput | undefined> {
    if (this._latestPartial !== undefined) {
      return { image: this._latestPartial };
    }
    const prior = (this.runOutputData as AiImageOutput | undefined)?.image;
    if (prior !== undefined) {
      return { image: prior };
    }
    return undefined;
  }

  /**
   * Called by the runner on abort. Clears any retained partial.
   * Errors during executeStream are handled inline via the catch block.
   */
  async cleanup(): Promise<void> {
    this.discardPartial();
  }

  /**
   * Hook for subclasses + providers to reject unsupported (model, input)
   * combinations before any worker dispatch. Subclasses call this from
   * their own validateInput() override after super.validateInput().
   *
   * Each provider implements the per-feature checks (e.g., Gemini + mask).
   * Throws ProviderUnsupportedFeatureError on rejection.
   */
  protected async validateProviderImageInput(input: Input): Promise<void> {
    const model = input.model as ModelConfig | string | undefined;
    if (!model || typeof model === "string") return;
    const provider = model.provider;
    const validator = AiImageOutputTask._providerValidators.get(provider);
    if (validator) {
      await validator(this.type, input as unknown as Record<string, unknown>, model);
    }
  }

  /**
   * Provider-side validators register here at provider load time. Each
   * validator inspects (taskType, input, model) and throws
   * ProviderUnsupportedFeatureError if the combination is invalid.
   */
  private static _providerValidators: Map<
    string,
    (taskType: string, input: Record<string, unknown>, model: ModelConfig) => Promise<void> | void
  > = new Map();

  public static registerProviderImageValidator(
    providerName: string,
    validator: (
      taskType: string,
      input: Record<string, unknown>,
      model: ModelConfig
    ) => Promise<void> | void
  ): void {
    AiImageOutputTask._providerValidators.set(providerName, validator);
  }

  public static unregisterProviderImageValidator(providerName: string): void {
    AiImageOutputTask._providerValidators.delete(providerName);
  }

  // Keep a reference to the unsupported error class so tests/providers don't
  // need to import it separately when overriding validators.
  public static readonly UnsupportedFeatureError = ProviderUnsupportedFeatureError;
}
