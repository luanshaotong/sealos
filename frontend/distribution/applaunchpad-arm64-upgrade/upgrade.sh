#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IMAGE=luanshaotong/sealos-applaunchpad:v0.6.36o-r3-arm64
REGISTRY=${1:-sealos.hub:5000}
TARGET="${REGISTRY%/}/$IMAGE"

docker load -i "$SCRIPT_DIR/sealos-applaunchpad-v0.6.36o-r3-arm64.tar.gz"
docker tag "$IMAGE" "$TARGET"
docker push "$TARGET"
kubectl -n default set image deployment/sealos-applaunchpad-deployment "sealos-applaunchpad=$TARGET"
kubectl -n default rollout status deployment/sealos-applaunchpad-deployment --timeout=300s
