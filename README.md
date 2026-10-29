# pi-otlp

[![CI](https://img.shields.io/github/actions/workflow/status/thomas-fazzari/pi-otlp/ci.yml?branch=master&label=CI)](https://github.com/thomas-fazzari/pi-otlp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@thomas-fazzari/pi-otlp?logo=npm&logoColor=white)](https://www.npmjs.com/package/@thomas-fazzari/pi-otlp)
[![License](https://img.shields.io/github/license/thomas-fazzari/pi-otlp)](LICENSE)

A [Pi](https://pi.dev) extension that exports OpenTelemetry metrics, traces and logs over OTLP/HTTP.

## Install

```sh
pi install npm:@thomas-fazzari/pi-otlp
```

The extension sends to `http://127.0.0.1:4318` by default. See [Configuration](#configuration) to change it.

## Grafana

[grafana/otel-lgtm](https://github.com/grafana/docker-otel-lgtm) runs Grafana, Prometheus, Tempo, Loki and an OTLP receiver in one container. Start it with Docker:

```sh
docker run --detach --name lgtm --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --publish 127.0.0.1:4318:4318 \
  --volume lgtm-data:/data \
  grafana/otel-lgtm:0.38.0
```

Keep the ports on `127.0.0.1`, because the Grafana in this image gives anonymous visitors the Admin role.

To add the Pi dashboard, download [pi-otlp.json](https://github.com/thomas-fazzari/pi-otlp/releases/latest/download/pi-otlp.json). In Grafana at <http://127.0.0.1:3000>, open **Dashboards**, then **New**, then **Import**, and upload the file.

## Configuration

The extension reads these environment variables.

| Variable                      | Default                 | Effect                                                                                                |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:4318` | Base URL of the OTLP/HTTP receiver. The extension appends `/v1/metrics`, `/v1/traces` and `/v1/logs`. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000`                 | Milliseconds between metric exports.                                                                  |
| `OTEL_BSP_SCHEDULE_DELAY`     | `5000`                  | Milliseconds between span exports.                                                                    |
| `OTEL_BLRP_SCHEDULE_DELAY`    | `5000`                  | Milliseconds between log exports.                                                                     |
| `OTEL_SDK_DISABLED`           | `false`                 | `true` turns off every export.                                                                        |
| `PI_OTLP_LOG_ERROR_MESSAGES`  | `false`                 | `true` adds the error message to the `pi.model.request.failed` and `pi.compaction.failed` events.     |

## Telemetry

Every Pi metric, span and log event carries `pi.session.kind`, which is `main` or `subagent`. Spans and log events also carry the Pi session ID as `gen_ai.conversation.id`. Names follow the OpenTelemetry semantic conventions for generative AI where one exists.

- Metrics: `pi.token.usage` by token type, `pi.cost` in USD, `gen_ai.client.operation.duration` for model requests, `pi.tool.calls` and `pi.tool.duration`. The `otel.sdk.exporter.*` and `otel.sdk.processor.*` metrics count exported and dropped records.
- Traces: an `invoke_agent` span for each agent run, with a `pi.turn` span for each turn. Each turn holds a `chat` span for each model request and an `execute_tool` span for each tool call.
- Logs: the events `pi.session.start`, `pi.session.shutdown`, `pi.model.select`, `pi.thinking_level.select`, `pi.compaction`, `pi.compaction.failed` and `pi.model.request.failed`.

## Content policy

The extension exports metadata only, such as model and provider names, token counts, costs, durations, tool names and error types. It never exports prompts, responses, tool arguments or tool results.

Error messages are free text, so failure events leave them out by default. Set `PI_OTLP_LOG_ERROR_MESSAGES=true` to add them as `pi.error.message`.

## Subagents

A subagent session is marked with `pi.session.kind=subagent` and its agent name, from the `<active_agent>` tag that the below extensions write in each child prompt:

- [@tintinweb/pi-subagents](https://www.npmjs.com/package/@tintinweb/pi-subagents): every child.
- [pi-subagents](https://www.npmjs.com/package/pi-subagents): background children only. Foreground children load no extensions, so we export nothing for them.

Children of other extensions count as main sessions.

## Development

You need Docker and [mise](https://mise.jdx.dev). Quickstart starts Grafana with the Pi dashboard and installs the extension in Pi from the clone:

```sh
git clone https://github.com/thomas-fazzari/pi-otlp.git
cd pi-otlp
mise run quickstart
```

If you already installed from npm and started the `lgtm` container above, first run `pi remove npm:@thomas-fazzari/pi-otlp` and `docker rm --force lgtm`. Otherwise Pi loads the extension twice and Grafana lacks the dashboard.

The dashboard is at <http://127.0.0.1:3000/d/pi-otlp/pi>. [CONTRIBUTING.md](CONTRIBUTING.md) lists the checks for a pull request.
