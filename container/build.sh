#!/bin/bash
# Build NanoClaw container images
# Usage: ./build.sh [TAG] [TARGET]
#   TAG: image tag (default: latest)
#   TARGET: "all" (default), "agent", or "specialist"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TAG="${1:-latest}"
TARGET="${2:-all}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

if [ "$TARGET" = "all" ] || [ "$TARGET" = "agent" ]; then
  echo "Building NanoClaw agent image..."
  ${CONTAINER_RUNTIME} build -t "nanoclaw-agent:${TAG}" .
  echo "Built: nanoclaw-agent:${TAG}"
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "specialist" ]; then
  echo "Building NanoClaw specialist image..."
  ${CONTAINER_RUNTIME} build -t "nanoclaw-specialist:${TAG}" -f Dockerfile.specialist .
  echo "Built: nanoclaw-specialist:${TAG}"
fi

echo ""
echo "Build complete!"
