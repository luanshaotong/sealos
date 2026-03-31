docker login -u admin -p passw0rd sealos.hub:5000
docker load -i launchpad.tar
docker tag luanshaotong/sealos-applaunchpad:LAUNCHPAD_TAG sealos.hub:5000/luanshaotong/sealos-applaunchpad:LAUNCHPAD_TAG
docker push sealos.hub:5000/luanshaotong/sealos-applaunchpad:LAUNCHPAD_TAG
docker load -i deployapp.tar
docker tag luanshaotong/deployapp:LAUNCHPAD_TAG sealos.hub:5000/luanshaotong/deployapp:LAUNCHPAD_TAG
docker push sealos.hub:5000/luanshaotong/deployapp:LAUNCHPAD_TAG

DOMAIN=$(awk '$2=="sealos.hub" {print $1; exit}' /etc/hosts)
DNS_FORWARD_IP=${DOMAIN}
DNS_FORWARD_TARGET="${DNS_FORWARD_IP}:5053"
cp originlaunchpad.yaml launchpad.yaml
sed -i "s/FLAG_SEALOS_DOMAIN/${DOMAIN}/g" launchpad.yaml
KUBECONFIG=`base64 /etc/kubernetes/admin.conf | paste -s -d ''`
sed -i "s/KUBECONFIGTEMPLATE/${KUBECONFIG}/g" launchpad.yaml
kubectl apply -f launchpad.yaml

configure_coredns_forward() {
    tmp_corefile=$(mktemp)

    if ! kubectl -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}' > "${tmp_corefile}"; then
        rm -f "${tmp_corefile}"
        echo "skip updating coredns configmap: unable to fetch current Corefile"
        return 1
    fi

    if grep -q "forward \. ${DNS_FORWARD_TARGET}" "${tmp_corefile}"; then
        echo "coredns already forwards to ${DNS_FORWARD_TARGET}"
        rm -f "${tmp_corefile}"
        return 0
    fi

    if grep -q "forward \. /etc/resolv.conf {" "${tmp_corefile}"; then
        sed -i "/forward \\. \/etc\/resolv\.conf {/,/}/{
/forward \\. \/etc\/resolv\.conf {/c\\    forward . ${DNS_FORWARD_TARGET} {
/max_concurrent/c\\       max_concurrent 1000
/^    }$/c\\    }
}" "${tmp_corefile}"
    elif grep -q "forward \. /etc/resolv.conf" "${tmp_corefile}"; then
        sed -i "s|forward \\. /etc/resolv.conf|forward . ${DNS_FORWARD_TARGET}|" "${tmp_corefile}"
    else
        echo "skip updating coredns configmap: unsupported Corefile forward format"
        rm -f "${tmp_corefile}"
        return 1
    fi

    kubectl -n kube-system create configmap coredns --from-file=Corefile="${tmp_corefile}" --dry-run=client -o yaml | kubectl apply -f -
    rm -f "${tmp_corefile}"

    kubectl -n kube-system rollout restart deployment coredns
    kubectl -n kube-system rollout status deployment coredns --timeout=120s
}

dc=`which docker-compose`
if [ -z $dc ]; then
    cp docker-compose-bin /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
fi

cp etcdctl etcdutl /usr/local/bin/
chmod +x /usr/local/bin/etcdctl /usr/local/bin/etcdutl

cp sealos_add_iptables.sh sealos_del_iptables.sh /usr/local/bin/
chmod +x /usr/local/bin/sealos_add_iptables.sh /usr/local/bin/sealos_del_iptables.sh

mkdir -p /etc/etcd-backup
rm -rf /etc/etcd-backup/*
cp -r etcd-backup/* /etc/etcd-backup/
chmod +x /etc/etcd-backup/*.sh

cat >/etc/cron.d/etcd-backup <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
5 */2 * * * root /etc/etcd-backup/etcd-backup.sh >> /var/log/etcd-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/etcd-backup

if [ -f /etc/systemd/system/deployapp.service ]; then
    systemctl stop deployapp
    systemctl disable deployapp
    rm -rf /etc/systemd/system/deployapp.service
fi

mkdir -p /usr/bin/deployapp
rm -rf /usr/bin/deployapp/*.py /usr/bin/deployapp/__pycache__
cp -r deployapp/* /usr/bin/deployapp/
cd /usr/bin/deployapp
sed -i "s/FLAG_SEALOS_DOMAIN/${DOMAIN}/g" docker-compose.yml
docker-compose up -d
configure_coredns_forward

# cp origindeployapp.service deployapp.service
# sed -i "s/FLAG_SEALOS_DOMAIN/${DOMAIN}/g" deployapp.service
# if [ ! -f /etc/systemd/system/deployapp.service ]; then
#     cp app /usr/local/bin/
#     chmod +x /usr/local/bin/app
#     cp deployapp.service /etc/systemd/system/
#     systemctl enable deployapp
#     systemctl start deployapp
# else
#     systemctl stop deployapp
#     cp app /usr/local/bin/
#     chmod +x /usr/local/bin/app
#     cp deployapp.service /etc/systemd/system/
#     systemctl enable deployapp
#     systemctl start deployapp
# fi

echo "install success"