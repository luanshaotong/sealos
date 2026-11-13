#!/bin/bash
set -euo pipefail

HOTFIX_IMAGE="${HOTFIX_IMAGE:-luanshaotong/deployapp:python312-bookworm-hotfix}"
APP_FILE="${APP_FILE:-/usr/bin/deployapp/app.py}"
IMAGE_TAR="${IMAGE_TAR:-deployapp-python.tar}"
CONTAINER_NAME="${CONTAINER_NAME:-}"
TARGET_PORT="${TARGET_PORT:-5002}"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "错误: 请使用 root 用户执行此脚本。" >&2
  exit 1
fi

for cmd in docker curl iptables awk grep sed; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "错误: 未找到命令 ${cmd}。" >&2
    exit 1
  fi
done

if [ ! -f "${SCRIPT_DIR}/${IMAGE_TAR}" ]; then
  echo "错误: 未找到镜像文件 ${SCRIPT_DIR}/${IMAGE_TAR}" >&2
  exit 1
fi

if [ ! -f "${APP_FILE}" ]; then
  echo "错误: 未找到 ${APP_FILE}" >&2
  exit 1
fi

find_container_by_host_port() {
  local port="${1:-5002}"
  local matches=()
  local id ports

  while IFS= read -r id; do
    [ -n "$id" ] || continue
    ports=$(docker port "$id" 2>/dev/null || true)
    if echo "$ports" | grep -Eq "0\\.0\\.0\\.0:${port}$|:::${port}$|:${port}$"; then
      matches+=("$id")
    fi
  done < <(docker ps -q)

  if [ "${#matches[@]}" -eq 1 ]; then
    docker inspect -f '{{.Name}}' "${matches[0]}" | sed 's#^/##'
    return 0
  fi

  if [ "${#matches[@]}" -gt 1 ]; then
    echo "错误: 发现多个发布宿主机 ${port} 端口的容器，请通过 CONTAINER_NAME 指定目标容器。" >&2
    docker ps --format 'table {{.Names}}\t{{.Ports}}' >&2
    return 2
  fi

  return 1
}

if [ -n "$CONTAINER_NAME" ]; then
  if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "错误: 未找到 Docker 容器 ${CONTAINER_NAME}。" >&2
    exit 1
  fi
else
  if ! CONTAINER_NAME=$(find_container_by_host_port "$TARGET_PORT"); then
    echo "错误: 未找到唯一的宿主机 ${TARGET_PORT} 端口容器，请确认 deployapp 正在运行或通过 CONTAINER_NAME 指定。" >&2
    exit 1
  fi
  echo "信息: 将使用发布宿主机 ${TARGET_PORT} 端口的容器 ${CONTAINER_NAME}。"
fi

CURRENT_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER_NAME")
if [ -z "${CURRENT_IMAGE}" ]; then
  echo "错误: 无法读取当前容器镜像名。" >&2
  exit 1
fi

add_if_nonempty() {
  local flag="$1"
  local value="$2"
  if [ -n "$value" ] && [ "$value" != "<no value>" ]; then
    docker_args+=("$flag" "$value")
  fi
}

add_bool_flag() {
  local flag="$1"
  local value="$2"
  if [ "$value" = "true" ]; then
    docker_args+=("$flag")
  fi
}

