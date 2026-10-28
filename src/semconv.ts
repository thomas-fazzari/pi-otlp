// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

// Copied from @opentelemetry/semantic-conventions 1.44.0, which advises copying incubating definitions instead of importing them.

export const ATTR_ERROR_TYPE = "error.type";
export const ATTR_OTEL_COMPONENT_TYPE = "otel.component.type";
export const ATTR_SERVICE_INSTANCE_ID = "service.instance.id";
export const ATTR_SERVICE_NAME = "service.name";
export const ATTR_SERVICE_VERSION = "service.version";

export const ERROR_TYPE_VALUE_OTHER = "_OTHER";

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
