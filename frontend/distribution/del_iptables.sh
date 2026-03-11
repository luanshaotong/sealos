#!/bin/bash

PROTECTED_PORTS="9100,5000,5001"
CHAIN_NAME="LOCAL_PORT_ACCESS"

# 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
  echo "错误: 此脚本必须以 root 用户或使用 sudo 运行。" >&2
  exit 1
fi

echo "--- 开始撤销防火墙规则 ---"

# 1. 从 INPUT 链中删除跳转规则 (如果存在)
if iptables -C INPUT -p tcp -m multiport --dports "$PROTECTED_PORTS" -j "$CHAIN_NAME" >/dev/null 2>&1; then
  echo "从 INPUT 链中删除跳转规则..."
  iptables -D INPUT -p tcp -m multiport --dports "$PROTECTED_PORTS" -j "$CHAIN_NAME"
else
  echo "INPUT 链中未找到相关跳转规则。"
fi


# 2. 清空自定义链 (如果存在)
if iptables -L "$CHAIN_NAME" -n >/dev/null 2>&1; then
  echo "清空自定义链 $CHAIN_NAME..."
  iptables -F "$CHAIN_NAME"

  # 3. 删除自定义链 (如果存在)
  echo "删除自定义链 $CHAIN_NAME..."
  iptables -X "$CHAIN_NAME"
else
  echo "自定义链 $CHAIN_NAME 不存在。"
fi

echo "--- 撤销完成 ---"
echo "请记得也要更新并保存你持久化的规则！"