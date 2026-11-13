import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResp } from '@/services/kubernet';
import { authSession } from '@/services/backend/auth';
import { getK8s } from '@/services/backend/kubernetes';
import { jsonRes } from '@/services/backend/response';
import { maxReplicasKey, minReplicasKey, pauseKey } from '@/constants/app';
import { json2HPA } from '@/utils/deployYaml2Json';
import { AppEditType } from '@/types/app';
import { patchAppScale } from '@/services/backend/replicas';

type UpdateReplicaParams = {
  appName: string;
  replica: string;
};
export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  try {
    const { appName, replica } = req.body as UpdateReplicaParams;
    console.log(appName, replica);

    if (!appName) {
      throw new Error('appName is empty');
    }

    let result;

    if (Number(replica) === 0) {
      result = await PauseApp({ appName, replica, req });
    } else {
      result = await StartApp({ appName, replica, req });
    }

    jsonRes(res, { data: result });
  } catch (err: any) {
    jsonRes(res, {
      code: 500,
      error: err
    });
  }
}

export async function PauseApp({
  appName,
  replica,
  req
}: UpdateReplicaParams & { req: NextApiRequest }) {
  const reqNamespace = req.query.namespace as string;
  const { apiClient, k8sAutoscaling, getDeployApp, namespace } = await getK8s({
    kubeconfig: await authSession(req.headers)
  });

  const app = await getDeployApp(appName, reqNamespace);
  if (!app.metadata?.name || !app?.metadata?.annotations || !app.spec) {
    throw new Error('app data error');
  }

  // store restart data
  const restartAnnotations: Record<string, string> = {
    target: '',
    value: ''
  };

  const requestQueue: Promise<any>[] = [];

  // check whether there are hpa
  try {
    const { body: hpa } = await k8sAutoscaling.readNamespacedHorizontalPodAutoscaler(
      appName,
      reqNamespace
    );
    restartAnnotations.target = hpa?.spec?.metrics?.[0]?.resource?.name || 'cpu';
    restartAnnotations.value = `${
      hpa?.spec?.metrics?.[0]?.resource?.target?.averageUtilization || 50
    }`;
    requestQueue.push(k8sAutoscaling.deleteNamespacedHorizontalPodAutoscaler(appName, reqNamespace)); // delete HorizontalPodAutoscaler
  } catch (error: any) {
    if (error?.statusCode !== 404) {
      return Promise.reject('无法读取到hpa');
    }
  }

  // replace source file
  app.metadata.annotations[pauseKey] = JSON.stringify(restartAnnotations);
  app.spec.replicas = 0;

  requestQueue.push(patchAppScale(apiClient, app, 0, app.metadata.annotations[pauseKey]));

  return (await Promise.all(requestQueue)).map((item) => item?.body || item);
}

export async function StartApp({
  appName,
  replica,
  req
}: UpdateReplicaParams & { req: NextApiRequest }) {
  const reqNamespace = req.query.namespace as string;
  const { apiClient, getDeployApp, applyYamlList } = await getK8s({
    kubeconfig: await authSession(req.headers)
  });

  const app = await getDeployApp(appName, reqNamespace);

  if (!app.metadata?.name || !app?.metadata?.annotations || !app.spec) {
    throw new Error('app data error');
  }

  app.spec.replicas = +replica;

  const scaleResult = await patchAppScale(apiClient, app, +replica, null);
  const requestQueue: Promise<any>[] = [Promise.resolve(scaleResult)];

  if (app.metadata.annotations[pauseKey]) {
    const pauseData: {
      target: string;
      value: string;
    } = JSON.parse(app.metadata.annotations[pauseKey]);

    // replace source file
    delete app.metadata.annotations[pauseKey];
    console.log(pauseData, 'pauseData');
    if (pauseData.target) {
      const hpaYaml = json2HPA({
        appName,
        hpa: {
          use: true,
          target: pauseData.target,
          value: Number(pauseData.value) / 10,
          minReplicas: app.metadata.annotations[minReplicasKey]
            ? app.metadata.annotations[minReplicasKey]
            : '1',
          maxReplicas: app.metadata.annotations[maxReplicasKey]
            ? app.metadata.annotations[maxReplicasKey]
            : '2'
        }
      } as unknown as AppEditType, app.kind === 'StatefulSet' ? 'StatefulSet' : 'Deployment');

      requestQueue.push(applyYamlList([hpaYaml], 'create', reqNamespace));
    }
  }

  return (await Promise.all(requestQueue)).map((item) => item?.body || item);
}
