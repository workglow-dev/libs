/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

// Side-effect: registers the default "blob"/"binary" port codecs so JSON-row
// cache backings round-trip inline binary values instead of storing "{}".
import "./cache/BinaryPortCodec";

export * from "./task-graph/Dataflow";
export * from "./task-graph/DataflowEvents";

export * from "./task-graph/GraphEntitlementUtils";
export * from "./task-graph/GraphUsageAggregator";
export * from "./task-graph/GraphFormatScanner";
export * from "./task-graph/GraphSchemaUtils";
export * from "./task-graph/ITaskGraph";
export * from "./task-graph/RunContext";
export * from "./task-graph/RunScheduler";
export * from "./task-graph/StreamPump";
export * from "./task-graph/SubGraphEventBridge";
export * from "./task-graph/TaskGraph";
export * from "./task-graph/TaskGraphJsonShape";
export * from "./task-graph/ThreadPortability";
export * from "./task-graph/TaskGraphEvents";
export * from "./task-graph/TaskGraphRunner";

export * from "./task-graph/EdgeMaterializer";

export * from "./task-graph/Conversions";
export * from "./task-graph/GraphToWorkflowCode";
export * from "./task-graph/IWorkflow";
export * from "./task-graph/LoopBuilderContext";
export * from "./task-graph/Workflow";
export * from "./task-graph/WorkflowBuilder";
export * from "./task-graph/WorkflowCacheAdapter";
export * from "./task-graph/WorkflowEventBridge";
export * from "./task-graph/WorkflowFactories";
export * from "./task-graph/WorkflowPipe";
export * from "./task-graph/WorkflowRunContext";

export * from "./task-graph/autoConnect";
export * from "./task-graph/TransformRegistry";
export * from "./task-graph/transforms";
export * from "./task-graph/TransformTypes";

export * from "./cache";
// Moved to @workglow/util (a pure park/wake primitive with no graph
// knowledge, now also used by the worker protocol, which sits upstream of
// this package). Re-exported so it stays on this package's public surface.
export { BackpressureGate } from "@workglow/util";
export * from "./task/CacheCoordinator";
export * from "./task/StreamProcessor";
export * from "./task/SubGraphDispatch";
export * from "./task/WorkerSubGraphDispatcher";
export * from "./task/TaskRunContext";

export * from "./task";

export * from "./storage/ITaskOutputStorage";
export * from "./storage/TabularTaskOutputStorage";
export * from "./storage/TaskGraphRepository";
export * from "./storage/TaskGraphTabularRepository";
export * from "./storage/RunPrivateTaskOutputRepository";
export * from "./storage/RunPrivateTaskOutputSchema";
export * from "./storage/TaskOutputRepository";
export * from "./storage/TaskOutputStorageSchema";
export * from "./storage/TaskOutputTabularRepository";
export * from "./storage/attachUsageRecorder";
export * from "./storage/RunUsageSchema";

export { getPortCodec, registerPortCodec } from "./storage/PortCodecRegistry";
export type { PortCodec } from "./storage/PortCodecRegistry";
