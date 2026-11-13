#!/usr/bin/env bash
set -euo pipefail

CASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE="${NAMESPACE:-dual-scheduling-test}"
DEPLOYAPP_API="${DEPLOYAPP_API:-http://127.0.0.1:5002}"
CLUSTER_NODE_IP="${CLUSTER_NODE_IP:-$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')}"
FRONTEND_APP="${FRONTEND_APP:-nginx-env-switch}"
BACKEND_APP="${BACKEND_APP:-python-app-lst}"
FRONTEND_NODEPORT="${FRONTEND_NODEPORT:-32567}"
BACKEND_NODEPORT="${BACKEND_NODEPORT:-32566}"
BUSINESS_PATH="${BUSINESS_PATH:-/test}"
SLOW_BACKEND_NAME="${SLOW_BACKEND_NAME:-latency-slow-backend}"
PYTHON_IMAGE="${PYTHON_IMAGE:-sealos.hub:5000/library/pythonapp:dev}"

log() {
  printf '[backend-latency-test] %s\n' "$*"
}

api_post() {
  local path="$1"
  local json="$2"
  curl -fsS -H 'Content-Type: application/json' -d "$json" "${DEPLOYAPP_API}${path}"
}

cleanup_scheduler_rows() {
  docker exec -i deployapp python - <<PY
import sqlite3
db = '/root/app/scheduling.db'
conn = sqlite3.connect(db)
cur = conn.cursor()
cur.execute("DELETE FROM apps WHERE app_name=? AND namespace=?", ("${FRONTEND_APP}", "${NAMESPACE}"))
cur.execute("DELETE FROM backends")
conn.commit()
conn.close()
PY
}

start_slow_backend() {
  docker rm -f "${SLOW_BACKEND_NAME}" >/dev/null 2>&1 || true
  docker run -d --name "${SLOW_BACKEND_NAME}" --network deployapp_default --entrypoint python "${PYTHON_IMAGE}" \
    -u -c '
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import time

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, content_type="text/plain"):
        if isinstance(body, dict):
            body = json.dumps(body)
            content_type = "application/json"
        body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path.startswith("/ping"):
            time.sleep(0.25)
            return self._send(200, "slow-pong")
        return self._send(200, "slow-backend")
    def do_POST(self):
        if self.path.startswith("/api/delApp"):
            return self._send(200, {"message": "mock old backend app deleted"})
        if self.path.startswith("/api/deployAppWithImage"):
            return self._send(200, {"message": "mock deploy accepted"})
        return self._send(200, {"message": "ok"})
    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)

for port in (5002, 32293, '"${BACKEND_NODEPORT}"'):
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    import threading
    threading.Thread(target=server.serve_forever, daemon=True).start()
print("slow backend ready", flush=True)
while True:
    time.sleep(3600)
' >/dev/null
  docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${SLOW_BACKEND_NAME}"
}

copy_bundles_to_deployapp() {
  mkdir -p "/root/.mxapps/${NAMESPACE}"
  rm -rf "/root/.mxapps/${NAMESPACE:?}/${BACKEND_APP}" "/root/.mxapps/${NAMESPACE:?}/${FRONTEND_APP}"
  cp -a "${CASE_DIR}/bundles/${BACKEND_APP}" "/root/.mxapps/${NAMESPACE}/${BACKEND_APP}"
  cp -a "${CASE_DIR}/bundles/${FRONTEND_APP}" "/root/.mxapps/${NAMESPACE}/${FRONTEND_APP}"
}

ensure_global_configmap() {
  kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n "${NAMESPACE}" create configmap mx-applaunchpad-global-config \
    --from-literal=mx.properties='' \
    --dry-run=client -o yaml | kubectl apply -f -
}

deploy_frontend() {
  api_post "/api/deployAppWithImage" '{"path":"/root/.mxapps/'"${NAMESPACE}"'/'"${FRONTEND_APP}"'","modelName":"frontend-latency-test","modelCode":"frontend-latency-test","versionTag":"v1","liveProbe":"{}","ports":{"80":'"${FRONTEND_NODEPORT}"'}}' >/tmp/frontend-deploy-response.json
  cat /tmp/frontend-deploy-response.json
  kubectl -n "${NAMESPACE}" rollout status deploy/"${FRONTEND_APP}" --timeout=180s
}

