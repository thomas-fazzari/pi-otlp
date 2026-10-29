# pi-otlp

A Pi extension that exports OpenTelemetry metrics, traces and logs over OTLP/HTTP.

## Setup

You need Docker and [mise](https://mise.jdx.dev). From a clone of this repository, start Grafana with its OTLP receiver and install the extension in Pi:

```sh
mise run quickstart
```

Grafana runs on <http://127.0.0.1:3000>, and the Pi dashboard on <http://127.0.0.1:3000/d/pi-otlp/pi>.

## Subagents

A subagent session is marked with `pi.session.kind=subagent` and its agent name, from the `<active_agent>` tag that the below extensions write in each child prompt:

- [@tintinweb/pi-subagents](https://www.npmjs.com/package/@tintinweb/pi-subagents): every child.
- [pi-subagents](https://www.npmjs.com/package/pi-subagents): background children only. Foreground children load no extensions, so we export nothing for them.

Children of other extensions count as main sessions.
