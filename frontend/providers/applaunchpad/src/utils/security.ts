import CryptoJS from 'crypto-js';

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const getLoginCryptoSecret = () =>
  process.env.NEXT_PUBLIC_LOGIN_CRYPTO_KEY || 'SEALOS_LOGIN_CRYPTO_KEY';

const getLoginCryptoKey = async () => {
  const secret = getLoginCryptoSecret();
  if (!textEncoder) {
    throw new Error('Crypto is not supported');
  }
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
};

const encryptLoginPayloadByCryptoJs = (payload: { username: string; password: string }) => {
  const secret = getLoginCryptoSecret();
  const key = CryptoJS.SHA256(secret);
  const iv = CryptoJS.lib.WordArray.random(16);
  const encrypted = CryptoJS.AES.encrypt(JSON.stringify(payload), key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  });
  const ivText = CryptoJS.enc.Base64.stringify(iv);
  const dataText = CryptoJS.enc.Base64.stringify(encrypted.ciphertext);
  const mac = CryptoJS.HmacSHA256(`${ivText}.${dataText}`, key).toString(CryptoJS.enc.Base64);

  return {
    encrypted: true,
    alg: 'AES-CBC-HMAC-SHA256',
    iv: ivText,
    data: dataText,
    mac
  };
};

export const encryptLoginPayload = async (payload: { username: string; password: string }) => {
  if (!crypto?.subtle || !textEncoder) {
    return encryptLoginPayloadByCryptoJs(payload);
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getLoginCryptoKey();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(JSON.stringify(payload))
  );

  return {
    encrypted: true,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted))
  };
};

export const getCsrfToken = () => {
  if (typeof document === 'undefined') return '';
  const item = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith('lp_csrf='));
  return item ? decodeURIComponent(item.split('=').slice(1).join('=')) : '';
};
