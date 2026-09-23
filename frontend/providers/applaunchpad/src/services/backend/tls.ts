const allowSelfSignedCerts =
  process.env.ALLOW_SELF_SIGNED_CERTS === 'true' ||
  process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';

if (allowSelfSignedCerts) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

export {};
