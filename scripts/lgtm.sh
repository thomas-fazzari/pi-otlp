#!/usr/bin/env bash
#MISE description="Runs the local grafana/otel-lgtm with the Pi dashboard, and creates or starts its container when needed. Pass --recreate to apply a configuration change. The data stays"
set -euo pipefail
ready_timeout_seconds=120
grafana=http://127.0.0.1:$LGTM_GRAFANA_PORT
otlp=http://127.0.0.1:$LGTM_OTLP_PORT

status=$(docker ps --all --filter "name=^$LGTM_NAME\$" --format '{{.State}}')
if [ "${1:-}" = "--recreate" ] && [ -n "$status" ]; then
  echo "Removing $LGTM_NAME"
  docker rm --force "$LGTM_NAME" >/dev/null
  status=
fi

if [ "$status" != running ]; then
  if [ -z "$status" ]; then
    echo "Creating $LGTM_NAME"
    # Loopback only, otel-lgtm's Grafana gives anonymous visitors the Admin role
    docker run --detach --name "$LGTM_NAME" --restart unless-stopped \
      --publish "127.0.0.1:$LGTM_GRAFANA_PORT:3000" \
      --publish "127.0.0.1:$LGTM_OTLP_PORT:4318" \
      --volume "$LGTM_DATA:/data" \
      --volume "$PWD/grafana:/pi-otlp/grafana:ro" \
      --volume "$PWD/grafana/dashboards.yaml:/otel-lgtm/grafana/conf/provisioning/dashboards/pi-otlp.yaml:ro" \
      --env "PROMETHEUS_EXTRA_ARGS=--storage.tsdb.retention.time=$LGTM_RETENTION" \
      "$LGTM_IMAGE" >/dev/null
  else
    echo "Starting $LGTM_NAME"
    docker start "$LGTM_NAME" >/dev/null
  fi
  deadline=$((SECONDS + ready_timeout_seconds))
  until curl -fs -o /dev/null --max-time 5 "$grafana/api/health" &&
    curl -fs -o /dev/null --max-time 5 -H 'content-type: application/json' \
      -d '{"resourceMetrics":[]}' "$otlp/v1/metrics"; do
    if ((SECONDS > deadline)); then
      echo "Grafana or the OTLP receiver of $LGTM_NAME did not answer within $ready_timeout_seconds s" >&2
      exit 1
    fi
    sleep 1
  done
fi

echo "Grafana: $grafana"
echo "Pi dashboard: $grafana/d/pi-otlp/pi"
