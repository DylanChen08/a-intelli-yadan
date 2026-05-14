import https from 'https';
import axios from 'axios';
import NodeRSA from 'node-rsa';
import { randomUUID } from 'crypto';

const BASE_URL = 'https://api.maxvisioncloud.com';

const API = {
  PUBLIC_KEY: `${BASE_URL}/base-user-permission/security/public/key`,
  LOGIN: `${BASE_URL}/base-user-permission/sso/client/login`,
};

// 共享的 axios 实例（禁用 TLS 严格验证）
const agent = new https.Agent({ rejectUnauthorized: false });

export const api = axios.create({
  httpsAgent: agent,
  timeout: 30000,
});

// ---- Cookie 管理 ----
let cookieJar = '';

function setCookieFromResponse(response) {
  const setCookie = response.headers['set-cookie'];
  if (setCookie && setCookie.length > 0) {
    cookieJar = setCookie.map((c) => c.split(';')[0]).join('; ');
    console.log('[Auth] Cookie 已更新');
  }
}

function getCookieHeader() {
  return cookieJar;
}

// ---- 缓存 ----
let cachedToken = null;
let tokenExpireTime = 0;

/**
 * 获取 RSA 公钥
 */
export async function getPublicKey() {
  const { data } = await api.get(API.PUBLIC_KEY);
  if (!data.success) throw new Error('获取公钥失败: ' + data.msg);
  return {
    publicKey: data.data.publicKey,
    expiresIn: data.data.expiresIn,
  };
}

/**
 * 使用 RSA 公钥加密密码
 * @param {string} plainPassword - 明文密码
 * @param {string} publicKeyStr - 公钥字符串（不含头尾标记）
 */
export function encryptPassword(plainPassword, publicKeyStr) {
  const rsa = new NodeRSA();
  rsa.importKey(
    `-----BEGIN PUBLIC KEY-----\n${publicKeyStr}\n-----END PUBLIC KEY-----`,
    'pkcs8-public'
  );
  rsa.setOptions({ encryptionScheme: 'pkcs1' });
  return rsa.encrypt(plainPassword, 'base64');
}

/**
 * 登录获取 Token
 * @param {object} credentials - { username, password }
 * @param {string} credentials.username
 * @param {string} credentials.password - 明文密码
 */
export async function login(credentials) {
  // 1. 获取公钥
  const { publicKey } = await getPublicKey();

  // 2. 加密密码
  const encryptedPwd = encryptPassword(credentials.password, publicKey);

  // 3. 调用登录接口
  const response = await api.post(API.LOGIN, {
    username: credentials.username,
    password: encryptedPwd,
    deviceType: 'PC',
    deviceNo: generateDeviceNo(),
    captcha: '',
    platformType: 1,
  });

  const { data } = response;

  if (!data.success || data.code !== 200) {
    throw new Error('登录失败: ' + (data.msg || '未知错误'));
  }

  // 4. 保存 Cookie（sa-token 框架通过 Cookie 传递会话）
  setCookieFromResponse(response);

  // 5. 缓存 Token
  cachedToken = data.data;
  tokenExpireTime = Date.now() + 20 * 60 * 1000; // 20分钟后过期（预留缓冲）

  console.log('[Auth] 登录成功，Token 已获取');
  return cachedToken;
}

/**
 * 获取有效的 Token，过期自动重新登录
 */
export async function getToken(credentials) {
  if (cachedToken && Date.now() < tokenExpireTime) {
    return cachedToken;
  }
  console.log('[Auth] Token 已过期或不存在，重新登录...');
  return login(credentials);
}

/**
 * 获取当前 Cookie 字符串（用于后续请求）
 */
export function getAuthCookie() {
  return getCookieHeader();
}

/**
 * 生成设备唯一标识
 */
function generateDeviceNo() {
  return randomUUID().replace(/-/g, '');
}
