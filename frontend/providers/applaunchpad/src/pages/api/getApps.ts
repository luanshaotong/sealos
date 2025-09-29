import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResp } from '@/services/kubernet';
import { authSession } from '@/services/backend/auth';
import { getK8s } from '@/services/backend/kubernetes';
import { jsonRes } from '@/services/backend/response';
import { appDeployKey } from '@/constants/app';

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  try {
    const result = await GetApps({ req });

    jsonRes(res, { data: result });
  } catch (err: any) {
    jsonRes(res, {
      code: 500,
      error: err
    });
  }
}

export async function GetApps({ req }: { req: NextApiRequest }) {
  const req_namespace = req.query.namespace as string;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || 10;
  const appName = req.query.appName as string;

  const { k8sApp, namespace } = await getK8s({
    kubeconfig: await authSession(req.headers)
  });

  const response = await Promise.allSettled([
    k8sApp.listNamespacedDeployment(
      req_namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      appDeployKey
    ),
    k8sApp.listNamespacedStatefulSet(
      req_namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      appDeployKey
    )
  ]);

  const allApps = response
    .filter((item) => item.status === 'fulfilled')
    .map((item: any) => item?.value?.body?.items)
    .filter((item) => item)
    .flat();

  // 按创建时间降序排序（最新的在前）
  allApps.sort((a, b) => {
    const timeA = new Date(a.metadata?.creationTimestamp || 0).getTime();
    const timeB = new Date(b.metadata?.creationTimestamp || 0).getTime();
    return timeB - timeA;
  });

  // 按应用名称过滤
  let filteredApps = allApps;
  if (appName && appName.trim()) {
    filteredApps = allApps.filter((app) =>
      app.metadata?.name?.toLowerCase().includes(appName.toLowerCase())
    );
  }

  // 计算分页
  const total = filteredApps.length;
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const apps = filteredApps.slice(startIndex, endIndex);

  return {
    apps,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  };
}
