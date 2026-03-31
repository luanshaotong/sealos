# frontend/distribution 功能说明

本文档说明三个功能模块：
- 导出接口
- etcd 备份与恢复
- iptables 白名单脚本

## 1. 导出接口

服务实现位于 app.py，主要用于导出应用编排文件、镜像以及元数据。

### 1.1 /api/exportApp

用途：全量导出应用。

请求方式：POST

参数：
- query 参数：namespace、appname
- body 参数：yaml、images

特点：
- 接收外部传入的 yaml 和镜像列表
- 导出结果包含 app.yaml、metadata.json、镜像 tar 包
- metadata.json 中会记录 images、nodeports、preInspection 等信息

适用场景：
- 从 launchpad 或其他上游系统导出完整可迁移应用包

### 1.2 /api/exportAppLight

用途：轻量导出已部署应用。

请求方式：GET

参数：
- namespace
- appname

特点：
- 从集群中按标签采集当前应用资源
- 仅生成 app.yaml 和 metadata.json
- 不导出镜像
- 返回 JSON，包含导出目录和下载地址

适用场景：
- 只需要应用编排和元数据，不关心镜像离线包

示例：

```python
import requests

namespace = 'ns-admin'
appname = 'test'

url = f'http://localhost:5002/api/exportAppLight?namespace={namespace}&&appname={appname}'
response = requests.get(url)
print(response.status_code, response.text)
```

### 1.3 /api/exportAppLightDownload

用途：轻量导出并直接下载压缩包。

请求方式：GET

参数：
- namespace
- appname

特点：
- 内部会先执行轻量导出
- 直接返回 zip 文件流
- 压缩包内容：app.yaml
- 压缩包内容：metadata.json

适用场景：
- 前端或脚本需要一次请求就拿到可下载文件

示例：

```python
import requests

namespace = 'ns-admin'
appname = 'test'

url = f'http://localhost:5002/api/exportAppLightDownload?namespace={namespace}&&appname={appname}'
response = requests.get(url)

if response.status_code == 200:
    with open(appname + '-light.zip', 'wb') as f:
        f.write(response.content)
```

### 1.4 /api/downloadApp

用途：根据已生成的导出目录下载 zip 包。

请求方式：GET

参数：
- namespace
- appname
- uuid

说明：
- 通常与 /api/exportApp 或 /api/exportAppLight 配合使用
- export 接口先返回下载地址，再调用本接口获取压缩包

### 1.5 导出包内容说明

典型文件：
- app.yaml：应用编排 YAML
- metadata.json：元数据
- 若为全量导出，还会包含镜像 tar 包

metadata.json 主要字段：
- name：应用名
- namespace：命名空间
- images：镜像列表
- preInspection：探活或预检查信息
- nodeports：NodePort 端口映射信息

## 2. etcd 备份与恢复

### 2.1 安装位置

安装脚本执行后：
- etcdctl、etcdutl 会被复制到 /usr/local/bin
- etcd 备份脚本会被复制到 /etc/etcd-backup

相关文件：
- /etc/etcd-backup/etcd-backup.sh
- /etc/etcd-backup/etcd-restore.sh

### 2.2 自动备份任务

安装时会创建 cron：

```cron
5 */2 * * * root /etc/etcd-backup/etcd-backup.sh >> /var/log/etcd-backup.log 2>&1
```

含义：
- 每 2 小时的第 5 分钟执行一次备份
- 日志追加到 /var/log/etcd-backup.log

### 2.3 备份行为

备份脚本会：
- 使用 etcdctl snapshot save 导出 etcd 快照
- 连接地址固定为 https://127.0.0.1:2379
- 使用 /etc/kubernetes/pki/etcd 下的证书和密钥
- 导出后生成 tar.gz 压缩包

默认目录：
- 备份目录：/var/lib/etcd-backups

备份文件命名：
- etcd-snap-YYYYMMDDHHMM.tar.gz

### 2.4 保留策略

备份脚本内置清理逻辑：
- 24 小时内保留全部
- 7 天内按天保留一个
- 7 天前按周保留一个

### 2.5 手动备份

```bash
sudo /etc/etcd-backup/etcd-backup.sh
```

### 2.6 手动恢复

```bash
sudo /etc/etcd-backup/etcd-restore.sh
```

恢复脚本会：
- 从 /var/lib/etcd-backups 中选择最新备份
- 修正主机名为脚本中的 NODE_NAME
- 临时移走 /etc/kubernetes/manifests/etcd.yaml
- 备份并移除旧的 /var/lib/etcd 数据目录
- 解压备份并使用 etcdutl snapshot restore 恢复
- 恢复 etcd static pod manifest

恢复前建议确认：
- NODE_NAME 与当前 etcd 节点配置一致
- 当前主机是目标控制节点
- 已充分理解恢复会覆盖现有 etcd 数据

## 3. iptables 白名单脚本

### 3.1 安装位置

安装脚本会把以下两个命令安装到 /usr/local/bin：
- sealos_add_iptables.sh
- sealos_del_iptables.sh

### 3.2 保护端口

当前脚本保护以下 TCP 端口：
- 9100
- 5000
- 5001

自定义链名称：
- MASTER_WHITELIST_ACCESS

### 3.3 白名单来源

添加脚本会动态收集以下来源：
- Kubernetes 节点 Internal-IP 和 External-IP
- Kubernetes 节点 PodCIDR
- Docker 容器 deployapp 的 IP
- 环境变量 EXTRA_INFO 中的额外 IP 或 CIDR

如果一个来源为空，会自动跳过；最终结果会去重。

### 3.4 添加规则

```bash
sudo sealos_add_iptables.sh
```

如需补充白名单：

```bash
sudo EXTRA_INFO="192.168.0.134,10.0.0.0/24" sealos_add_iptables.sh
```

执行后会：
- 创建或清空 MASTER_WHITELIST_ACCESS 链
- 先放行 127.0.0.1
- 再依次放行白名单来源
- 最后添加 DROP 规则
- 在 INPUT 链首部插入跳转规则

### 3.5 删除规则

```bash
sudo sealos_del_iptables.sh
```

删除脚本会：
- 从 INPUT 链中删除跳转到 MASTER_WHITELIST_ACCESS 的规则
- 清空并删除自定义链
- 兼容清理历史遗留链 LOCAL_PORT_ACCESS

### 3.6 持久化说明

iptables 规则默认只保存在当前系统运行态，系统重启后可能丢失。

持久化命令示例：
- Debian/Ubuntu：

```bash
sudo netfilter-persistent save
```

- RHEL/CentOS 7+：

```bash
sudo service iptables save
```

## 4. 关联文件

导出接口：
- app.py

etcd 备份：
- etcd-backup/etcd-backup.sh
- etcd-backup/etcd-restore.sh

iptables：
- add_iptables.sh
- del_iptables.sh

安装与打包：
- install_templete.sh
- package.sh