#!/bin/bash

# ==============================================================================
# 脚本名称: setup_master_firewall.sh
# 描述:     使用 iptables 保护指定端口。白名单动态生成，来源包括：
#           1. Kubernetes 集群所有节点的 IP (Internal/External)
#           2. Kubernetes 集群所有节点的 Pod CIDR
#           3. 一个指定的本地 Docker 容器 IP
#           4. 从 'EXTRA_INFO' 环境变量读取的额外 IP/CIDR 列表
#           此版本不依赖 jq。
# 作者:     Gemini
# 日期:     2025-10-19
# 版本:     6.0
# ==============================================================================

# --- 配置 ---
# 需要保护的 TCP 端口列表，用逗号分隔
PROTECTED_PORTS="9100,5000,5001"

# 自定义 iptables 链的名称
CHAIN_NAME="MASTER_WHITELIST_ACCESS"

# 需要加入白名单的 Docker 容器名称
DOCKER_CONTAINER_NAME="deployapp"


# --- 脚本主体 ---

# 1. 检查权限和依赖
if [ "$(id -u)" -ne 0 ]; then
  echo "错误: 此脚本必须以 root 用户或使用 sudo 运行。" >&2
  exit 1
fi

# 检查必要的命令
for cmd in kubectl awk sort grep printf tr; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "错误: 核心命令 '$cmd' 未找到。请检查你的系统环境。" >&2
        exit 1
    fi
done

# 2. 尝试连接到 Kubernetes 集群
echo "正在检查 Kubernetes API Server 连接..."
if ! kubectl get nodes -o name >/dev/null; then
    echo "错误: kubectl 无法连接到 Kubernetes 集群或获取节点信息。" >&2
    exit 1
fi
echo "Kubernetes 连接成功。"
echo ""


# 3. 动态获取所有白名单来源
echo "正在从多个来源获取白名单条目..."

# 3a. 从 Kubernetes 获取所有节点的 Internal-IP 和 External-IP
NODE_IPS=$(kubectl get nodes -o wide --no-headers=true | awk '{print $6; if ($7 != "<none>") print $7}')
echo "已获取 Kubernetes 节点 IP。"

# 3b. 从 Kubernetes 获取所有节点的 PodCIDR
POD_CIDRS=$(kubectl describe nodes | grep 'PodCIDR:' | awk '{print $2}')
echo "已获取 Kubernetes Pod CIDR。"

# 3c. 获取指定 Docker 容器的 IP 地址
DOCKER_IP=""
if command -v docker &> /dev/null; then
    DOCKER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$DOCKER_CONTAINER_NAME" 2>/dev/null)
    if [ -n "$DOCKER_IP" ]; then
        echo "已获取 Docker 容器 '$DOCKER_CONTAINER_NAME' 的 IP: $DOCKER_IP"
    else
        echo "信息: Docker 容器 '$DOCKER_CONTAINER_NAME' 未找到或未运行，将跳过。"
    fi
else
    echo "信息: 未找到 'docker' 命令，跳过检查 Docker 容器。"
fi

# 3d. 从 EXTRA_INFO 环境变量获取额外的白名单条目
EXTRA_IPS=""
if [ -n "$EXTRA_INFO" ]; then
    # 使用 tr 将逗号替换为换行符，以便处理
    EXTRA_IPS=$(echo "$EXTRA_INFO" | tr ',' '\n')
    echo "已从 EXTRA_INFO 环境变量获取额外条目。"
else
    echo "信息: EXTRA_INFO 环境变量未设置或为空，跳过。"
fi

# 3e. 合并所有来源、去重并移除空行，生成最终的白名单列表
WHITELIST_ENTRIES=$(printf "%s\n%s\n%s\n%s" "$NODE_IPS" "$POD_CIDRS" "$DOCKER_IP" "$EXTRA_IPS" | grep -v -e '^$' | sort -u)

if [ -z "$WHITELIST_ENTRIES" ]; then
    echo "错误: 未能从任何来源获取到有效的 IP 地址或 CIDR。请检查集群和容器状态。" >&2
    exit 1
fi

echo ""
echo "--- 开始配置防火墙 ---"
echo "受保护的端口: $PROTECTED_PORTS"
echo "使用的自定义链: $CHAIN_NAME"
echo "最终生成的白名单条目:"
echo "$WHITELIST_ENTRIES"
echo ""

# 4. 创建或清空自定义 iptables 链
if ! iptables -L "$CHAIN_NAME" -n >/dev/null 2>&1; then
  echo "创建新的 iptables 链: $CHAIN_NAME"
  iptables -N "$CHAIN_NAME"
else
  echo "链 $CHAIN_NAME 已存在，将清空并重新填充规则。"
  iptables -F "$CHAIN_NAME"
fi

# 5. 在自定义链中添加白名单规则
echo "正在填充白名单规则..."
# 规则 A: 允许来自回环地址 (localhost) 的流量
iptables -A "$CHAIN_NAME" -s "127.0.0.1" -j ACCEPT
echo "规则添加: 允许源地址为 127.0.0.1 (localhost) 的流量"

# 规则 B: 遍历所有白名单条目并添加规则
while IFS= read -r entry; do
    if [ -n "$entry" ]; then
        iptables -A "$CHAIN_NAME" -s "$entry" -j ACCEPT
        echo "规则添加: 允许源为 '$entry' 的流量"
    fi
done <<< "$WHITELIST_ENTRIES"

# 规则 C (最终规则): 拒绝所有其他流量
iptables -A "$CHAIN_NAME" -j DROP
echo "规则添加: 拒绝所有其他源地址的流量 (默认 DROP)"


# 6. 确保 INPUT 链中有跳转到我们自定义链的规则
if ! iptables -C INPUT -p tcp -m multiport --dports "$PROTECTED_PORTS" -j "$CHAIN_NAME" >/dev/null 2>&1; then
  echo "在 INPUT 链中添加跳转规则..."
  iptables -I INPUT 1 -p tcp -m multiport --dports "$PROTECTED_PORTS" -j "$CHAIN_NAME"
else
  echo "INPUT 链中已存在跳转规则，无需重复添加。"
fi


echo ""
echo "--- 防火墙配置完成！---"
echo "当前规则 (仅显示相关部分):"
echo "--- $CHAIN_NAME Chain (白名单) ---"
iptables -L "$CHAIN_NAME" -v -n --line-numbers

echo ""
echo "警告: iptables 规则在系统重启后会丢失。"
echo "请根据你的操作系统，使用以下命令之一来持久化规则。"
echo "  - Debian/Ubuntu: sudo netfilter-persistent save"
echo "  - RHEL/CentOS 7+: sudo service iptables save"