import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_FILE = /\.(.*)$/;
const SESSION_COOKIE = 'lp_session';
const CSRF_COOKIE = 'lp_csrf';

const authRequired = process.env.AUTH_REQUIRED_ALL === 'true';
const csrfEnabled = process.env.CSRF_ENABLED !== 'false';

const publicPaths = [
  '/login',
  '/api/platform/login',
  '/api/platform/getInitData',
  '/api/platform/getEnv'
];

const getAllowedOrigins = (req: NextRequest) => {
  const configured = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.length > 0) return configured;

  const host = req.headers.get('host');
  return host ? [`${req.nextUrl.protocol}//${host}`] : [];
};

const isPublicPath = (pathname: string) =>
  publicPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));

const hasAuth = (req: NextRequest) =>
  Boolean(req.cookies.get(SESSION_COOKIE)?.value || req.headers.get('authorization'));

const setCorsHeaders = (req: NextRequest, res: NextResponse) => {
  const origin = req.headers.get('origin');
  if (!origin) return res;

  const allowedOrigins = getAllowedOrigins(req);
  if (!allowedOrigins.includes(origin)) return res;

  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Access-Control-Allow-Credentials', 'true');
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token');
  res.headers.set('Vary', 'Origin');
  return res;
};

const isSameOrigin = (req: NextRequest) => {
  const allowedOrigins = getAllowedOrigins(req);
  const origin = req.headers.get('origin');
  if (origin) return allowedOrigins.includes(origin);

  const referer = req.headers.get('referer');
  if (!referer) return false;

  try {
    const refererUrl = new URL(referer);
    return allowedOrigins.includes(refererUrl.origin);
  } catch {
    return false;
  }
};

const rejectJson = (req: NextRequest, code: number, message: string) =>
  setCorsHeaders(
    req,
    NextResponse.json({ code, statusText: '', message, data: null }, { status: code })
  );

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith('/_next') || pathname === '/favicon.ico' || PUBLIC_FILE.test(pathname)) {
    return NextResponse.next();
  }

  if (req.method === 'OPTIONS') {
    return setCorsHeaders(req, new NextResponse(null, { status: 204 }));
  }

  if (pathname.startsWith('/api/')) {
    if (authRequired && !isPublicPath(pathname) && !hasAuth(req)) {
      return rejectJson(req, 401, '未授权');
    }

    const unsafeMethod = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (csrfEnabled && unsafeMethod && !isPublicPath(pathname)) {
      const csrfCookie = req.cookies.get(CSRF_COOKIE)?.value;
      const csrfHeader = req.headers.get('x-csrf-token');
      if (!isSameOrigin(req) || !csrfCookie || csrfCookie !== csrfHeader) {
        return rejectJson(req, 403, 'CSRF 校验失败');
      }
    }

    return setCorsHeaders(req, NextResponse.next());
  }

  if (authRequired && !isPublicPath(pathname) && !hasAuth(req)) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
};