build_docker_run_args_from_container() {
  docker_args=(-d --name "$CONTAINER_NAME")

  local restart_name restart_max network_mode workdir user hostname domainname mac_address
  restart_name=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER_NAME")
  restart_max=$(docker inspect -f '{{.HostConfig.RestartPolicy.MaximumRetryCount}}' "$CONTAINER_NAME")
  if [ -n "$restart_name" ] && [ "$restart_name" != "no" ]; then
    if [ "$restart_name" = "on-failure" ] && [ -n "$restart_max" ] && [ "$restart_max" != "0" ]; then
      docker_args+=(--restart "${restart_name}:${restart_max}")
    else
      docker_args+=(--restart "$restart_name")
    fi
  fi

  network_mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER_NAME")
  add_if_nonempty --network "$network_mode"

  workdir=$(docker inspect -f '{{.Config.WorkingDir}}' "$CONTAINER_NAME")
  user=$(docker inspect -f '{{.Config.User}}' "$CONTAINER_NAME")
  hostname=$(docker inspect -f '{{.Config.Hostname}}' "$CONTAINER_NAME")
  domainname=$(docker inspect -f '{{.Config.Domainname}}' "$CONTAINER_NAME")
  mac_address=$(docker inspect -f '{{.Config.MacAddress}}' "$CONTAINER_NAME")
  add_if_nonempty -w "$workdir"
  add_if_nonempty -u "$user"
  add_if_nonempty -h "$hostname"
  add_if_nonempty --domainname "$domainname"
  add_if_nonempty --mac-address "$mac_address"

  add_bool_flag -i "$(docker inspect -f '{{.Config.OpenStdin}}' "$CONTAINER_NAME")"
  add_bool_flag -t "$(docker inspect -f '{{.Config.Tty}}' "$CONTAINER_NAME")"
  add_bool_flag --privileged "$(docker inspect -f '{{.HostConfig.Privileged}}' "$CONTAINER_NAME")"
  add_bool_flag --init "$(docker inspect -f '{{.HostConfig.Init}}' "$CONTAINER_NAME")"

  local mode
  mode=$(docker inspect -f '{{.HostConfig.PidMode}}' "$CONTAINER_NAME")
  add_if_nonempty --pid "$mode"
  mode=$(docker inspect -f '{{.HostConfig.IpcMode}}' "$CONTAINER_NAME")
  add_if_nonempty --ipc "$mode"
  mode=$(docker inspect -f '{{.HostConfig.CgroupnsMode}}' "$CONTAINER_NAME")
  add_if_nonempty --cgroupns "$mode"

  while IFS= read -r env; do
    [ -n "$env" ] && docker_args+=(-e "$env")
  done < <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER_NAME")

  while IFS= read -r bind; do
    [ -n "$bind" ] && docker_args+=(-v "$bind")
  done < <(docker inspect -f '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$CONTAINER_NAME")

  while IFS= read -r volume_from; do
    [ -n "$volume_from" ] && docker_args+=(--volumes-from "$volume_from")
  done < <(docker inspect -f '{{range .HostConfig.VolumesFrom}}{{println .}}{{end}}' "$CONTAINER_NAME")

  while IFS= read -r extra_host; do
    [ -n "$extra_host" ] && docker_args+=(--add-host "$extra_host")
  done < <(docker inspect -f '{{range .HostConfig.ExtraHosts}}{{println .}}{{end}}' "$CONTAINER_NAME")

  while IFS= read -r dns; do
    [ -n "$dns" ] && docker_args+=(--dns "$dns")
  done < <(docker inspect -f '{{range .HostConfig.Dns}}{{println .}}{{end}}' "$CONTAINER_NAME")

  while IFS= read -r dns_search; do
    [ -n "$dns_search" ] && docker_args+=(--dns-search "$dns_search")
  done < <(docker inspect -f '{{range .HostConfig.DnsSearch}}{{println .}}{{end}}' "$CONTAINER_NAME")

  while IFS= read -r cap_add; do
    [ -n "$cap_add" ] && docker_args+=(--cap-add "$cap_add")
  done < <(docker inspect -f '{{range .HostConfig.CapAdd}}{{println .}}{{end}}' "$CONTAINER_NAME")

  while IFS= read -r cap_drop; do
    [ -n "$cap_drop" ] && docker_args+=(--cap-drop "$cap_drop")
  done < <(docker inspect -f '{{range .HostConfig.CapDrop}}{{println .}}{{end}}' "$CONTAINER_NAME")

  while IFS= read -r device; do
    [ -n "$device" ] && docker_args+=(--device "$device")
  done < <(docker inspect -f '{{range .HostConfig.Devices}}{{println .PathOnHost ":" .PathInContainer ":" .CgroupPermissions}}{{end}}' "$CONTAINER_NAME")

  while IFS= read -r label; do
    [ -n "$label" ] && docker_args+=(--label "$label")
  done < <(docker inspect -f '{{range $k, $v := .Config.Labels}}{{println $k "=" $v}}{{end}}' "$CONTAINER_NAME" | sed 's/ = /=/')

  while IFS='|' read -r host_ip host_port container_port; do
    [ -n "$host_port" ] || continue
    if [ -n "$host_ip" ] && [ "$host_ip" != "-" ] && [ "$host_ip" != "0.0.0.0" ] && [ "$host_ip" != "::" ]; then
      docker_args+=(-p "${host_ip}:${host_port}:${container_port}")
    else
      docker_args+=(-p "${host_port}:${container_port}")
    fi
  done < <(docker inspect -f '{{range $p, $bindings := .HostConfig.PortBindings}}{{range $b := $bindings}}{{if $b.HostIp}}{{printf "%s|%s|%s\n" $b.HostIp $b.HostPort $p}}{{else}}{{printf "-|%s|%s\n" $b.HostPort $p}}{{end}}{{end}}{{end}}' "$CONTAINER_NAME")

  mapfile -t entrypoint_args < <(docker inspect -f '{{range .Config.Entrypoint}}{{println .}}{{end}}' "$CONTAINER_NAME" | sed '/^$/d')
  if [ "${#entrypoint_args[@]}" -gt 0 ]; then
    docker_args+=(--entrypoint "${entrypoint_args[0]}")
  fi

  mapfile -t cmd_args < <(docker inspect -f '{{range .Config.Cmd}}{{println .}}{{end}}' "$CONTAINER_NAME" | sed '/^$/d')
}

build_docker_run_args_from_container

echo "加载 Python 3.12 deployapp 镜像..."
docker load -i "${SCRIPT_DIR}/${IMAGE_TAR}"
docker tag "${HOTFIX_IMAGE}" "${CURRENT_IMAGE}"
echo "镜像已替换: ${CURRENT_IMAGE}"

echo "修复 ${APP_FILE} 的 Flask debug/reloader 配置..."
cp -a "${APP_FILE}" "${APP_FILE}.bak.$(date +%Y%m%d%H%M%S)"
sed -Ei "/app\\.run\\(.*port=5002/ c\\    app.run(debug=False, use_reloader=False, host='0.0.0.0', port=5002)" "${APP_FILE}"
if ! grep -q "app.run(debug=False, use_reloader=False, host='0.0.0.0', port=5002)" "${APP_FILE}"; then
  echo "错误: app.py 未成功替换 app.run 配置。" >&2
  exit 1
fi

echo "替换并应用 iptables 脚本..."
install -m 0755 "${SCRIPT_DIR}/sealos_add_iptables.sh" /usr/local/bin/sealos_add_iptables.sh
install -m 0755 "${SCRIPT_DIR}/sealos_del_iptables.sh" /usr/local/bin/sealos_del_iptables.sh
install -m 0755 "${SCRIPT_DIR}/sealos_apply_iptables_all_nodes.sh" /usr/local/bin/sealos_apply_iptables_all_nodes.sh
DOCKER_CONTAINER_NAME="${CONTAINER_NAME}" /usr/local/bin/sealos_add_iptables.sh

echo "使用 docker run 按原容器配置重建 ${CONTAINER_NAME}..."
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run "${docker_args[@]}" "${CURRENT_IMAGE}" "${cmd_args[@]}"

echo "等待 deployapp HTTP 接口..."
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:5002/api/ping >/dev/null 2>&1; then
    echo "deployapp /api/ping 测试成功。"
    break
  fi
  sleep 2
done

curl -fsS --max-time 5 http://127.0.0.1:5002/api/ping
echo

echo "当前 deployapp 镜像:"
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep "^${CONTAINER_NAME} " || true

echo "当前 iptables 跳转规则:"
iptables -S INPUT | grep 'MASTER_WHITELIST_ACCESS' || true

echo "hotfix 完成。"
