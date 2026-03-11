#!/bin/bash
# 配置区
BACKUP_DIR="/var/lib/etcd-backups"
ETCD_DATA_DIR="/var/lib/etcd"
MANIFEST_DIR="/etc/kubernetes/manifests"
NODE_NAME="sealos.hub"  # 必须匹配你图片中的 etcd 节点名

# 1. 寻找最新的压缩备份文件
LATEST_BACKUP=$(ls -t ${BACKUP_DIR}/*.tar.gz 2>/dev/null | head -n1)

if [ -z "$LATEST_BACKUP" ]; then
    echo "Error: No backup files found in ${BACKUP_DIR}"
    exit 1
fi

echo "Found latest backup: ${LATEST_BACKUP}"

# 2. 修正主机名 (解决断电导致的 localhost 问题)
echo "Setting hostname to ${NODE_NAME}..."
hostnamectl set-hostname ${NODE_NAME}

# 3. 停止 etcd 服务 (通过移除 Static Pod 定义文件)
if [ -f "${MANIFEST_DIR}/etcd.yaml" ]; then
    echo "Stopping etcd container..."
    mv ${MANIFEST_DIR}/etcd.yaml /tmp/etcd.yaml.bak
    sleep 5 # 等待容器彻底停止
fi

# 4. 清理旧的损坏数据 (必须清空，否则恢复会报错)
echo "Backing up and removing corrupted data..."
mv ${ETCD_DATA_DIR} ${ETCD_DATA_DIR}.damaged.$(date +%s)

# 5. 解压并恢复数据
TMP_RESTORE="/tmp/etcd-restore-$(date +%s)"
mkdir -p ${TMP_RESTORE}
tar -zxvf ${LATEST_BACKUP} -C ${TMP_RESTORE}

DB_FILE=$(ls ${TMP_RESTORE}/*.db)

echo "Restoring from ${DB_FILE}..."
# 针对单节点的精准恢复参数
etcdutl snapshot restore ${DB_FILE} \
  --name ${NODE_NAME} \
  --initial-cluster "${NODE_NAME}=https://127.0.0.1:2380" \
  --initial-advertise-peer-urls "https://127.0.0.1:2380" \
  --data-dir ${ETCD_DATA_DIR}

# 6. 恢复服务并清理
if [ $? -eq 0 ]; then
    echo "Restore successful. Restarting etcd..."
    chown -R root:root ${ETCD_DATA_DIR} # 确保权限正确
    mv /tmp/etcd.yaml.bak ${MANIFEST_DIR}/etcd.yaml
    rm -rf ${TMP_RESTORE}
    echo "Done! Please check logs using: docker logs -f \$(docker ps -qf \"label=io.kubernetes.container.name=etcd\")"
else
    echo "Restore failed!"
    exit 1
fi