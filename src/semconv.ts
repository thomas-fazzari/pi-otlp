// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

// Copied from @opentelemetry/semantic-conventions 1.44.0, which advises copying incubating definitions instead of importing them.

export const ATTR_ERROR_TYPE = "error.type";
export const ATTR_GEN_AI_AGENT_NAME = "gen_ai.agent.name";
export const ATTR_GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";
export const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const ATTR_GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
export const ATTR_GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";
export const ATTR_GEN_AI_RESPONSE_ID = "gen_ai.response.id";
export const ATTR_GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const ATTR_GEN_AI_TOKEN_TYPE = "gen_ai.token.type";
export const ATTR_GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const ATTR_GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS =
  "gen_ai.usage.cache_creation.input_tokens";
export const ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read.input_tokens";
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS = "gen_ai.usage.reasoning.output_tokens";
export const ATTR_OTEL_COMPONENT_TYPE = "otel.component.type";
export const ATTR_SERVICE_INSTANCE_ID = "service.instance.id";
export const ATTR_SERVICE_NAME = "service.name";
export const ATTR_SERVICE_VERSION = "service.version";

export const ERROR_TYPE_VALUE_OTHER = "_OTHER";

export const GEN_AI_OPERATION_NAME_VALUE_CHAT = "chat";
export const GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL = "execute_tool";
export const GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT = "invoke_agent";
export const GEN_AI_TOKEN_TYPE_VALUE_INPUT = "input";
export const GEN_AI_TOKEN_TYPE_VALUE_OUTPUT = "output";

export const METRIC_GEN_AI_CLIENT_OPERATION_DURATION = "gen_ai.client.operation.duration";

export const METRIC_OTEL_SDK_EXPORTER_LOG_EXPORTED = "otel.sdk.exporter.log.exported";
export const METRIC_OTEL_SDK_EXPORTER_METRIC_DATA_POINT_EXPORTED =
  "otel.sdk.exporter.metric_data_point.exported";
export const METRIC_OTEL_SDK_EXPORTER_SPAN_EXPORTED = "otel.sdk.exporter.span.exported";
export const METRIC_OTEL_SDK_PROCESSOR_LOG_PROCESSED = "otel.sdk.processor.log.processed";
export const METRIC_OTEL_SDK_PROCESSOR_SPAN_PROCESSED = "otel.sdk.processor.span.processed";

export const OTEL_COMPONENT_TYPE_VALUE_BATCHING_LOG_PROCESSOR = "batching_log_processor";
export const OTEL_COMPONENT_TYPE_VALUE_BATCHING_SPAN_PROCESSOR = "batching_span_processor";
export const OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_LOG_EXPORTER = "otlp_http_json_log_exporter";
export const OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_METRIC_EXPORTER =
  "otlp_http_json_metric_exporter";
export const OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_JSON_SPAN_EXPORTER =
  "otlp_http_json_span_exporter";
