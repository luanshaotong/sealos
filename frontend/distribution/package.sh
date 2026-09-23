set -e
if [ -z "$VERSION" ]; then
    echo "VERSION is not set"
    exit 1
fi

# pip3 install pyinstaller 
# python3 -m pip install flask apscheduler PyYAML

# pyinstaller --onefile app.py

rm -rf dist
mkdir -p dist/deployapp/

cp install_templete.sh install.sh
cp launchpad.yaml originlaunchpad.yaml
cp docker-compose-template.yml docker-compose.yml
sed -i "s/LAUNCHPAD_IMAGE/luanshaotong\/sealos-applaunchpad:${VERSION}/g" originlaunchpad.yaml
sed -i "s/LAUNCHPAD_TAG/${VERSION}/g" install.sh
sed -i "s/LAUNCHPAD_TAG/${VERSION}/g" docker-compose.yml

arch="${PACKAGE_ARCH:-$(uname -m)}"

case "${arch}" in
    aarch64|arm64)
        COMPOSE_ARCH="aarch64"
        COMPOSE_FILE_PATTERN="ARM aarch64|aarch64"
        ;;
    x86_64|amd64)
        COMPOSE_ARCH="x86_64"
        COMPOSE_FILE_PATTERN="x86-64|x86_64"
        ;;
    *)
        echo "unsupported architecture: ${arch}"
        exit 1
        ;;
esac

if [ -f docker-compose-bin ] && ! file docker-compose-bin | grep -Eq "${COMPOSE_FILE_PATTERN}"; then
    echo "docker-compose-bin architecture mismatch for ${arch}, redownloading"
    rm -f docker-compose-bin
fi

if [ ! -f docker-compose-bin ]; then
    wget "https://github.com/docker/compose/releases/download/v2.34.0/docker-compose-linux-${COMPOSE_ARCH}" -O docker-compose-bin
    chmod +x docker-compose-bin
fi

ETCD_VERSION="v3.5.12"
if [ "${arch}" = "aarch64" ] || [ "${arch}" = "arm64" ]; then
    ETCD_ARCH="arm64"
elif [ "${arch}" = "x86_64" ] || [ "${arch}" = "amd64" ]; then
    ETCD_ARCH="amd64"
else
    echo "unsupported architecture: ${arch}"
    exit 1
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "${tmp_dir}"' EXIT

ETCD_URL="https://github.com/etcd-io/etcd/releases/download/${ETCD_VERSION}/etcd-${ETCD_VERSION}-linux-${ETCD_ARCH}.tar.gz"
ETCD_CACHE_FILE="${ETCD_CACHE_FILE:-etcd-${ETCD_VERSION}-linux-${ETCD_ARCH}.tar.gz}"
if [ -x /usr/local/bin/etcdctl ] && [ -x /usr/local/bin/etcdutl ]; then
    cp /usr/local/bin/etcdctl /usr/local/bin/etcdutl dist/
elif [ -f "${ETCD_CACHE_FILE}" ]; then
    cp "${ETCD_CACHE_FILE}" "${tmp_dir}/etcd.tar.gz"
    tar -xzf "${tmp_dir}/etcd.tar.gz" -C "${tmp_dir}"
    cp "${tmp_dir}/etcd-${ETCD_VERSION}-linux-${ETCD_ARCH}/etcdctl" "${tmp_dir}/etcd-${ETCD_VERSION}-linux-${ETCD_ARCH}/etcdutl" dist/
else
    wget "${ETCD_URL}" -O "${tmp_dir}/etcd.tar.gz"
    cp "${tmp_dir}/etcd.tar.gz" "${ETCD_CACHE_FILE}"
    tar -xzf "${tmp_dir}/etcd.tar.gz" -C "${tmp_dir}"
    cp "${tmp_dir}/etcd-${ETCD_VERSION}-linux-${ETCD_ARCH}/etcdctl" "${tmp_dir}/etcd-${ETCD_VERSION}-linux-${ETCD_ARCH}/etcdutl" dist/
fi
chmod +x dist/etcdctl dist/etcdutl
cp -r etcd-backup dist/
cp add_iptables.sh dist/sealos_add_iptables.sh
cp del_iptables.sh dist/sealos_del_iptables.sh
chmod +x dist/sealos_add_iptables.sh dist/sealos_del_iptables.sh
cp ../../scripts/import-grafana-dashboard-configmap.sh dist/
chmod +x dist/import-grafana-dashboard-configmap.sh
cp ../../scripts/configure-grafana-monitor-embedding.sh dist/
chmod +x dist/configure-grafana-monitor-embedding.sh
cp ../../scripts/fix-kube-scheduler-v1.27.15.sh dist/
chmod +x dist/fix-kube-scheduler-v1.27.15.sh
cp ../../scripts/cluster-fault-check.sh dist/
chmod +x dist/cluster-fault-check.sh
cp ../../scripts/increase-kubelet-max-pods.sh dist/
chmod +x dist/increase-kubelet-max-pods.sh
cp ../../scripts/preinstall-container-runtime-check.sh dist/
chmod +x dist/preinstall-container-runtime-check.sh
if [ -d testdata ]; then
    cp -r testdata dist/
    find dist/testdata -name "run-api-test.sh" -exec chmod +x {} \;
fi

KUBE_SCHEDULER_HOTFIX_VERSION="v1.27.15"
KUBE_SCHEDULER_HOTFIX_IMAGE="registry.k8s.io/kube-scheduler:${KUBE_SCHEDULER_HOTFIX_VERSION}"
if ! docker image inspect "${KUBE_SCHEDULER_HOTFIX_IMAGE}" >/dev/null 2>&1; then
    docker pull "${KUBE_SCHEDULER_HOTFIX_IMAGE}"
fi
docker save -o "dist/kube-scheduler-${KUBE_SCHEDULER_HOTFIX_VERSION}.tar" "${KUBE_SCHEDULER_HOTFIX_IMAGE}"

cp install.sh originlaunchpad.yaml docker-compose-bin dist/
cp app.py node.py stress_test.py scheduling.py record_events.py menu.py bandwidth_autoscaler.py custom_dns.py dns_server.py dns_service.proto docker-compose.yml dist/deployapp/
rm -f originlaunchpad.yaml install.sh docker-compose.yml
docker tag docker.io/library/sealos-applaunchpad:dev luanshaotong/sealos-applaunchpad:${VERSION}
docker save -o dist/launchpad.tar luanshaotong/sealos-applaunchpad:${VERSION}

docker build . -t luanshaotong/deployapp:${VERSION}
docker save -o dist/deployapp.tar luanshaotong/deployapp:${VERSION}
