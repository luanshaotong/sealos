import { NextApiResponse } from 'next';
import { ERROR_TEXT, ERROR_RESPONSE } from '../error';

const resourceNameMap: Record<string, string> = {
  deployments: '应用',
  deployment: '应用',
  statefulsets: '应用',
  statefulset: '应用',
  services: '访问配置',
  service: '访问配置',
  ingresses: '网关配置',
  ingress: '网关配置',
  configmaps: '配置文件',
  configmap: '配置文件',
  secrets: '密钥',
  secret: '密钥',
  horizontalpodautoscalers: '自动伸缩配置',
  horizontalpodautoscaler: '自动伸缩配置'
};

const getK8sErrorBody = (error: any) => error?.body || error?.response?.body || error;

const getDisplayErrorMessage = (error: any) => {
  const body = getK8sErrorBody(error);
  const reason = body?.reason || error?.reason;
  const statusCode = Number(body?.code || error?.statusCode || error?.code || 0);
  const rawMessage =
    typeof body === 'string'
      ? body
      : body?.message || error?.message || (typeof error === 'string' ? error : '');

  if (reason === 'AlreadyExists' || statusCode === 409 || /already exists/i.test(rawMessage)) {
    const match = rawMessage.match(/([a-z0-9.-]+)(?:\.[a-z0-9.-]+)?\s+"([^"]+)"\s+already exists/i);
    const resourceKey = match?.[1]?.split('.')[0].toLowerCase();
    const resourceText = resourceKey ? resourceNameMap[resourceKey] || resourceKey : '资源';
    const nameText = match?.[2] ? `「${match[2]}」` : '';
    return `${resourceText}${nameText}已存在，请更换名称后重试`;
  }

  if (reason === 'NotFound' || statusCode === 404) return '资源不存在或已被删除';
  if (reason === 'Forbidden' || statusCode === 403) return '没有权限执行该操作';
  if (reason === 'Unauthorized' || statusCode === 401) return '凭证错误';
  if (reason === 'Invalid' || statusCode === 422) {
    return rawMessage || '参数不合法，请检查配置后重试';
  }

  return rawMessage;
};

export const jsonRes = <T = any>(
  res: NextApiResponse,
  props?: {
    code?: number;
    message?: string;
    data?: T;
    error?: any;
  }
) => {
  const { code = 200, message = '', data = null, error } = props || {};
  const isProd = process.env.NODE_ENV === 'production';

  // Specified error
  if (typeof error === 'string' && ERROR_RESPONSE[error]) {
    return res.json(ERROR_RESPONSE[error]);
  }

  // another error
  let msg = message;
  if ((code < 200 || code >= 400) && !message) {
    const displayMessage = getDisplayErrorMessage(error);
    if (isProd) {
      msg =
        displayMessage && !/^\[object Object\]$/.test(displayMessage)
          ? displayMessage
          : code === 404
            ? '资源不存在'
            : code === 401 || code === 403
              ? '凭证错误'
              : '请求错误';
    } else {
      msg = displayMessage || '请求错误';
      if (typeof error === 'string') {
        msg = error;
      } else if (error?.code && error.code in ERROR_TEXT) {
        msg = ERROR_TEXT[error.code];
      }
    }
    console.error('===jsonRes error===\n ', error?.body || error);
  }

  res.json({
    code,
    statusText: '',
    message: msg,
    data: data || (isProd && (code < 200 || code >= 400) ? null : error) || null
  });
};
