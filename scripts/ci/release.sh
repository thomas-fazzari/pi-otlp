#!/usr/bin/env bash
#MISE description="Creates the GitHub release for RELEASE_TAG with generated notes and the Grafana dashboard"
set -euo pipefail

gh release create "$RELEASE_TAG" grafana/pi-otlp.json --verify-tag --generate-notes
