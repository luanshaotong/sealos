#!/usr/bin/env bash
set -euo pipefail

TARGET_VERSION="${TARGET_VERSION:-}"
SOURCE_IMAGE="${SOURCE_IMAGE:-}"
LOCAL_REGISTRY="${LOCAL_REGISTRY:-sealos.hub:5000}"
TARGET_IMAGE="${TARGET_IMAGE:-}"
MANIFEST_PATH="${MANIFEST_PATH:-/etc/kubernetes/manifests/kube-scheduler.yaml}"
BACKUP_DIR="${BACKUP_DIR:-/etc/kubernetes/manifests/backup}"
KUBECONFIG="${KUBECONFIG:-/etc/kubernetes/admin.conf}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_TAR="${IMAGE_TAR:-}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180s}"
SKIP_FIX=0

log() {
  printf '[修复 kube-scheduler] %s\n' "$*"
}

die() {
  printf '[修复 kube-scheduler] ERROR 错误: %s\n' "$*" >&2
  exit 1
}

current_scheduler_image() {
  awk '
    $1 == "image:" {
      print $2
      exit
    }
  ' "${MANIFEST_PATH}"
}

detect_server_version() {
  if ! command -v kubectl >/dev/null 2>&1; then
    return 1
  fi
  if [ ! -f "${KUBECONFIG}" ]; then
    return 1
  fi

  kubectl --kubeconfig "${KUBECONFIG}" version --short 2>/dev/null | awk -F': ' '/Server Version/ {print $2; exit}'
}

configure_target() {
  local server_version="${SERVER_VERSION:-}"
  if [ -z "${server_version}" ]; then
    server_version="$(detect_server_version || true)"
  fi

  if [ -z "${TARGET_VERSION}" ]; then
    case "${server_version}" in
      v1.27.*)
        TARGET_VERSION="v1.27.15"
        ;;
      *)
        SKIP_FIX=1
        ;;
    esac
  fi

  if [ "${SKIP_FIX}" -eq 1 ]; then
    log "detected server version 检测到集群版本: ${server_version:-unknown}"
    log "cluster is not v1.27.x, skip scheduler hotfix；集群不是 v1.27.x，跳过 scheduler 修复"
    return
  fi

  SOURCE_IMAGE="${SOURCE_IMAGE:-registry.k8s.io/kube-scheduler:${TARGET_VERSION}}"
  TARGET_IMAGE="${TARGET_IMAGE:-${LOCAL_REGISTRY}/kube-scheduler:${TARGET_VERSION}}"
  IMAGE_TAR="${IMAGE_TAR:-${SCRIPT_DIR}/kube-scheduler-${TARGET_VERSION}.tar}"

  log "detected server version 检测到集群版本: ${server_version:-unknown}"
}

load_or_pull_image() {
  if docker image inspect "${TARGET_IMAGE}" >/dev/null 2>&1; then
    log "target image already exists locally 目标镜像本地已存在: ${TARGET_IMAGE}"
    return
  fi

  if [ -f "${IMAGE_TAR}" ]; then
    log "loading image tar 正在加载镜像包: ${IMAGE_TAR}"
    docker load -i "${IMAGE_TAR}"
  elif docker image inspect "${SOURCE_IMAGE}" >/dev/null 2>&1; then
    log "source image already exists locally 源镜像本地已存在: ${SOURCE_IMAGE}"
  else
    log "image tar not found, pulling source image 未找到镜像包，正在拉取源镜像: ${SOURCE_IMAGE}"
    docker pull "${SOURCE_IMAGE}"
  fi

  if docker image inspect "${SOURCE_IMAGE}" >/dev/null 2>&1; then
    docker tag "${SOURCE_IMAGE}" "${TARGET_IMAGE}"
  elif ! docker image inspect "${TARGET_IMAGE}" >/dev/null 2>&1; then
    die "neither source image nor target image exists after load/pull；加载或拉取后仍找不到源镜像和目标镜像"
  fi
}

push_target_image() {
  if ! docker image inspect "${TARGET_IMAGE}" >/dev/null 2>&1; then
    die "target image is not available locally 目标镜像本地不可用: ${TARGET_IMAGE}"
  fi

  if docker push "${TARGET_IMAGE}"; then
    log "pushed target image 已推送目标镜像: ${TARGET_IMAGE}"
  else
    log "warning 警告: failed to push ${TARGET_IMAGE}; 推送失败，但本地已有该镜像，继续执行"
  fi
}

