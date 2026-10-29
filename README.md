# pi-otlp

A Pi extension that exports OpenTelemetry metrics, traces and logs over OTLP/HTTP.

## Setup

You need Docker and [mise](https://mise.jdx.dev). From a clone of this repository, start Grafana with its OTLP receiver and install the extension in Pi:

```sh
mise run quickstart
```

Grafana runs on <http://127.0.0.1:3000>, and the Pi dashboard on <http://127.0.0.1:3000/d/pi-otlp/pi>.
