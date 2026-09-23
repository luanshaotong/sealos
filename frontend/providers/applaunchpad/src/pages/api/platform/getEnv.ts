import { jsonRes } from '@/services/backend/response';
import { ApiResp } from '@/services/kubernet';
import { EnvResponse } from '@/types/index';
import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  jsonRes<EnvResponse>(res, {
    data: {
      domain: process.env.SEALOS_DOMAIN || 'cloud.sealos.io',
      guideEnabled: process.env.GUIDE_ENABLED === 'true',
      monitorPageProtocol: process.env.MONITOR_PAGE_PROTOCOL || 'http',
      monitorPagePort: process.env.MONITOR_PAGE_PORT || '30971',
      monitorPagePath: process.env.MONITOR_PAGE_PATH || '/d/rYdddlPWk/node-exporter-full'
    }
  });
}
