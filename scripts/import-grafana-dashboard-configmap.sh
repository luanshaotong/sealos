#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-vm}"
CONFIGMAP_NAME="${CONFIGMAP_NAME:-imported-node-exporter-full-dashboard}"
DASHBOARD_SOURCE="${1:-https://grafana.com/api/dashboards/1860/revisions/latest/download}"
LABEL_NAME="${LABEL_NAME:-grafana_dashboard}"
LABEL_VALUE="${LABEL_VALUE:-1}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

dashboard_file="${tmp_dir}/dashboard.json"

if [[ "${DASHBOARD_SOURCE}" =~ ^https?:// ]]; then
  echo "[导入 Grafana Dashboard] downloading dashboard 正在下载 Dashboard: ${DASHBOARD_SOURCE}"
  curl -fsSL "${DASHBOARD_SOURCE}" -o "${dashboard_file}"
else
  echo "[导入 Grafana Dashboard] using local dashboard file 使用本地 Dashboard 文件: ${DASHBOARD_SOURCE}"
  cp "${DASHBOARD_SOURCE}" "${dashboard_file}"
fi

echo "[导入 Grafana Dashboard] validating json 正在校验 JSON"
python3 -m json.tool "${dashboard_file}" >/dev/null

manifest_file="${tmp_dir}/configmap.yaml"

kubectl create configmap "${CONFIGMAP_NAME}" \
  -n "${NAMESPACE}" \
  --from-file=grafana.json="${dashboard_file}" \
  --dry-run=client -o yaml \
| kubectl label -f - "${LABEL_NAME}=${LABEL_VALUE}" --local -o yaml \
> "${manifest_file}"

if kubectl get configmap "${CONFIGMAP_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1; then
  echo "[导入 Grafana Dashboard] replacing ConfigMap 正在替换: ${NAMESPACE}/${CONFIGMAP_NAME}"
  kubectl replace -f "${manifest_file}"
else
  echo "[导入 Grafana Dashboard] creating ConfigMap 正在创建: ${NAMESPACE}/${CONFIGMAP_NAME}"
  kubectl create -f "${manifest_file}"
fi

echo "[导入 Grafana Dashboard] Dashboard ConfigMap applied 已应用: ${NAMESPACE}/${CONFIGMAP_NAME}"
echo "[导入 Grafana Dashboard] Source 来源: ${DASHBOARD_SOURCE}"
echo "[导入 Grafana Dashboard] Grafana sidecar watches label 由 Grafana sidecar 监听标签: ${LABEL_NAME}=${LABEL_VALUE}"
