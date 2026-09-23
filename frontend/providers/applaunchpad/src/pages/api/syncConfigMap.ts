import { authSession, getAdminAuthorization } from '@/services/backend/auth';
import { getK8s } from '@/services/backend/kubernetes';
import { jsonRes } from '@/services/backend/response';
import { ApiResp } from '@/services/kubernet';
import type { NextApiRequest, NextApiResponse } from 'next';
import { syncGlobalConfigMapToAllNamespaces } from '@/services/backend/configmap';

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  try {
    const { k8sCore } = await getK8s({
          kubeconfig: await authSession(req.headers)
        // kubeconfig: await getAdminAuthorization(req.headers)
    });

    const namespaces = await syncGlobalConfigMapToAllNamespaces(k8sCore);

    jsonRes(res, {
        data: {
            message: 'successfully synced',
            namespaces
        }
    });
  } catch (err: any) {
    jsonRes(res, {
      code: 500,
      error: err
    });
  }
}
