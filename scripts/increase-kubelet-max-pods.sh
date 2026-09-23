#!/usr/bin/env bash
set -euo pipefail

MAX_PODS="${MAX_PODS:-250}"
KUBELET_CONFIG="${KUBELET_CONFIG:-/var/lib/kubelet/config.yaml}"
KUBELET_FLAGS_ENV="${KUBELET_FLAGS_ENV:-/var/lib/kubelet/kubeadm-flags.env}"
KUBECONFIG="${KUBECONFIG:-/etc/kubernetes/admin.conf}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/kubelet/max-pods-backup}"
DRY_RUN="${DRY_RUN:-false}"
SKIP_RESTART="${SKIP_RESTART:-false}"

log() {
  printf '[提高 maxPods 上限] %s\n' "$*"
}

die() {
  printf '[提高 maxPods 上限] ERROR 错误: %s\n' "$*" >&2
  exit 1
}

run() {
  if [ "${DRY_RUN}" = "true" ]; then
    log "[dry-run 预演] $*"
    return 0
  fi
  "$@"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "must run as root；必须使用 root 用户执行"
  fi
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

kubectl_cmd() {
  if [ -f "${KUBECONFIG}" ]; then
    kubectl --kubeconfig "${KUBECONFIG}" "$@"
  else
    kubectl "$@"
  fi
}

validate_input() {
  case "${MAX_PODS}" in
    ''|*[!0-9]*) die "MAX_PODS must be a positive integer, got: ${MAX_PODS}；MAX_PODS 必须是正整数" ;;
  esac
  if [ "${MAX_PODS}" -lt 1 ]; then
    die "MAX_PODS must be greater than 0；MAX_PODS 必须大于 0"
  fi
  [ -f "${KUBELET_CONFIG}" ] || die "kubelet config not found: ${KUBELET_CONFIG}；未找到 kubelet 配置文件"
}

backup_file() {
  local file="$1"
  [ -f "${file}" ] || return 0

  local backup
  backup="${BACKUP_DIR}/$(basename "${file}").$(date +%Y%m%d%H%M%S).bak"
  run mkdir -p "${BACKUP_DIR}"
  run cp -a "${file}" "${backup}"
  log "backup 备份 ${file} -> ${backup}"
}

update_kubelet_config() {
  local current
  current="$(awk '$1 == "maxPods:" {print $2; exit}' "${KUBELET_CONFIG}" || true)"
  log "current 当前配置 ${KUBELET_CONFIG} maxPods=${current:-not-set}"

  backup_file "${KUBELET_CONFIG}"

  if grep -Eq '^maxPods:[[:space:]]*[0-9]+' "${KUBELET_CONFIG}"; then
    run sed -Ei "s/^maxPods:[[:space:]]*[0-9]+/maxPods: ${MAX_PODS}/" "${KUBELET_CONFIG}"
  else
    run sh -c "printf '\nmaxPods: %s\n' '${MAX_PODS}' >> '${KUBELET_CONFIG}'"
  fi

  log "set 已设置 ${KUBELET_CONFIG} maxPods=${MAX_PODS}"
}

update_kubelet_flags() {
  if [ ! -f "${KUBELET_FLAGS_ENV}" ]; then
    log "skip 跳过 kubelet flags env: ${KUBELET_FLAGS_ENV} not found 未找到"
    return 0
  fi

  backup_file "${KUBELET_FLAGS_ENV}"

  if grep -q -- '--max-pods=' "${KUBELET_FLAGS_ENV}"; then
    run sed -Ei "s/--max-pods=[0-9]+/--max-pods=${MAX_PODS}/g" "${KUBELET_FLAGS_ENV}"
    log "set 已更新 ${KUBELET_FLAGS_ENV} 中已有的 --max-pods=${MAX_PODS}"
  else
    log "no --max-pods flag 未发现 --max-pods 参数: ${KUBELET_FLAGS_ENV}; 将使用 kubelet 配置文件中的值"
  fi
}

cidr_capacity() {
  local cidr="$1"
  local mask
  mask="${cidr#*/}"

  case "${mask}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "${mask}" -gt 31 ]; then
    printf '0\n'
    return 0
  fi

  # IPv4 pod CIDR capacity, minus network and broadcast addresses.
  printf '%s\n' $(( (1 << (32 - mask)) - 2 ))
}

