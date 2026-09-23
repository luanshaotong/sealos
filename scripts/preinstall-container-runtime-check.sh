#!/usr/bin/env bash
set -euo pipefail

RUNTIMES="${RUNTIMES:-podman docker containerd}"
CHECK_SERVICES="${CHECK_SERVICES:-true}"
CHECK_SOCKETS="${CHECK_SOCKETS:-true}"

log() {
  printf '[安装前容器运行时检查] %s\n' "$*"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

service_exists() {
  local unit="$1"

  if ! has_cmd systemctl; then
    return 1
  fi

  systemctl list-unit-files "${unit}.service" --no-legend 2>/dev/null | grep -q "^${unit}.service" && return 0
  systemctl list-units "${unit}.service" --all --no-legend 2>/dev/null | grep -q "^${unit}.service"
}

socket_exists() {
  local runtime="$1"

  case "${runtime}" in
    podman)
      [ -S /run/podman/podman.sock ] || [ -S /var/run/podman/podman.sock ]
      ;;
    docker)
      [ -S /run/docker.sock ] || [ -S /var/run/docker.sock ]
      ;;
    containerd)
      [ -S /run/containerd/containerd.sock ] || [ -S /var/run/containerd/containerd.sock ]
      ;;
    *)
      return 1
      ;;
  esac
}

detect_runtime() {
  local runtime="$1"
  local found=0

  if has_cmd "${runtime}"; then
    log "发现 ${runtime} 命令: $(command -v "${runtime}")"
    found=1
  fi

  if [ "${CHECK_SERVICES}" = "true" ] && service_exists "${runtime}"; then
    local active_state enabled_state
    active_state="$(systemctl is-active "${runtime}" 2>/dev/null || true)"
    enabled_state="$(systemctl is-enabled "${runtime}" 2>/dev/null || true)"
    log "发现 ${runtime}.service: active/运行状态=${active_state:-unknown} enabled/开机启用=${enabled_state:-unknown}"
    found=1
  fi

  if [ "${CHECK_SOCKETS}" = "true" ] && socket_exists "${runtime}"; then
    log "发现 ${runtime} socket"
    found=1
  fi

  if [ "${found}" -eq 1 ]; then
    return 0
  fi
  return 1
}

main() {
  local failed=0
  local runtime

  log "开始检查本机是否存在容器运行时: ${RUNTIMES}"
  for runtime in ${RUNTIMES}; do
    if detect_runtime "${runtime}"; then
      failed=1
    else
      log "未发现 ${runtime}"
    fi
  done

  if [ "${failed}" -eq 1 ]; then
    log "错误：本机已存在 podman/docker/containerd 相关组件，安装已中止。"
    log "请清理集群或手动卸载已有容器运行时后再继续安装。"
    exit 1
  fi

  log "检查通过：未发现已有 podman/docker/containerd 容器运行时"
}

main "$@"
