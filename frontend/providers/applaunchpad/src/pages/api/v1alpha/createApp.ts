import { formData2Yamls } from '@/pages/app/edit';
import { authSession, getAdminAuthorization } from '@/services/backend/auth';
import { syncGlobalConfigMapToAllNamespaces } from '@/services/backend/configmap';
import { getK8s } from '@/services/backend/kubernetes';
import { jsonRes } from '@/services/backend/response';
import { ApiResp } from '@/services/kubernet';
import { serverLoadInitData } from '@/store/static';
import { AppEditType } from '@/types/app';
import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  const reqNamespace = req.query.namespace as string;
  try {
    const { appForm } = req.body as { appForm: AppEditType };
    // important load env
    serverLoadInitData();

    const { applyYamlList } = await getK8s({
      kubeconfig: await authSession(req.headers)
    });

    const parseYamls = formData2Yamls(appForm);

    const yamls = parseYamls.map((item) => item.value);

    const result = await applyYamlList(yamls, 'create', reqNamespace);

    try {
      const { k8sCore } = await getK8s({
        kubeconfig: await getAdminAuthorization(req.headers)
      });
      await syncGlobalConfigMapToAllNamespaces(k8sCore);
    } catch (syncErr) {
      console.error('sync global configmap after v1alpha app create failed:', syncErr);
    }

    jsonRes(res, { data: result });
  } catch (err: any) {
    jsonRes(res, {
      code: 500,
      error: err?.body || err
    });
  }
}