warn_pod_cidr_capacity() {
  has_cmd kubectl || {
    log "skip 跳过 PodCIDR 容量检查: kubectl not found 未找到 kubectl"
    return 0
  }

  local node_name pod_cidrs cidr capacity
  node_name="$(hostname)"
  pod_cidrs="$(kubectl_cmd get node "${node_name}" -o jsonpath='{range .spec.podCIDRs[*]}{.}{"\n"}{end}' 2>/dev/null || true)"
  if [ -z "${pod_cidrs}" ]; then
    pod_cidrs="$(kubectl_cmd get node "${node_name}" -o jsonpath='{.spec.podCIDR}{"\n"}' 2>/dev/null || true)"
  fi

  if [ -z "${pod_cidrs}" ]; then
    log "skip 跳过 PodCIDR 容量检查: node ${node_name} has no podCIDR or cannot be queried；节点没有 PodCIDR 或查询失败"
    return 0
  fi

  while read -r cidr; do
    [ -n "${cidr}" ] || continue
    case "${cidr}" in
      *:*) log "skip 跳过 IPv6 PodCIDR 容量检查: ${cidr}" ;;
      *)
        capacity="$(cidr_capacity "${cidr}" || true)"
        if [ -n "${capacity}" ] && [ "${MAX_PODS}" -gt "${capacity}" ]; then
          log "WARN 警告: node ${node_name} PodCIDR=${cidr} capacity≈${capacity}, smaller than MAX_PODS=${MAX_PODS}；PodCIDR 容量小于 maxPods"
          log "WARN 警告: scheduler may allow more pods than the node PodCIDR can allocate IPs for; 调度器可能允许超过该节点 IP 容量的 Pod，请考虑扩大集群 Pod CIDR 或调整新节点的 node cidr mask"
        else
          log "PodCIDR check PodCIDR 检查: node=${node_name} cidr=${cidr} capacity≈${capacity:-unknown} MAX_PODS=${MAX_PODS}"
        fi
        ;;
    esac
  done <<< "${pod_cidrs}"
}

restart_kubelet() {
  if [ "${SKIP_RESTART}" = "true" ]; then
    log "skip 跳过 kubelet restart 重启，因为 SKIP_RESTART=true"
    return 0
  fi
  if [ "${DRY_RUN}" = "true" ]; then
    log "[dry-run 预演] systemctl daemon-reload"
    log "[dry-run 预演] systemctl restart kubelet"
    log "[dry-run 预演] skip kubelet active check 跳过 kubelet 活跃状态检查"
    return 0
  fi

  has_cmd systemctl || die "systemctl not found；未找到 systemctl"

  systemctl daemon-reload
  systemctl restart kubelet
  sleep 8

  if ! systemctl is-active --quiet kubelet; then
    systemctl status kubelet --no-pager -l >&2 || true
    journalctl -u kubelet -n 80 --no-pager >&2 || true
    die "kubelet is not active after restart；kubelet 重启后未处于 active 状态"
  fi

  log "kubelet restarted and active；kubelet 已重启且处于 active 状态"
}

verify_node_allocatable() {
  if [ "${DRY_RUN}" = "true" ]; then
    log "[dry-run 预演] skip Kubernetes allocatable verification 跳过 Kubernetes allocatable 校验"
    return 0
  fi

  has_cmd kubectl || {
    log "skip 跳过 Kubernetes verification 校验: kubectl not found 未找到 kubectl"
    return 0
  }

  local node_name allocatable
  node_name="$(hostname)"
  allocatable="$(kubectl_cmd get node "${node_name}" -o jsonpath='{.status.allocatable.pods}' 2>/dev/null || true)"

  if [ -z "${allocatable}" ]; then
    log "skip 跳过 Kubernetes verification 校验: cannot read node ${node_name} allocatable pods；无法读取节点可分配 Pod 数"
    return 0
  fi

  log "node 节点 ${node_name} status.allocatable.pods=${allocatable}"
  if [ "${allocatable}" != "${MAX_PODS}" ]; then
    log "WARN 警告: allocatable pods is not ${MAX_PODS} yet; kubelet/node status may need more time to refresh；节点状态可能还需要时间刷新"
  fi
}

main() {
  require_root
  validate_input
  warn_pod_cidr_capacity
  update_kubelet_config
  update_kubelet_flags
  restart_kubelet
  verify_node_allocatable
  log "done 完成"
}

main "$@"
