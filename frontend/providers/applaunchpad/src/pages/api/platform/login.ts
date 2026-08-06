import { authSession, getAdminAuthorization, getUserKubeConfig, getUserKubeConfigMock } from '@/services/backend/auth';
import { getK8s } from '@/services/backend/kubernetes';
import { jsonRes } from '@/services/backend/response';
import { ApiResp } from '@/services/kubernet';
import type { NextApiRequest, NextApiResponse } from 'next';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS || 5);
const LOGIN_LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES || 30);
const SESSION_COOKIE = 'lp_session';
const CSRF_COOKIE = 'lp_csrf';

const getClientIp = (req: NextApiRequest) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string') return forwardedFor.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
};

const getAttemptKey = (req: NextApiRequest, username: string) => `${username}:${getClientIp(req)}`;

const assertNotLocked = (req: NextApiRequest, username: string) => {
  const key = getAttemptKey(req, username);
  const attempt = loginAttempts.get(key);
  if (attempt?.lockedUntil && attempt.lockedUntil > Date.now()) {
    throw new Error('登录失败次数过多，请半小时后再试');
  }
};

const recordLoginFailure = (req: NextApiRequest, username: string) => {
  const key = getAttemptKey(req, username);
  const attempt = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  const count = attempt.lockedUntil > Date.now() ? attempt.count : attempt.count + 1;
  loginAttempts.set(key, {
    count,
    lockedUntil:
      count >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOGIN_LOCK_MINUTES * 60 * 1000 : attempt.lockedUntil
  });
};

const clearLoginFailure = (req: NextApiRequest, username: string) => {
  loginAttempts.delete(getAttemptKey(req, username));
};

const isStrongPassword = (password: string) =>
  password.length >= 12 &&
  /[a-z]/.test(password) &&
  /[A-Z]/.test(password) &&
  /\d/.test(password) &&
  /[^A-Za-z0-9]/.test(password);

const getLoginSecret = () =>
  process.env.LOGIN_CRYPTO_KEY || process.env.NEXT_PUBLIC_LOGIN_CRYPTO_KEY || 'SEALOS_LOGIN_CRYPTO_KEY';

const safeEqual = (expected: Buffer, actual: Buffer) =>
  expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

const decryptAesCbcLoginBody = (body: any) => {
  const secret = getLoginSecret();
  const key = crypto.createHash('sha256').update(secret).digest();
  const ivText = String(body.iv || '');
  const dataText = String(body.data || '');
  const mac = Buffer.from(String(body.mac || ''), 'base64');
  const expectedMac = crypto.createHmac('sha256', key).update(`${ivText}.${dataText}`).digest();

  if (!safeEqual(expectedMac, mac)) {
    throw new Error('登录请求校验失败');
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivText, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataText, 'base64')),
    decipher.final()
  ]).toString('utf8');

  return JSON.parse(decrypted);
};

const decryptAesGcmLoginBody = (body: any) => {
  const secret = getLoginSecret();
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = Buffer.from(body.iv, 'base64');
  const encrypted = Buffer.from(body.data, 'base64');
  const authTag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
};

const decryptLoginBody = (body: any) => {
  if (!body?.encrypted) {
    if (process.env.LOGIN_ENCRYPTION_REQUIRED === 'false') return body;
    throw new Error('登录请求未加密');
  }

  if (body.alg === 'AES-CBC-HMAC-SHA256') {
    return decryptAesCbcLoginBody(body);
  }

  return decryptAesGcmLoginBody(body);
};

const setSecurityCookies = (res: NextApiResponse, token: string, csrfToken: string) => {
  const secure = process.env.COOKIE_SECURE === 'true' ? 'Secure; ' : '';
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=3600`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Path=/; ${secure}SameSite=Lax; Max-Age=3600`
  ]);
};

