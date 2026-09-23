#!/usr/bin/env bash
set -uo pipefail

THRESHOLD="${THRESHOLD:-85}"
REPORT_DIR="${REPORT_DIR:-/tmp/sealos-fault-check-$(date +%Y%m%d%H%M%S)}"
KUBECONFIG="${KUBECONFIG:-/etc/kubernetes/admin.conf}"
CONTAINER_DIRS="${CONTAINER_DIRS:-/var/lib/docker /var/lib/containerd /var/lib/kubelet /var/lib/containers /var/lib/cri-dockerd}"
LOCAL_PORTS="${LOCAL_PORTS:-6443 5002 32294}"
NODE_PORTS="${NODE_PORTS:-32293}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-3}"
LOG_TAIL="${LOG_TAIL:-120}"
DRY_RUN="${DRY_RUN:-false}"
CHECK_HOSTS="${CHECK_HOSTS:-}"
LOCAL_HOST="${LOCAL_HOST:-127.0.0.1}"

# Frozen from the current cluster namespace set.
NAMESPACES=(
  calico-apiserver
  calico-system
  default
  ingress-nginx
  kube-node-lease
  kube-public
  kube-system
  openebs
  tigera-operator
  vm
)

mkdir -p "${REPORT_DIR}"
SUMMARY_FILE="${REPORT_DIR}/summary.txt"
: > "${SUMMARY_FILE}"

log() {
  local msg="$*"
  printf '%s %s\n' "$(date '+%F %T')" "${msg}" | tee -a "${SUMMARY_FILE}"
}

log_file_tail() {
  local title="$1"
  local file="$2"
  local lines="${3:-30}"

  [ -s "${file}" ] || return 0
  log "${title}:"
  tail -n "${lines}" "${file}" | while IFS= read -r line; do
    log "  ${line}"
  done
}

run_cmd() {
  if [ "${DRY_RUN}" = "true" ]; then
    log "[dry-run 预演] $*"
    return 0
  fi
  "$@"
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

section() {
  log ""
  log "========== $* =========="
}

check_container_dirs() {
  section "container directory usage 容器相关目录占用"

  local checked_mounts=" "
  local failed=0

  for dir in ${CONTAINER_DIRS}; do
    [ -e "${dir}" ] || {
      log "SKIP 跳过 ${dir}: not found 未找到"
      continue
    }

    local df_line mount usage
    df_line="$(df -P "${dir}" 2>/dev/null | awk 'NR==2 {print}')"
    if [ -z "${df_line}" ]; then
      log "WARN 警告 ${dir}: df failed df 执行失败"
      failed=1
      continue
    fi

    mount="$(printf '%s\n' "${df_line}" | awk '{print $6}')"
    usage="$(printf '%s\n' "${df_line}" | awk '{gsub("%","",$5); print $5}')"

    case "${checked_mounts}" in
      *" ${mount} "*) continue ;;
    esac
    checked_mounts="${checked_mounts}${mount} "

    if [ "${usage}" -ge "${THRESHOLD}" ]; then
      log "FAIL 失败 mount=${mount} usage=${usage}% threshold=${THRESHOLD}% dir=${dir}；磁盘占用超过阈值"
      failed=1
    else
      log "OK 正常 mount=${mount} usage=${usage}% threshold=${THRESHOLD}% dir=${dir}"
    fi
  done

  return "${failed}"
}

