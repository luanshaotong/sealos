#!/bin/bash
set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:-/tmp/sealos-iptables-hotfix}"
SSH_USER="${SSH_USER:-root}"
SSH_OPTS="${SSH_OPTS:--n -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=no}"
SCP_OPTS="${SCP_OPTS:--o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=no}"
ACTION="${ACTION:-add}"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ADD_SCRIPT="${SCRIPT_DIR}/add_iptables.sh"
DEL_SCRIPT="${SCRIPT_DIR}/del_iptables.sh"
if [ ! -f "$ADD_SCRIPT" ] && [ -f "${SCRIPT_DIR}/sealos_add_iptables.sh" ]; then
  ADD_SCRIPT="${SCRIPT_DIR}/sealos_add_iptables.sh"
fi
if [ ! -f "$DEL_SCRIPT" ] && [ -f "${SCRIPT_DIR}/sealos_del_iptables.sh" ]; then
  DEL_SCRIPT="${SCRIPT_DIR}/sealos_del_iptables.sh"
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "错误: 请使用 root 用户执行此脚本。" >&2
  exit 1
fi

for cmd in kubectl awk grep sort tr scp ssh; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "错误: 未找到命令 '$cmd'。" >&2
    exit 1
  fi
done

if [ ! -f "$ADD_SCRIPT" ] || [ ! -f "$DEL_SCRIPT" ]; then
  echo "错误: 未找到 add_iptables.sh 或 del_iptables.sh。" >&2
  exit 1
fi

case "$ACTION" in
  add|lock)
    ACTION="add"
    TARGET_SCRIPT="add_iptables.sh"
    FINAL_MESSAGE="所有节点 iptables 规则已应用。"
    ;;
  del|delete|unlock)
    ACTION="del"
    TARGET_SCRIPT="del_iptables.sh"
    FINAL_MESSAGE="所有节点 iptables 规则已撤销。"
    ;;
  *)
    echo "错误: ACTION 只支持 add/lock 或 del/delete/unlock。" >&2
    exit 1
    ;;
esac

NODE_IPS=$(kubectl get nodes -o wide --no-headers=true | awk '{print $6; if ($7 != "<none>") print $7}' | sort -u | tr '\n' ',' | sed 's/,$//')
POD_CIDRS=$(kubectl describe nodes | grep 'PodCIDR:' | awk '{print $2}' | sort -u | tr '\n' ',' | sed 's/,$//')
LOCAL_IPS=$(hostname -I 2>/dev/null || true)

if [ -z "$NODE_IPS" ]; then
  echo "错误: 未获取到节点 IP。" >&2
  exit 1
fi

echo "节点白名单 IP: $NODE_IPS"
echo "Pod CIDR 白名单: $POD_CIDRS"
echo "执行动作: $ACTION"
echo ""

while read -r name status roles age version internal_ip external_ip rest; do
  if [ -z "$name" ] || [ -z "$internal_ip" ]; then
    continue
  fi

  target_ip="$internal_ip"
  if [ "$target_ip" = "<none>" ] && [ "$external_ip" != "<none>" ]; then
    target_ip="$external_ip"
  fi

  if echo "$roles" | grep -Eq 'control-plane|master'; then
    node_role="master"
  else
    node_role="worker"
  fi

  echo "==> 处理节点 $name ($target_ip), role=$node_role, action=$ACTION"

  if echo " $LOCAL_IPS " | grep -q " $target_ip "; then
    mkdir -p "$REMOTE_DIR"
    cp "$ADD_SCRIPT" "${REMOTE_DIR}/add_iptables.sh"
    cp "$DEL_SCRIPT" "${REMOTE_DIR}/del_iptables.sh"
    chmod +x "${REMOTE_DIR}/add_iptables.sh" "${REMOTE_DIR}/del_iptables.sh"
    NODE_ROLE="$node_role" NODE_IPS="$NODE_IPS" POD_CIDRS="$POD_CIDRS" "${REMOTE_DIR}/${TARGET_SCRIPT}"
  else
    ssh $SSH_OPTS "${SSH_USER}@${target_ip}" "mkdir -p '$REMOTE_DIR'"
    scp $SCP_OPTS "$ADD_SCRIPT" "${SSH_USER}@${target_ip}:${REMOTE_DIR}/add_iptables.sh"
    scp $SCP_OPTS "$DEL_SCRIPT" "${SSH_USER}@${target_ip}:${REMOTE_DIR}/del_iptables.sh"
    ssh $SSH_OPTS "${SSH_USER}@${target_ip}" \
      "chmod +x '${REMOTE_DIR}/add_iptables.sh' '${REMOTE_DIR}/del_iptables.sh' && NODE_ROLE='$node_role' NODE_IPS='$NODE_IPS' POD_CIDRS='$POD_CIDRS' '${REMOTE_DIR}/${TARGET_SCRIPT}'"
  fi
  echo ""
done < <(kubectl get nodes -o wide --no-headers=true)

echo "$FINAL_MESSAGE"