async function getKubeconfigForNamespace(req: NextApiRequest, namespace: string) {
  const { k8sCore, applyYamlList } = await getK8s({
    kubeconfig: await getAdminAuthorization(req.headers)
  });
  const saName = namespace;
  const secretName = `${saName}-token`;

  let secret = null;
  try {
    secret = await k8sCore.readNamespacedSecret(secretName, namespace);
  } catch (err: any) {
    console.log('err.response:'+(err.response?.statusCode === 404))
    if (err.response?.statusCode === 404) {
      try {
        try {
          await k8sCore.deleteNamespacedServiceAccount(saName, namespace);
        }
        catch (err: any) {
          console.error(err);
        }
        const _resp1 = await k8sCore.createNamespacedServiceAccount(namespace, {
          apiVersion: 'v1',
          kind: 'ServiceAccount',
          metadata: {
            name: saName,
            namespace: namespace
          }
        });

        const rbacYaml = `
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${saName}-role
  namespace: ${namespace}
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["*"]
---
kind: ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: read-only-role
rules:
- apiGroups: [""]
  resources: ["*"]
  verbs: ["get", "list", "watch"]
---
kind: ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: read-only-binding
subjects:
- kind: ServiceAccount
  name: ${saName}
  namespace: ${namespace}
roleRef:
  kind: ClusterRole
  name: read-only-role
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${saName}-rolebinding
  namespace: ${namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${saName}-role
subjects:
- namespace: ${namespace}
  kind: ServiceAccount
  name: ${saName}
`;

        await applyYamlList([rbacYaml], 'replace', namespace);

        const _resp = await k8sCore.createNamespacedSecret(namespace, {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            namespace: namespace,
            name: secretName,
            annotations: {
              'kubernetes.io/service-account.name': saName
            }
          },
          type: 'kubernetes.io/service-account-token'
        });

        secret = await k8sCore.readNamespacedSecret(secretName, namespace);
      } catch (err: any) {
        console.error('104:'+err);
        throw new Error('创建 secret 失败');
      }
    } else {
      console.error('108:'+err);
      throw new Error('获取 secret 失败');
    }
  }

  try {
    secret = await k8sCore.readNamespacedSecret(secretName, namespace);
  }
  catch (err: any) {
    console.error(err);
    throw new Error('获取 secret 失败');
  }
  const token = secret.body.data?.token ? Buffer.from(secret.body.data.token, 'base64').toString() : '';

  if (!token) {
    throw new Error('获取 token 失败');
  }

  const kubeconfig = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      {
        name: 'kubernetes',
        cluster: {
          // server: 'https://'+process.env.SEALOS_DOMAIN+':6443',
          server: 'https://'+process.env.SEALOS_DOMAIN+':6443',
          'certificate-authority-data': secret.body.data?.['ca.crt'] ?? '',
        }
      }
    ],
    contexts: [
      {
        name: saName,
        context: {
          cluster: 'kubernetes',
          namespace: namespace,
          user: saName
        }
      }
    ],
    'current-context': saName,
    users: [
      {
        name: saName,
        user: {
          token: token
        }
      }
    ]
  };
  return kubeconfig;
}


export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  let username = '';
  let failureRecorded = false;
  try {
    const body = decryptLoginBody(req.body);
    const password = String(body?.password || '');
    username = String(body?.username || '');

    // console.log('username:', username);
    // console.log('password:', password);
    // console.log('process.env.LAUNCHPAD_USERNAME:', process.env.LAUNCHPAD_USERNAME);
    // console.log('process.env.LAUNCHPAD_PASSWORD:', process.env.LAUNCHPAD_PASSWORD);

    let ticket: string;
    let kubeconfig: any;

    assertNotLocked(req, username);

    if (username === process.env.LAUNCHPAD_USERNAME) {
      // admin user login
      if (!isStrongPassword(process.env.LAUNCHPAD_PASSWORD || '')) {
        throw new Error('管理员密码不符合强密码要求');
      }
      if (password === process.env.LAUNCHPAD_PASSWORD) {
        // console.log('process.env.JWT_SECRET:', process.env.JWT_SECRET);
        ticket = jwt.sign(
          { username },
          process.env.JWT_SECRET || 'SEALOS_SECRET',
          { expiresIn: '1h' }
        );

        // console.log('process.env.JWT_SECRET:', process.env.JWT_SECRET);

        kubeconfig =
          process.env.NODE_ENV === 'development' ? getUserKubeConfigMock() : getUserKubeConfig();
      } else {
        recordLoginFailure(req, username);
        failureRecorded = true;
        throw new Error('用户名或密码错误');
      }
    } else {
      // sso login
      kubeconfig = await getKubeconfigForNamespace(req, username);
      ticket = jwt.sign(
        { username },
        process.env.JWT_SECRET || 'SEALOS_SECRET',
        { expiresIn: '1h' }
      );
    }

    clearLoginFailure(req, username);
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    setSecurityCookies(res, ticket, csrfToken);

    jsonRes(res, {
      data: {
        csrfToken,
        state: {
          session: {
            token: ticket,
            user: {
              k8s_username: username,
              name: username,
            },
            kubeconfig: kubeconfig
          },
          oauth_state: "",
          token: ticket,
          lastWorkSpaceId: ""
        },
        version: 0
      }
    });

  } catch (err: any) {
    if (username && !failureRecorded) recordLoginFailure(req, username);
    const statusCode = err?.message?.includes('次数过多') ? 429 : 401;
    const message =
      statusCode === 429
        ? '登录失败次数过多，请半小时后再试'
        : err?.message === '登录请求未加密'
          ? '登录请求未加密'
          : '用户名或密码错误';

    res.status(statusCode);
    jsonRes(res, {
      code: statusCode,
      message
    });
  }
}