resolve_systemd_unit() {
  local candidate
  for candidate in "$@"; do
    if systemctl list-unit-files "${candidate}.service" --no-legend 2>/dev/null | grep -q "^${candidate}.service"; then
      printf '%s\n' "${candidate}"
      return 0
    fi
    if systemctl list-units "${candidate}.service" --all --no-legend 2>/dev/null | grep -q "^${candidate}.service"; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

restart_and_check_unit() {
  local label="$1"
  shift

  has_cmd systemctl || {
    log "WARN 警告 ${label}: systemctl not found 未找到 systemctl"
    return 1
  }

  local unit
  unit="$(resolve_systemd_unit "$@")" || {
    log "WARN 警告 ${label}: service unit not found 未找到服务单元 candidates=[$*]"
    return 1
  }

  if systemctl is-active --quiet "${unit}"; then
    log "OK 正常 ${label}: ${unit}.service active 已运行"
    return 0
  fi

  log "FAIL 失败 ${label}: ${unit}.service inactive 未运行, trying restart 正在尝试重启"
  systemctl status "${unit}" --no-pager -l > "${REPORT_DIR}/${label}-${unit}-before.status" 2>&1 || true
  journalctl -u "${unit}" -n "${LOG_TAIL}" --no-pager > "${REPORT_DIR}/${label}-${unit}-before.journal" 2>&1 || true
  log_file_tail "DETAIL 详情 ${label}: status before restart 重启前状态" "${REPORT_DIR}/${label}-${unit}-before.status" 25
  log_file_tail "DETAIL 详情 ${label}: journal before restart 重启前日志" "${REPORT_DIR}/${label}-${unit}-before.journal" 30

  run_cmd systemctl restart "${unit}"
  sleep 5

  if systemctl is-active --quiet "${unit}"; then
    log "RECOVERED 已恢复 ${label}: ${unit}.service active after restart 重启后已运行"
    systemctl status "${unit}" --no-pager -l > "${REPORT_DIR}/${label}-${unit}-after.status" 2>&1 || true
    return 0
  fi

  log "FAIL 失败 ${label}: ${unit}.service still inactive after restart 重启后仍未运行"
  systemctl status "${unit}" --no-pager -l > "${REPORT_DIR}/${label}-${unit}-after.status" 2>&1 || true
  journalctl -u "${unit}" -n "${LOG_TAIL}" --no-pager > "${REPORT_DIR}/${label}-${unit}.journal" 2>&1 || true
  log_file_tail "DETAIL 详情 ${label}: status after restart 重启后状态" "${REPORT_DIR}/${label}-${unit}-after.status" 25
  log_file_tail "DETAIL 详情 ${label}: journal after restart 重启后日志" "${REPORT_DIR}/${label}-${unit}.journal" 40
  return 1
}

check_registry() {
  local failed=0

  if restart_and_check_unit "registry" registry docker-registry; then
    return 0
  fi

  if has_cmd docker; then
    local containers
    containers="$(docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' | grep -Ei 'registry|sealos.*hub' || true)"
    if [ -z "${containers}" ]; then
      log "WARN 警告 registry: no registry-like docker container found 未找到类似 registry 的 docker 容器"
      return 1
    fi

    printf '%s\n' "${containers}" > "${REPORT_DIR}/registry-containers.txt"
    while read -r name _; do
      [ -n "${name}" ] || continue
      if docker inspect -f '{{.State.Running}}' "${name}" 2>/dev/null | grep -q true; then
        log "OK 正常 registry container 容器: ${name} running 运行中"
      else
        log "FAIL 失败 registry container 容器: ${name} not running 未运行, trying restart 正在尝试重启"
        docker inspect -f 'status={{.State.Status}} exitCode={{.State.ExitCode}} error={{.State.Error}} oomKilled={{.State.OOMKilled}} finishedAt={{.State.FinishedAt}}' "${name}" > "${REPORT_DIR}/registry-${name}.inspect" 2>&1 || true
        docker logs --tail "${LOG_TAIL}" "${name}" > "${REPORT_DIR}/registry-${name}.before.log" 2>&1 || true
        log_file_tail "DETAIL 详情 registry container ${name}: inspect before restart 重启前 inspect" "${REPORT_DIR}/registry-${name}.inspect" 10
        log_file_tail "DETAIL 详情 registry container ${name}: logs before restart 重启前日志" "${REPORT_DIR}/registry-${name}.before.log" 30
        run_cmd docker restart "${name}" >/dev/null
        sleep 3
        if docker inspect -f '{{.State.Running}}' "${name}" 2>/dev/null | grep -q true; then
          log "RECOVERED 已恢复 registry container 容器: ${name} running after restart 重启后运行中"
        else
          log "FAIL 失败 registry container 容器: ${name} still not running 仍未运行"
          docker logs --tail "${LOG_TAIL}" "${name}" > "${REPORT_DIR}/registry-${name}.log" 2>&1 || true
          docker inspect -f 'status={{.State.Status}} exitCode={{.State.ExitCode}} error={{.State.Error}} oomKilled={{.State.OOMKilled}} finishedAt={{.State.FinishedAt}}' "${name}" > "${REPORT_DIR}/registry-${name}.after.inspect" 2>&1 || true
          log_file_tail "DETAIL 详情 registry container ${name}: inspect after restart 重启后 inspect" "${REPORT_DIR}/registry-${name}.after.inspect" 10
          log_file_tail "DETAIL 详情 registry container ${name}: logs after restart 重启后日志" "${REPORT_DIR}/registry-${name}.log" 40
          failed=1
        fi
      fi
    done <<< "${containers}"
    return "${failed}"
  fi

  return 1
}

check_etcd_container() {
  section "etcd container etcd 容器"

  if ! has_cmd docker; then
    log "WARN 警告 etcd: docker not found 未找到 docker"
    return 1
  fi

  local containers failed=0
  containers="$(docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep -E '(^k8s_etcd_|(^|[ /])etcd[- :])' | grep -v '^k8s_POD_' || true)"
  if [ -z "${containers}" ]; then
    containers="$(docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' | grep -E '(^k8s_etcd_|(^|[ /])etcd[- :])' | grep -v '^k8s_POD_' | head -1 || true)"
  fi

  if [ -z "${containers}" ]; then
    log "WARN 警告 etcd: no etcd container found 未找到 etcd 容器"
    return 1
  fi

  printf '%s\n' "${containers}" > "${REPORT_DIR}/etcd-containers.txt"
  while read -r name _; do
    [ -n "${name}" ] || continue
    if docker inspect -f '{{.State.Running}}' "${name}" 2>/dev/null | grep -q true; then
      log "OK 正常 etcd container 容器: ${name} running 运行中"
    else
      log "FAIL 失败 etcd container 容器: ${name} not running 未运行, trying restart 正在尝试重启"
      docker inspect -f 'status={{.State.Status}} exitCode={{.State.ExitCode}} error={{.State.Error}} oomKilled={{.State.OOMKilled}} finishedAt={{.State.FinishedAt}}' "${name}" > "${REPORT_DIR}/etcd-${name}.inspect" 2>&1 || true
      docker logs --tail "${LOG_TAIL}" "${name}" > "${REPORT_DIR}/etcd-${name}.before.log" 2>&1 || true
      log_file_tail "DETAIL 详情 etcd container ${name}: inspect before restart 重启前 inspect" "${REPORT_DIR}/etcd-${name}.inspect" 10
      log_file_tail "DETAIL 详情 etcd container ${name}: logs before restart 重启前日志" "${REPORT_DIR}/etcd-${name}.before.log" 30
      run_cmd docker restart "${name}" >/dev/null
      sleep 5
      if docker inspect -f '{{.State.Running}}' "${name}" 2>/dev/null | grep -q true; then
        log "RECOVERED 已恢复 etcd container 容器: ${name} running after restart 重启后运行中"
      else
        log "FAIL 失败 etcd container 容器: ${name} still not running 仍未运行"
        docker logs --tail "${LOG_TAIL}" "${name}" > "${REPORT_DIR}/etcd-${name}.log" 2>&1 || true
        docker inspect -f 'status={{.State.Status}} exitCode={{.State.ExitCode}} error={{.State.Error}} oomKilled={{.State.OOMKilled}} finishedAt={{.State.FinishedAt}}' "${name}" > "${REPORT_DIR}/etcd-${name}.after.inspect" 2>&1 || true
        log_file_tail "DETAIL 详情 etcd container ${name}: inspect after restart 重启后 inspect" "${REPORT_DIR}/etcd-${name}.after.inspect" 10
        log_file_tail "DETAIL 详情 etcd container ${name}: logs after restart 重启后日志" "${REPORT_DIR}/etcd-${name}.log" 40
        failed=1
      fi
    fi
  done <<< "${containers}"

  return "${failed}"
}

check_services() {
  section "critical services 关键服务"

  local failed=0
  restart_and_check_unit "kubelet" kubelet || failed=1
  restart_and_check_unit "docker" docker || failed=1
  restart_and_check_unit "docker-cri" cri-docker cri-dockerd docker-cri || failed=1
  check_registry || failed=1
  check_etcd_container || failed=1

  return "${failed}"
}

pod_is_abnormal() {
  local phase ready deletion reason
  phase="$1"
  ready="$2"
  deletion="$3"
  reason="$4"

  [ -n "${deletion}" ] && return 0
  case "${phase}" in
    Running|Succeeded)
      [ "${ready}" = "true" ] && return 1
      [ "${phase}" = "Succeeded" ] && return 1
      return 0
      ;;
    *)
      return 0
      ;;
  esac
}

