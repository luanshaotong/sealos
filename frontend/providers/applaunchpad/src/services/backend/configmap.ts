const GLOBAL_CONFIG_NAMESPACE = 'default';
const SYSTEM_NAMESPACES = new Set([
  'default',
  'kube-system',
  'sealos',
  'cert-manager',
  'ingress-nginx',
  'calico-apiserver',
  'calico-system',
  'kube-node-lease',
  'kube-public',
  'loki',
  'loki-stack',
  'openebs',
  'ops-monit',
  'tigera-operator',
  'vm'
]);

export const getGlobalConfigMapName = () => process.env.GLOBAL_CONFIGMAP_NAME || 'global-configmap';

const isNotFound = (err: any) =>
  err?.code === 404 || err?.statusCode === 404 || err?.response?.statusCode === 404;

const buildGlobalConfigMap = (name: string, namespace: string, data: Record<string, string> = {}) => ({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: {
    name,
    namespace
  },
  data
});

export const ensureSourceGlobalConfigMap = async (k8sCore: any) => {
  const name = getGlobalConfigMapName();

  try {
    return await k8sCore.readNamespacedConfigMap(name, GLOBAL_CONFIG_NAMESPACE);
  } catch (err: any) {
    if (!isNotFound(err)) {
      throw err;
    }
    await k8sCore.createNamespacedConfigMap(
      GLOBAL_CONFIG_NAMESPACE,
      buildGlobalConfigMap(name, GLOBAL_CONFIG_NAMESPACE)
    );
    return await k8sCore.readNamespacedConfigMap(name, GLOBAL_CONFIG_NAMESPACE);
  }
};

export const syncGlobalConfigMapToNamespace = async (k8sCore: any, namespace: string) => {
  const name = getGlobalConfigMapName();
  const sourceConfigMap = await ensureSourceGlobalConfigMap(k8sCore);
  const targetConfigMap = buildGlobalConfigMap(name, namespace, sourceConfigMap.body.data || {});

  try {
    await k8sCore.replaceNamespacedConfigMap(name, namespace, targetConfigMap);
  } catch (err: any) {
    if (!isNotFound(err)) {
      throw err;
    }
    await k8sCore.createNamespacedConfigMap(namespace, targetConfigMap);
  }
};

export const syncGlobalConfigMapToAllNamespaces = async (k8sCore: any) => {
  await ensureSourceGlobalConfigMap(k8sCore);
  const result = await k8sCore.listNamespace();
  const namespaces = result.body.items
    .map((item: any) => item.metadata?.name)
    .filter((namespace: string) => namespace && !SYSTEM_NAMESPACES.has(namespace));

  for (const namespace of namespaces) {
    await syncGlobalConfigMapToNamespace(k8sCore, namespace);
  }

  return namespaces;
};
