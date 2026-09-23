#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://192.168.0.134:32293}"
USERNAME="${USERNAME:-admin}"
PASSWORD="${PASSWORD:-Sealos@2024!Secure}"
LOGIN_CRYPTO_KEY="${LOGIN_CRYPTO_KEY:-SEALOS_LOGIN_CRYPTO_KEY}"
NAMESPACE="${NAMESPACE:-default}"
IMAGE_NAME="${IMAGE_NAME:-offline-api-test}"
IMAGE_TAG="${IMAGE_TAG:-api-smoke}"

WORK_DIR="$(cd "$(dirname "$0")" && pwd)"
ZIP_FILE="${WORK_DIR}/offline-build-context.zip"
COOKIE_FILE="${WORK_DIR}/cookies.txt"
LOGIN_RESPONSE="${WORK_DIR}/login-response.json"
UPLOAD_RESPONSE="${WORK_DIR}/upload-response.json"
BUILD_RESPONSE="${WORK_DIR}/build-response.json"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令: $1"
    exit 1
  fi
}

need_cmd curl
need_cmd jq
need_cmd node
need_cmd zip

rm -f "${ZIP_FILE}" "${COOKIE_FILE}" "${LOGIN_RESPONSE}" "${UPLOAD_RESPONSE}" "${BUILD_RESPONSE}"

(
  cd "${WORK_DIR}"
  zip -qr "${ZIP_FILE}" Dockerfile files
)

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

if [ -z "${CSRF_TOKEN}" ] || [ "${CSRF_TOKEN}" = "null" ]; then
  echo "登录成功响应中没有 csrfToken"
  cat "${LOGIN_RESPONSE}"
  exit 1
fi

if [ -z "${KUBECONFIG_JSON}" ] || [ "${KUBECONFIG_JSON}" = "null" ]; then
  echo "登录成功响应中没有 kubeconfig"
  cat "${LOGIN_RESPONSE}"
  exit 1
fi

AUTH_HEADER="$(
  KUBECONFIG_JSON="${KUBECONFIG_JSON}" node <<'NODE'
console.log(encodeURIComponent(process.env.KUBECONFIG_JSON));
NODE
)"

curl -sS -f \
  -b "${COOKIE_FILE}" \
  -H "Origin: ${BASE_URL}" \
  -H "Referer: ${BASE_URL}/imagehub" \
  -H "Authorization: ${AUTH_HEADER}" \
  -H "X-CSRF-Token: ${CSRF_TOKEN}" \
  -F "file=@${ZIP_FILE};type=application/zip" \
  "${BASE_URL}/api/imagehub/uploadImageFile" \
  -o "${UPLOAD_RESPONSE}"

EXTRACTED_PATH="$(jq -r '.data.extracted_path // empty' "${UPLOAD_RESPONSE}")"
if [ -z "${EXTRACTED_PATH}" ] || [ "${EXTRACTED_PATH}" = "null" ]; then
  echo "上传响应中没有 extracted_path"
  cat "${UPLOAD_RESPONSE}"
  exit 1
fi

DOCKERFILE_CONTENT="$(jq -Rs . < "${WORK_DIR}/Dockerfile")"
BUILD_PAYLOAD="$(
  jq -n \
    --arg path "${EXTRACTED_PATH}" \
    --arg namespace "${NAMESPACE}" \
    --arg imageName "${IMAGE_NAME}" \
    --arg version "${IMAGE_TAG}" \
    --argjson dockerfile "${DOCKERFILE_CONTENT}" \
    '{path: $path, namespace: $namespace, imageName: $imageName, version: $version, dockerfile: $dockerfile}'
)"

curl -sS -f \
  -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "Origin: ${BASE_URL}" \
  -H "Referer: ${BASE_URL}/imagehub" \
  -H "Authorization: ${AUTH_HEADER}" \
  -H "X-CSRF-Token: ${CSRF_TOKEN}" \
  -d "${BUILD_PAYLOAD}" \
  "${BASE_URL}/api/imagehub/buildDockerImage" \
  -o "${BUILD_RESPONSE}"

echo "上传响应:"
cat "${UPLOAD_RESPONSE}"
echo
echo "构建响应:"
cat "${BUILD_RESPONSE}"
echo
echo "目标镜像: sealos.hub:5000/${NAMESPACE}/${IMAGE_NAME}:${IMAGE_TAG}"
