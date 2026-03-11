docker login -u admin -p passw0rd sealos.hub:5000
docker load -i launchpad.tar
docker tag luanshaotong/sealos-applaunchpad:LAUNCHPAD_TAG sealos.hub:5000/luanshaotong/sealos-applaunchpad:LAUNCHPAD_TAG
docker push sealos.hub:5000/luanshaotong/sealos-applaunchpad:LAUNCHPAD_TAG
docker load -i deployapp.tar
docker tag luanshaotong/deployapp:LAUNCHPAD_TAG sealos.hub:5000/luanshaotong/deployapp:LAUNCHPAD_TAG
docker push sealos.hub:5000/luanshaotong/deployapp:LAUNCHPAD_TAG

DOMAIN=`grep sealos.hub /etc/hosts | awk '{print $1}'`
cp originlaunchpad.yaml launchpad.yaml
sed -i "s/FLAG_SEALOS_DOMAIN/${DOMAIN}/g" launchpad.yaml
KUBECONFIG=`base64 /etc/kubernetes/admin.conf | paste -s -d ''`
sed -i "s/KUBECONFIGTEMPLATE/${KUBECONFIG}/g" launchpad.yaml
kubectl apply -f launchpad.yaml

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