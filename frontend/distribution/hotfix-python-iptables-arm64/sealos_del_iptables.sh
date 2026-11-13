#!/bin/bash

PROTECTED_PORTS="9100,5000,5001,2379,2380,2381,5473,6443,8443,10249,10250,10254,10257,10259,30081,30848,30888,30971"
CHAIN_NAME="MASTER_WHITELIST_ACCESS"
LEGACY_CHAIN_NAMES=("LOCAL_PORT_ACCESS")
PORT_SETS=(
  "$PROTECTED_PORTS"
  "9100,5000,5001,2379,2380,2381,5473,6443,8443,10249,10250,10254,10257,10259,30081"
  "30848,30888,30971"
  "9100,8443,10249,10250,10254,30081,30848,30888,30971"
  "9100,5000,5001,2379,2380,2381,5473,6443,8443,10249,10250,10254,10257,10259,30971"
  "9100,10249,10250,10254,8443,30971"
  "9100,5000,5001,2379,2380,30971"
  "9100,5000,5001,2379,2380"
  "9100,5000,5001"
)

# 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
  echo "错误: 此脚本必须以 root 用户或使用 sudo 运行。" >&2
  exit 1
fi

echo "--- 开始撤销防火墙规则 ---"

delete_chain_rules() {
  local chain_name="$1"

  # 1. 从 INPUT 链中删除跳转规则 (如果存在)
  local deleted=0
  for ports in "${PORT_SETS[@]}"; do
    if iptables -C INPUT -p tcp -m multiport --dports "$ports" -j "$chain_name" >/dev/null 2>&1; then
      echo "从 INPUT 链中删除跳转规则: $chain_name ($ports) ..."
      while iptables -C INPUT -p tcp -m multiport --dports "$ports" -j "$chain_name" >/dev/null 2>&1; do
        iptables -D INPUT -p tcp -m multiport --dports "$ports" -j "$chain_name"
      done
      deleted=1
    fi
  done
  if [ "$deleted" -eq 0 ]; then
    echo "INPUT 链中未找到跳转到 $chain_name 的规则。"
  fi

  # 2. 清空并删除自定义链 (如果存在)
  if iptables -L "$chain_name" -n >/dev/null 2>&1; then
    echo "清空自定义链 $chain_name ..."
    iptables -F "$chain_name"

    echo "删除自定义链 $chain_name ..."
    iptables -X "$chain_name"
  else
    echo "自定义链 $chain_name 不存在。"
  fi
}

delete_chain_rules "$CHAIN_NAME"

for legacy_chain_name in "${LEGACY_CHAIN_NAMES[@]}"; do
  if [ "$legacy_chain_name" != "$CHAIN_NAME" ]; then
    delete_chain_rules "$legacy_chain_name"
  fi
done

echo "--- 撤销完成 ---"
echo "请记得也要更新并保存你持久化的规则！"
