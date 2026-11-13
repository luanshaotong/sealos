#!/usr/bin/env bash
set -euo pipefail

CASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OLD_CLUSTER_IP="${OLD_CLUSTER_IP:-192.168.0.125}"
NEW_CLUSTER_IP="${NEW_CLUSTER_IP:-192.168.0.134}"
NAMESPACE="${NAMESPACE:-dual-scheduling-test}"
FRONTEND_APP="${FRONTEND_APP:-nginx-env-switch}"
BACKEND_APP="${BACKEND_APP:-python-app-lst}"
FRONTEND_NODEPORT="${FRONTEND_NODEPORT:-32567}"
BACKEND_NODEPORT="${BACKEND_NODEPORT:-32566}"
BUSINESS_PATH="${BUSINESS_PATH:-/test}"
SSH_OPTS=(-o StrictHostKeyChecking=no)

log() {
  printf '[real-dual-cluster-test] %s\n' "$*"
}

old_ssh() {
  ssh "${SSH_OPTS[@]}" "root@${OLD_CLUSTER_IP}" "$@"
}

old_api_post() {
  local path="$1"
  local json="$2"
  old_ssh "curl -fsS -H 'Content-Type: application/json' -d '${json}' http://127.0.0.1:5002${path}"
}

prepare_bundle_on_old_cluster() {
  old_ssh "mkdir -p /root/.mxapps/${NAMESPACE} && rm -rf /root/.mxapps/${NAMESPACE}/${FRONTEND_APP} /root/.mxapps/${NAMESPACE}/${BACKEND_APP}"
  scp "${SSH_OPTS[@]}" -r \
    "${CASE_DIR}/bundles/${FRONTEND_APP}" \
    "${CASE_DIR}/bundles/${BACKEND_APP}" \
    "root@${OLD_CLUSTER_IP}:/root/.mxapps/${NAMESPACE}/" >/dev/null
}

prepare_bundle_on_new_cluster() {
  mkdir -p "/root/.mxapps/${NAMESPACE}"
  rm -rf "/root/.mxapps/${NAMESPACE:?}/${FRONTEND_APP}" "/root/.mxapps/${NAMESPACE:?}/${BACKEND_APP}"
  cp -a "${CASE_DIR}/bundles/${FRONTEND_APP}" "${CASE_DIR}/bundles/${BACKEND_APP}" "/root/.mxapps/${NAMESPACE}/"
}

cleanup_clusters() {
  kubectl delete ns "${NAMESPACE}" --ignore-not-found --wait=false >/dev/null
  old_ssh "export KUBECONFIG=/etc/kubernetes/admin.conf; kubectl delete ns '${NAMESPACE}' --ignore-not-found --wait=false >/dev/null; docker exec -i deployapp python - <<'PY'
import sqlite3
conn = sqlite3.connect('/root/app/scheduling.db')
cur = conn.cursor()
cur.execute('DELETE FROM apps WHERE namespace=?', ('${NAMESPACE}',))
cur.execute('DELETE FROM backends')
conn.commit()
conn.close()
PY"
}

wait_namespace_deleted() {
  for _ in $(seq 1 60); do
    if ! kubectl get ns "${NAMESPACE}" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  old_ssh "for i in \$(seq 1 60); do export KUBECONFIG=/etc/kubernetes/admin.conf; kubectl get ns '${NAMESPACE}' >/dev/null 2>&1 || exit 0; sleep 2; done; exit 1"
}

prepare_namespace() {
  kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n "${NAMESPACE}" create configmap mx-applaunchpad-global-config \
    --from-literal=mx.properties='' \
    --dry-run=client -o yaml | kubectl apply -f -
  old_ssh "export KUBECONFIG=/etc/kubernetes/admin.conf; kubectl create namespace '${NAMESPACE}' --dry-run=client -o yaml | kubectl apply -f -; kubectl -n '${NAMESPACE}' create configmap mx-applaunchpad-global-config --from-literal=mx.properties='' --dry-run=client -o yaml | kubectl apply -f -"
}