patch_manifest() {
  [ -f "${MANIFEST_PATH}" ] || die "scheduler manifest not found 未找到 scheduler manifest: ${MANIFEST_PATH}"

  local before
  before="$(current_scheduler_image)"
  log "current scheduler image in manifest 当前 manifest 中 scheduler 镜像: ${before:-<empty>}"

  local has_legacy_feature_gates=0
  if printf '%s\n' "${TARGET_VERSION}" | grep -Eq '^v1\.27\.' && grep -Eq -- '--feature-gates=.*(EphemeralContainers|TTLAfterFinished)' "${MANIFEST_PATH}"; then
    has_legacy_feature_gates=1
  fi

  if [ "${before}" = "${TARGET_IMAGE}" ] && [ "${has_legacy_feature_gates}" -eq 0 ]; then
    log "manifest already points to manifest 已经指向 ${TARGET_IMAGE}"
    return
  fi

  mkdir -p "${BACKUP_DIR}"
  local backup="${BACKUP_DIR}/kube-scheduler.yaml.$(date +%Y%m%d%H%M%S).bak"
  cp -a "${MANIFEST_PATH}" "${backup}"
  log "backup written 已写入备份: ${backup}"

  local tmp
  tmp="$(mktemp)"
  awk -v target="${TARGET_IMAGE}" -v remove_legacy="${has_legacy_feature_gates}" '
    function trim(value) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      return value
    }

    !changed && $1 == "image:" {
      match($0, /^[[:space:]]*/)
      print substr($0, RSTART, RLENGTH) "image: " target
      changed = 1
      saw_image = 1
      next
    }
    $1 == "image:" {
      saw_image = 1
    }
    $0 ~ /^[[:space:]]*-[[:space:]]+--feature-gates=/ {
      if (remove_legacy != "1") {
        print
        next
      }

      original = $0
      indent = $0
      sub(/-[[:space:]]+--feature-gates=.*/, "", indent)
      value = $0
      sub(/^[[:space:]]*-[[:space:]]+--feature-gates=/, "", value)

      n = split(value, gates, ",")
      kept = ""
      for (i = 1; i <= n; i++) {
        gate = trim(gates[i])
        if (gate == "" || gate ~ /^(EphemeralContainers|TTLAfterFinished)=/) {
          continue
        }
        kept = kept (kept == "" ? "" : ",") gate
      }

      if (kept == "") {
        feature_changed = 1
        next
      }

      line = indent "- --feature-gates=" kept
      if (line != original) {
        feature_changed = 1
      }
      print line
      next
    }
    { print }
    END {
      if (!saw_image && !changed) {
        exit 2
      }
    }
  ' "${MANIFEST_PATH}" > "${tmp}" || {
    rm -f "${tmp}"
    die "image field not found 未找到 image 字段: ${MANIFEST_PATH}"
  }
  cat "${tmp}" > "${MANIFEST_PATH}"
  rm -f "${tmp}"

  log "manifest patched to manifest 已修改为: ${TARGET_IMAGE}"
  if [ "${has_legacy_feature_gates}" -eq 1 ]; then
    log "removed legacy feature gates 已清理旧版 feature-gates: EphemeralContainers, TTLAfterFinished"
  fi
}

wait_scheduler() {
  if ! command -v kubectl >/dev/null 2>&1; then
    log "kubectl not found 未找到 kubectl; skip rollout verification 跳过发布校验"
    return
  fi
  if [ ! -f "${KUBECONFIG}" ]; then
    log "kubeconfig not found 未找到 kubeconfig: ${KUBECONFIG}; skip rollout verification 跳过发布校验"
    return
  fi

  log "waiting for kube-scheduler pod 等待 kube-scheduler Pod 使用目标镜像 ${TARGET_IMAGE}"
  local end
  end=$((SECONDS + ${WAIT_TIMEOUT%s}))
  while [ "${SECONDS}" -lt "${end}" ]; do
    local images
    images="$(kubectl --kubeconfig "${KUBECONFIG}" -n kube-system get pod -l component=kube-scheduler -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.containers[0].image}{" "}{.status.containerStatuses[0].ready}{"\n"}{end}' 2>/dev/null || true)"
    printf '%s\n' "${images}" | grep -F "${TARGET_IMAGE} true" >/dev/null 2>&1 && {
      log "scheduler is ready with target image；scheduler 已使用目标镜像并就绪"
      printf '%s\n' "${images}"
      return
    }
    sleep 5
  done

  kubectl --kubeconfig "${KUBECONFIG}" -n kube-system get pod -l component=kube-scheduler -o wide || true
  die "scheduler did not become ready with ${TARGET_IMAGE} within ${WAIT_TIMEOUT}；scheduler 在超时时间内未就绪"
}

main() {
  [ "$(id -u)" = "0" ] || die "please run as root on a control-plane node；请在控制平面节点使用 root 执行"
  command -v docker >/dev/null 2>&1 || die "missing command 缺少命令: docker"
  command -v awk >/dev/null 2>&1 || die "missing command 缺少命令: awk"

  configure_target
  if [ "${SKIP_FIX}" -eq 1 ]; then
    return
  fi

  log "target version 目标版本: ${TARGET_VERSION}"
  log "source image 源镜像: ${SOURCE_IMAGE}"
  log "target image 目标镜像: ${TARGET_IMAGE}"
  log "manifest 文件: ${MANIFEST_PATH}"

  load_or_pull_image
  push_target_image
  patch_manifest
  wait_scheduler
}

main "$@"
