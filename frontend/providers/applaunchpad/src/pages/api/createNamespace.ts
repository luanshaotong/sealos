import { authSession } from '@/services/backend/auth';
import { getK8s } from '@/services/backend/kubernetes';
import { jsonRes } from '@/services/backend/response';
import { ApiResp } from '@/services/kubernet';
import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  try {
    const { k8sCore } = await getK8s({
      kubeconfig: await authSession(req.headers)
    });

    const { ns } = req.body as {
      ns: string;
    };

    const namespace = {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: ns
      }
    };

    const namespaceResult = await k8sCore.createNamespace(namespace);

    const resourceQuota = {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: {
        name: 'quota',
        namespace: ns
      },
      spec: {
        hard: {
          'services': '5',
          'requests.storage': '10Gi',
          'persistentvolumeclaims': '5',
          'limits.cpu': '4',
          'limits.memory': '8Gi'
        }
      }
    };

    
    const name = process.env.GLOBAL_CONFIGMAP_NAME || 'global-configmap';

    const cm_namespace = "default";

    const configMap = await k8sCore.readNamespacedConfigMap(name, cm_namespace);

    
    const new_configMap = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
        name: name,
        namespace: ns
        },
        data: {
        ...configMap.body.data
        }
    };
    
    await k8sCore.createNamespacedConfigMap(ns, new_configMap);

    const resourceQuotaResult = await k8sCore.createNamespacedResourceQuota(ns, resourceQuota);

    jsonRes(res, {
      data: {
        namespace: namespaceResult,
        resourceQuota: resourceQuotaResult
      }
    });
  } catch (err: any) {
    jsonRes(res, {
      code: 500,
      error: err
    });
  }
}