wait_for_frontend_value() {
  local expected="$1"
  for _ in $(seq 1 60); do
    value="$(kubectl -n "${NAMESPACE}" get deploy "${FRONTEND_APP}" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="BACKEND_HOST")].value}')"
    if [[ "${value}" == "${expected}" ]]; then
      return 0
    fi
    sleep 2
  done
  log "等待前端 BACKEND_HOST=${expected} 超时，当前值：${value:-<empty>}"
  return 1
}

main() {
  log "准备导入目录和调度测试数据"
  copy_bundles_to_deployapp
  ensure_global_configmap
  cleanup_scheduler_rows

  log "启动慢后端模拟服务"
  SLOW_BACKEND_IP="$(start_slow_backend)"
  DEPLOYAPP_CONTAINER_IP="$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' deployapp)"
  log "慢后端 IP=${SLOW_BACKEND_IP}，deployapp 容器 IP=${DEPLOYAPP_CONTAINER_IP}，集群节点 IP=${CLUSTER_NODE_IP}"

  log "通过 deployapp API 导入 nginx 前端"
  deploy_frontend

  log "把前端初始后端指向慢后端"
  kubectl -n "${NAMESPACE}" set env deploy/"${FRONTEND_APP}" BACKEND_HOST="${SLOW_BACKEND_IP}" BACKEND_PORT="${BACKEND_NODEPORT}"
  kubectl -n "${NAMESPACE}" rollout status deploy/"${FRONTEND_APP}" --timeout=180s
  wait_for_frontend_value "${SLOW_BACKEND_IP}"
  before_response="$(curl -fsS -X POST --max-time 5 "http://${CLUSTER_NODE_IP}:${FRONTEND_NODEPORT}${BUSINESS_PATH}" -H 'Content-Type: application/json' -d '{}' 2>/tmp/frontend-before.err | head -c 120 || true)"
  if [[ -n "${before_response}" ]]; then
    log "切换前业务响应：${before_response}"
  else
    log "切换前业务访问未返回 2xx，错误：$(cat /tmp/frontend-before.err)"
  fi

  log "注册两个后端和前端应用"
  api_post "/api/delete_backend" '{"ip":"'"${SLOW_BACKEND_IP}"'"}' >/dev/null || true
  api_post "/api/delete_backend" '{"ip":"'"${CLUSTER_NODE_IP}"'"}' >/dev/null || true
  api_post "/api/register_backend" '{"ip":"'"${SLOW_BACKEND_IP}"'"}'
  api_post "/api/register_backend" '{"ip":"'"${CLUSTER_NODE_IP}"'"}'
  api_post "/api/register_app" '{"app_name":"'"${FRONTEND_APP}"'","namespace":"'"${NAMESPACE}"'","app2":"'"${BACKEND_APP}"'","namespace2":"'"${NAMESPACE}"'","url_key":"BACKEND_HOST","current_backend":"'"${SLOW_BACKEND_IP}"'","ports":{"5000":'"${BACKEND_NODEPORT}"'}}'

  log "累计延迟样本并触发调度"
  for _ in 1 2 3 4; do
    curl -fsS "${DEPLOYAPP_API}/api/test_latency" >/dev/null
  done
  curl -fsS "${DEPLOYAPP_API}/api/check_all_apps" | tee /tmp/check-all-apps-response.json

  log "等待 Python 后端导入完成"
  kubectl -n "${NAMESPACE}" rollout status deploy/"${BACKEND_APP}" --timeout=240s
  kubectl -n "${NAMESPACE}" get svc "${BACKEND_APP}" -o wide
  wait_for_frontend_value "${CLUSTER_NODE_IP}"
  kubectl -n "${NAMESPACE}" rollout status deploy/"${FRONTEND_APP}" --timeout=180s

  after_response="$(curl -fsS -X POST --max-time 10 "http://${CLUSTER_NODE_IP}:${FRONTEND_NODEPORT}${BUSINESS_PATH}" -H 'Content-Type: application/json' -d '{}' | head -c 120)"
  log "切换后业务响应：${after_response}"
  log "调度表：$(curl -fsS "${DEPLOYAPP_API}/api/get_app_list")"
  log "测试完成"
}

main "$@"
