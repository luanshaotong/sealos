import axios, {
  InternalAxiosRequestConfig,
  AxiosHeaders,
  AxiosResponse,
  AxiosRequestConfig
} from 'axios';
import type { ApiResp } from './kubernet';
import { isApiResp } from './kubernet';
import { getUserKubeConfig } from '@/utils/user';

const request = axios.create({
  baseURL: '/',
  withCredentials: true,
  timeout: 600000
});

// request interceptor
request.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // auto append service prefix
    if (config.url && !config.url?.startsWith('/api/')) {
      config.url = '' + config.url;
    }
    let _headers: AxiosHeaders = config.headers;

    //获取token，并将其添加至请求头中
    let kc = JSON.stringify(getUserKubeConfig());
    _headers['Authorization'] = encodeURIComponent(kc);
    // console.log('Authorization:', _headers['Authorization']);
    if (!config.headers || config.headers['Content-Type'] === '') {
      _headers['Content-Type'] = 'application/json';
    }

    config.headers = _headers;
    return config;
  },
  (error: any) => {
    error.data = {};
    error.data.msg = '服务器异常，请联系管理员！';
    return Promise.resolve(error);
  }
);

// response interceptor
request.interceptors.response.use(
  (response: AxiosResponse) => {
    const { status, data } = response;
    if (status < 200 || status >= 300 || !isApiResp(data)) {
      return Promise.reject(data);
    }

    const apiResp = data as ApiResp;
    if (apiResp.code < 200 || apiResp.code >= 400) {
      return Promise.reject(apiResp);
    }

    response.data = apiResp.data;
    return response.data;
  },
  (error: any) => {
    if (axios.isCancel(error)) {
      return Promise.reject('cancel request' + String(error));
    } else {
      error.errMessage = '请求超时或服务器异常，请检查网络或联系管理员！';
    }
    return Promise.reject(error);
  }
);

export function GET<T = any>(
  url: string,
  data?: { [key: string]: any },
  config?: AxiosRequestConfig
): Promise<T> {
  return request.get(url, {
    params: data,
    ...config
  });
}
export function POST<T = any>(
  url: string,
  data?: { [key: string]: any },
  config?: AxiosRequestConfig
): Promise<T> {
  return request.post(url, data, config);
}

export function PUT<T = any>(
  url: string,
  data?: { [key: string]: any },
  config?: AxiosRequestConfig
): Promise<T> {
  return request.put(url, data, config);
}
export function DELETE<T = any>(
  url: string,
  data?: { [key: string]: any },
  config?: AxiosRequestConfig
): Promise<T> {
  return request.delete(url, {
    params: data,
    ...config
  });
}