collect_pod_diagnostics() {
  local ns="$1"
  local pod="$2"
  local pod_dir="${REPORT_DIR}/pods/${ns}/${pod}"
  mkdir -p "${pod_dir}"

  kubectl_cmd -n "${ns}" describe pod "${pod}" > "${pod_dir}/describe.txt" 2>&1 || true
  kubectl_cmd -n "${ns}" get pod "${pod}" -o yaml > "${pod_dir}/pod.yaml" 2>&1 || true

  kubectl_cmd -n "${ns}" get pod "${pod}" -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{end}' 2>/dev/null |
    while read -r container; do
      [ -n "${container}" ] || continue
      kubectl_cmd -n "${ns}" logs "${pod}" -c "${container}" --tail="${LOG_TAIL}" > "${pod_dir}/${container}.log" 2>&1 || true
      kubectl_cmd -n "${ns}" logs "${pod}" -c "${container}" --previous --tail="${LOG_TAIL}" > "${pod_dir}/${container}.previous.log" 2>&1 || true
    done

  {
    echo "Events 事件:"
    awk '/^Events:/,0' "${pod_dir}/describe.txt" | tail -80
    echo
    echo "Suspicious lines 可疑日志行:"
    grep -Eai 'error|fail|failed|back-off|BackOff|denied|timeout|unhealthy|CrashLoop|OOM|ImagePull|ErrImagePull|Pending|not found|no such|refused' "${pod_dir}/describe.txt" "${pod_dir}"/*.log 2>/dev/null | tail -120
  } > "${pod_dir}/analysis.txt" || true
}

check_pods() {
  section "abnormal pods in frozen namespaces 固定命名空间中的异常 Pod"

  if ! has_cmd kubectl; then
    log "WARN 警告 pods: kubectl not found 未找到 kubectl"
    return 1
  fi

  local failed=0
  mkdir -p "${REPORT_DIR}/pods"

  for ns in "${NAMESPACES[@]}"; do
    if ! kubectl_cmd get ns "${ns}" >/dev/null 2>&1; then
      log "SKIP 跳过 namespace 命名空间 ${ns}: not found 未找到"
      continue
    fi

    local rows
    rows="$(kubectl_cmd -n "${ns}" get pods -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.status.phase}{"|"}{.metadata.deletionTimestamp}{"|"}{range .status.containerStatuses[*]}{.ready}{","}{end}{"|"}{range .status.containerStatuses[*]}{.state.waiting.reason}{.state.terminated.reason}{","}{end}{"\n"}{end}' 2>/dev/null || true)"
    [ -n "${rows}" ] || {
      log "OK 正常 namespace 命名空间 ${ns}: no pods 无 Pod"
      continue
    }

    local ns_failed=0
    while IFS='|' read -r pod phase deletion readies reasons; do
      [ -n "${pod}" ] || continue
      local ready="true"
      if printf '%s' "${readies}" | grep -q 'false'; then
        ready="false"
      fi

      if pod_is_abnormal "${phase}" "${ready}" "${deletion}" "${reasons}"; then
        log "FAIL 失败 pod ${ns}/${pod}: phase=${phase} ready=${ready} deletion=${deletion:-none} reason=${reasons:-none}；Pod 状态异常"
        collect_pod_diagnostics "${ns}" "${pod}"
        log_file_tail "DETAIL 详情 pod ${ns}/${pod}: analysis 分析摘要" "${REPORT_DIR}/pods/${ns}/${pod}/analysis.txt" 60
        ns_failed=1
        failed=1
      fi
    done <<< "${rows}"

    if [ "${ns_failed}" -eq 0 ]; then
      log "OK 正常 namespace 命名空间 ${ns}: pods healthy Pod 健康"
    fi
  done

  return "${failed}"
}

tcp_check() {
  local host="$1"
  local port="$2"

  if has_cmd nc; then
    nc -z -w "${CONNECT_TIMEOUT}" "${host}" "${port}" >/dev/null 2>&1
    return $?
  fi

  timeout "${CONNECT_TIMEOUT}" bash -c ":</dev/tcp/${host}/${port}" >/dev/null 2>&1
}

tcp_failure_reason() {
  local host="$1"
  local port="$2"
  local output clean_output rc

  if has_cmd nc; then
    output="$(nc -vz -w "${CONNECT_TIMEOUT}" "${host}" "${port}" 2>&1)"
    rc=$?
  else
    output="$(timeout "${CONNECT_TIMEOUT}" bash -c ":</dev/tcp/${host}/${port}" 2>&1)"
    rc=$?
  fi

  if [ "${rc}" -eq 124 ]; then
    printf 'timeout after %ss；连接超时' "${CONNECT_TIMEOUT}"
    return 0
  fi

  clean_output="$(printf '%s' "${output}" | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//')"

  if printf '%s' "${clean_output}" | grep -Eiq 'timed out|timeout|operation timed out'; then
    printf 'timeout after %ss；连接超时: %s' "${CONNECT_TIMEOUT}" "${clean_output}"
  elif printf '%s' "${clean_output}" | grep -Eiq 'refused|Connection refused'; then
    printf 'connection refused；连接被拒绝: %s' "${clean_output}"
  elif printf '%s' "${clean_output}" | grep -Eiq 'No route to host|Network is unreachable'; then
    printf 'network unreachable；网络不可达: %s' "${clean_output}"
  elif printf '%s' "${clean_output}" | grep -Eiq 'Name or service not known|nodename nor servname|not known|Could not resolve'; then
    printf 'resolve failed；域名或地址解析失败: %s' "${clean_output}"
  elif [ -n "${clean_output}" ]; then
    printf 'connect failed；连接失败 rc=%s: %s' "${rc}" "${clean_output}"
  else
    printf 'connect failed；连接失败 rc=%s' "${rc}"
  fi
}

node_ips() {
  if [ -n "${CHECK_HOSTS}" ]; then
    printf '%s\n' ${CHECK_HOSTS}
    return 0
  fi

  if has_cmd kubectl; then
    kubectl_cmd get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' 2>/dev/null | sed '/^$/d'
  fi
}

check_network() {
  section "network connectivity 网络连通性"

  local failed=0
  local hosts port

  for port in ${LOCAL_PORTS}; do
    if tcp_check "${LOCAL_HOST}" "${port}"; then
      log "OK 正常 local 本机 ${LOCAL_HOST}:${port} reachable 可连通"
    else
      log "FAIL 失败 local 本机 ${LOCAL_HOST}:${port} unreachable 不可连通 reason 原因=$(tcp_failure_reason "${LOCAL_HOST}" "${port}")"
      failed=1
    fi
  done

  hosts="$(node_ips | awk '!seen[$0]++')"

  for host in ${hosts}; do
    for port in ${NODE_PORTS}; do
      if tcp_check "${host}" "${port}"; then
        log "OK 正常 ${host}:${port} reachable 可连通"
      else
        log "FAIL 失败 ${host}:${port} unreachable 不可连通 reason 原因=$(tcp_failure_reason "${host}" "${port}")"
        failed=1
      fi
    done
  done

  return "${failed}"
}

main() {
  log "report dir 报告目录: ${REPORT_DIR}"
  log "dry run 预演模式: ${DRY_RUN}"

  local failed=0
  check_container_dirs || failed=1
  check_services || failed=1
  check_pods || failed=1
  check_network || failed=1

  section "result 结果"
  if [ "${failed}" -eq 0 ]; then
    log "PASS 通过 all checks passed 所有检查通过"
  else
    log "FAIL 失败 one or more checks failed; see ${REPORT_DIR}；存在一项或多项检查失败，请查看报告目录"
  fi

  return "${failed}"
}

main "$@"
