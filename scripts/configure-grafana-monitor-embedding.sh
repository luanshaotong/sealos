#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${GRAFANA_NAMESPACE:-vm}"
DEPLOYMENT="${GRAFANA_DEPLOYMENT:-victoria-metrics-k8s-stack-grafana}"
CONFIGMAP="${GRAFANA_CONFIGMAP:-victoria-metrics-k8s-stack-grafana}"
SERVICE="${GRAFANA_SERVICE:-victoria-metrics-k8s-stack-grafana}"
NODE_PORT="${GRAFANA_NODE_PORT:-30971}"

log() {
  printf '[配置 Grafana 监控页] %s\n' "$*"
}

die() {
  printf '[配置 Grafana 监控页] ERROR 错误: %s\n' "$*" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || die "missing command 缺少命令: kubectl"

if kubectl get service -n "${NAMESPACE}" "${SERVICE}" >/dev/null 2>&1; then
  kubectl patch service -n "${NAMESPACE}" "${SERVICE}" --type=merge -p "{
    \"spec\": {
      \"type\": \"NodePort\",
      \"ports\": [
        {
          \"name\": \"service\",
          \"port\": 80,
          \"protocol\": \"TCP\",
          \"targetPort\": 3000,
          \"nodePort\": ${NODE_PORT}
        }
      ]
    }
  }" >/dev/null
  log "Grafana service exposed 已暴露 Grafana Service: ${NAMESPACE}/${SERVICE} nodePort=${NODE_PORT}"
else
  log "Grafana service not found, skip expose 未找到 Grafana Service，跳过暴露: ${NAMESPACE}/${SERVICE}"
fi

if ! kubectl get configmap -n "${NAMESPACE}" "${CONFIGMAP}" >/dev/null 2>&1; then
  log "Grafana configmap not found, skip 未找到 Grafana ConfigMap，跳过: ${NAMESPACE}/${CONFIGMAP}"
  exit 0
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

ini_file="${tmp_dir}/grafana.ini"
kubectl get configmap -n "${NAMESPACE}" "${CONFIGMAP}" -o jsonpath='{.data.grafana\.ini}' > "${ini_file}"

set_ini_value() {
  section="$1"
  key="$2"
  value="$3"

  awk -v section="${section}" -v key="${key}" -v value="${value}" '
    BEGIN {
      in_section = 0
      seen_section = 0
      written = 0
    }
    $0 ~ "^\\[" section "\\]$" {
      if (in_section && !written) {
        print key " = " value
        written = 1
      }
      in_section = 1
      seen_section = 1
      print
      next
    }
    /^\[/ {
      if (in_section && !written) {
        print key " = " value
        written = 1
      }
      in_section = 0
      print
      next
    }
    in_section && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      print key " = " value
      written = 1
      next
    }
    { print }
    END {
      if (!seen_section) {
        print "[" section "]"
        print key " = " value
      } else if (in_section && !written) {
        print key " = " value
      }
    }
  ' "${ini_file}" > "${ini_file}.tmp"
  mv "${ini_file}.tmp" "${ini_file}"
}

set_ini_value security allow_embedding true
set_ini_value auth.anonymous enabled true
set_ini_value auth.anonymous org_role Viewer

kubectl create configmap "${CONFIGMAP}" -n "${NAMESPACE}" \
  --from-file=grafana.ini="${ini_file}" \
  --dry-run=client -o yaml | kubectl apply -f -

if kubectl get deployment -n "${NAMESPACE}" "${DEPLOYMENT}" >/dev/null 2>&1; then
  kubectl rollout restart deployment -n "${NAMESPACE}" "${DEPLOYMENT}"
  kubectl rollout status deployment -n "${NAMESPACE}" "${DEPLOYMENT}" --timeout=180s
fi

log "Grafana embedding and anonymous viewer enabled 已开启 Grafana 嵌入和匿名只读访问"
