#!/bin/bash
# 配置区
BACKUP_DIR="/var/lib/etcd-backups"
FILE_NAME="etcd-snap-$(date +%Y%m%d%H%M)"
DB_PATH="${BACKUP_DIR}/${FILE_NAME}.db"
TAR_PATH="${BACKUP_DIR}/${FILE_NAME}.tar.gz"
RETENTION_DAYS=7
DETAILED_KEEP_HOURS=24

mkdir -p "${BACKUP_DIR}"

# 1. 导出快照 (前提：etcd 必须是 Running 状态)
ETCDCTL_API=3 etcdctl \
  --endpoints="https://127.0.0.1:2379" \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save "${DB_PATH}"

# 2. 如果导出成功，则进行压缩
if [ $? -eq 0 ]; then
  tar -zcf "${TAR_PATH}" -C "${BACKUP_DIR}" "${FILE_NAME}.db"
  rm -f "${DB_PATH}"  # 删掉未压缩的原始大文件
  echo "Backup successful: ${TAR_PATH}"
else
    echo "Backup failed! Please check etcd status."
    exit 1
fi

# 3. 自动清理：保留 7 天；24 小时以上按天只保留 1 份
now_ts=$(date +%s)
declare -A kept_daily

for file in $(ls -1t "${BACKUP_DIR}"/etcd-snap-*.tar.gz 2>/dev/null); do
  base_name=$(basename "${file}")
  ts=$(echo "${base_name}" | sed -n 's/^etcd-snap-\([0-9]\{12\}\)\.tar\.gz$/\1/p')
  if [ -z "${ts}" ]; then
    continue
  fi

  file_ts=$(date -d "${ts:0:8} ${ts:8:2}:${ts:10:2}" +%s 2>/dev/null)
  if [ -z "${file_ts}" ]; then
    continue
  fi

  age_sec=$((now_ts - file_ts))
  if [ "${age_sec}" -gt $((RETENTION_DAYS * 24 * 3600)) ]; then
    rm -f "${file}"
    continue
  fi

  if [ "${age_sec}" -gt $((DETAILED_KEEP_HOURS * 3600)) ]; then
    day_key="${ts:0:8}"
    if [ -n "${kept_daily[${day_key}]}" ]; then
      rm -f "${file}"
    else
      kept_daily["${day_key}"]=1
    fi
  fi
done