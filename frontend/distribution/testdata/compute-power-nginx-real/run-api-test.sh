#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://192.168.0.134:32293}"
NODE_HOST="${NODE_HOST:-192.168.0.134}"
NODE_PORT="${NODE_PORT:-31280}"
USERNAME="${USERNAME:-admin}"
PASSWORD="${PASSWORD:-Sealos@2024!Secure}"
LOGIN_CRYPTO_KEY="${LOGIN_CRYPTO_KEY:-SEALOS_LOGIN_CRYPTO_KEY}"
NAMESPACE="${NAMESPACE:-default}"
APP_NAME="${APP_NAME:-compute-power-nginx-real}"
IMAGE="${IMAGE:-sealos.hub:5000/default/compute-power-nginx-real:api-test}"
REGISTRY="${REGISTRY:-sealos.hub:5000}"
REGISTRY_USER="${REGISTRY_USER:-admin}"
REGISTRY_PASS="${REGISTRY_PASS:-passw0rd}"
QPS="${QPS:-1}"
MAX_LATENCY="${MAX_LATENCY:-10000}"

WORK_DIR="$(cd "$(dirname "$0")" && pwd)"
COOKIE_FILE="${WORK_DIR}/cookies.txt"
LOGIN_RESPONSE="${WORK_DIR}/login-response.json"
CREATE_RESPONSE="${WORK_DIR}/create-response.json"
RESULT_RESPONSE="${WORK_DIR}/result-response.json"
REQUEST_CHECK="${WORK_DIR}/request-check.txt"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令: $1"
    exit 1
  fi
}

need_cmd curl
need_cmd docker
need_cmd jq
need_cmd kubectl
need_cmd node

rm -f "${COOKIE_FILE}" "${LOGIN_RESPONSE}" "${CREATE_RESPONSE}" "${RESULT_RESPONSE}" "${REQUEST_CHECK}"

echo "1. 构建并推送 nginx 测试镜像: ${IMAGE}"
docker login -u "${REGISTRY_USER}" -p "${REGISTRY_PASS}" "${REGISTRY}" >/dev/null
docker build -t "${IMAGE}" "${WORK_DIR}"
docker push "${IMAGE}"

echo "2. 部署 nginx 测试应用"
kubectl apply -f "${WORK_DIR}/k8s.yaml"
kubectl rollout status deploy/"${APP_NAME}" -n "${NAMESPACE}" --timeout=180s

echo "3. 验证真实 POST 请求入口"
for _ in $(seq 1 30); do
  if curl -sS -X POST \
    -H 'Content-Type: application/json' \
    -d '{"probe":"before-compute-power"}' \
    "http://${NODE_HOST}:${NODE_PORT}/api" | tee "${REQUEST_CHECK}"; then
    break
  fi
  echo
  echo "等待 NodePort 可访问..."
  sleep 2
done

if ! grep -q '"status":"ok"' "${REQUEST_CHECK}"; then
  echo "NodePort POST 请求未成功"
  exit 1
fi
echo

echo "4. 登录 applaunchpad API"
LOGIN_PAYLOAD="$(
  USERNAME="${USERNAME}" PASSWORD="${PASSWORD}" LOGIN_CRYPTO_KEY="${LOGIN_CRYPTO_KEY}" node <<'NODE'
const crypto = require('crypto');
const key = crypto.createHash('sha256').update(process.env.LOGIN_CRYPTO_KEY).digest();
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const body = JSON.stringify({
  username: process.env.USERNAME,
  password: process.env.PASSWORD
});
const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final(), cipher.getAuthTag()]);
console.log(JSON.stringify({
  encrypted: true,
  alg: 'AES-GCM',
  iv: iv.toString('base64'),
  data: encrypted.toString('base64')
}));
NODE
)"

curl -sS -f \
  -c "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "Origin: ${BASE_URL}" \
  -H "Referer: ${BASE_URL}/login" \
  -d "${LOGIN_PAYLOAD}" \
  "${BASE_URL}/api/platform/login" \
  -o "${LOGIN_RESPONSE}"

CSRF_TOKEN="$(jq -r '.data.csrfToken // empty' "${LOGIN_RESPONSE}")"
KUBECONFIG_JSON="$(jq -c '.data.state.session.kubeconfig' "${LOGIN_RESPONSE}")"
AUTH_HEADER="$(
  KUBECONFIG_JSON="${KUBECONFIG_JSON}" node <<'NODE'
console.log(encodeURIComponent(process.env.KUBECONFIG_JSON));
NODE
)"

if [ -z "${AUTH_HEADER}" ] || [ "${AUTH_HEADER}" = "null" ]; then
  echo "登录响应中没有 kubeconfig"
  cat "${LOGIN_RESPONSE}"
  exit 1
fi

STRESS_ID="compute-nginx-real-$(date +%s)"
QUERY="$(
  STRESS_ID="${STRESS_ID}" \
  NAMESPACE="${NAMESPACE}" \
  APP_NAME="${APP_NAME}" \
  NODE_PORT="${NODE_PORT}" \
  QPS="${QPS}" \
  MAX_LATENCY="${MAX_LATENCY}" \
  node <<'NODE'
const params = new URLSearchParams({
  namespace: process.env.NAMESPACE,
  app_list: process.env.APP_NAME,
  core_api: '/api',
  port: process.env.NODE_PORT,
  qps: process.env.QPS,
  max_latency: process.env.MAX_LATENCY,
  test_data: JSON.stringify({ source: 'compute-power-nginx-real', time: Date.now() }),
  stress_type: 'server',
  stress_id: process.env.STRESS_ID
});
console.log(params.toString());
NODE
)"

echo "5. 通过 applaunchpad API 创建真实测算任务: ${STRESS_ID}"
curl -sS -f \
  -b "${COOKIE_FILE}" \
  -H "Authorization: ${AUTH_HEADER}" \
  -H "X-CSRF-Token: ${CSRF_TOKEN}" \
  -H "Origin: ${BASE_URL}" \
  -H "Referer: ${BASE_URL}/computePower" \
  "${BASE_URL}/api/node/stressTesting?${QUERY}" \
  -o "${CREATE_RESPONSE}"
cat "${CREATE_RESPONSE}"
echo

echo "6. 轮询测算结果"
for _ in $(seq 1 150); do
  curl -sS -f \
    -b "${COOKIE_FILE}" \
    -H "Authorization: ${AUTH_HEADER}" \
    "${BASE_URL}/api/node/computePower" \
    -o "${RESULT_RESPONSE}"

  STATUS="$(
    STRESS_ID="${STRESS_ID}" jq -r '
      .data[]? | select(.[0] == env.STRESS_ID) | .[12]
    ' "${RESULT_RESPONSE}" | tail -n 1
  )"

  if [ "${STATUS}" = "completed" ] || [ "${STATUS}" = "failed" ] || [ "${STATUS}" = "timeout" ]; then
    echo "最终状态: ${STATUS}"
    STRESS_ID="${STRESS_ID}" jq -r '
      .data[]? | select(.[0] == env.STRESS_ID)
    ' "${RESULT_RESPONSE}"
    [ "${STATUS}" = "completed" ]
    exit $?
  fi

  echo "当前状态: ${STATUS:-not-found}"
  sleep 2
done

echo "等待测算结果超时"
cat "${RESULT_RESPONSE}"
exit 1