deploy_old_cluster_apps() {
  old_api_post "/api/deployAppWithImage" "{\"path\":\"/root/.mxapps/${NAMESPACE}/${BACKEND_APP}\",\"modelName\":\"backend-latency-test\",\"modelCode\":\"backend-latency-test\",\"versionTag\":\"v1\",\"liveProbe\":\"{}\",\"ports\":{\"5000\":${BACKEND_NODEPORT}}}"
  old_api_post "/api/deployAppWithImage" "{\"path\":\"/root/.mxapps/${NAMESPACE}/${FRONTEND_APP}\",\"modelName\":\"frontend-latency-test\",\"modelCode\":\"frontend-latency-test\",\"versionTag\":\"v1\",\"liveProbe\":\"{}\",\"ports\":{\"80\":${FRONTEND_NODEPORT}}}"
  old_ssh "export KUBECONFIG=/etc/kubernetes/admin.conf; kubectl -n '${NAMESPACE}' set env deploy/'${FRONTEND_APP}' BACKEND_HOST='${OLD_CLUSTER_IP}' BACKEND_PORT='${BACKEND_NODEPORT}'; kubectl -n '${NAMESPACE}' rollout status deploy/'${BACKEND_APP}' --timeout=240s; kubectl -n '${NAMESPACE}' rollout status deploy/'${FRONTEND_APP}' --timeout=240s"
}

trigger_scheduling() {
  old_api_post "/api/register_backend" "{\"ip\":\"${NEW_CLUSTER_IP}\"}"
  old_api_post "/api/register_app" "{\"app_name\":\"${FRONTEND_APP}\",\"namespace\":\"${NAMESPACE}\",\"app2\":\"${BACKEND_APP}\",\"namespace2\":\"${NAMESPACE}\",\"url_key\":\"BACKEND_HOST\",\"current_backend\":\"${OLD_CLUSTER_IP}\",\"ports\":{\"5000\":${BACKEND_NODEPORT}}}"
  old_ssh "for i in 1 2 3 4; do curl -fsS http://127.0.0.1:5002/api/test_latency >/dev/null; done; curl -fsS http://127.0.0.1:5002/api/check_all_apps"
}

main() {
  log "准备两个真实集群的导入包"
  prepare_bundle_on_old_cluster
  prepare_bundle_on_new_cluster

  log "清理旧测试资源"
  cleanup_clusters
  wait_namespace_deleted
  prepare_namespace

  log "在旧集群 ${OLD_CLUSTER_IP} 部署前端和旧后端"
  deploy_old_cluster_apps
  log "切换前响应：$(curl -fsS -X POST --max-time 10 "http://${OLD_CLUSTER_IP}:${FRONTEND_NODEPORT}${BUSINESS_PATH}" -H 'Content-Type: application/json' -d '{}')"

  log "触发旧集群 deployapp 调度到新集群 ${NEW_CLUSTER_IP}"
  trigger_scheduling

  log "验证新集群后端"
  kubectl -n "${NAMESPACE}" rollout status deploy/"${BACKEND_APP}" --timeout=240s
  kubectl -n "${NAMESPACE}" get deploy,svc,pod -o wide

  log "验证旧集群前端环境变量"
  old_ssh "export KUBECONFIG=/etc/kubernetes/admin.conf; kubectl -n '${NAMESPACE}' rollout status deploy/'${FRONTEND_APP}' --timeout=180s; kubectl -n '${NAMESPACE}' get deploy '${FRONTEND_APP}' -o jsonpath='{.spec.template.spec.containers[0].env}'; echo"
  log "切换后响应：$(curl -fsS -X POST --max-time 10 "http://${OLD_CLUSTER_IP}:${FRONTEND_NODEPORT}${BUSINESS_PATH}" -H 'Content-Type: application/json' -d '{}')"

  log "调度表：$(old_ssh 'curl -fsS http://127.0.0.1:5002/api/get_app_list')"
  log "如果调度表仍显示旧后端，请查看旧集群 deployapp 日志中的 CSRF 校验失败，这是当前调度删除旧应用请求缺少 X-CSRF-Token 导致。"
}

main "$@"
