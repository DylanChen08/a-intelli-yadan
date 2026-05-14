import { api, getAuthCookie } from './auth.js';

const BASE_URL = 'https://api.maxvisioncloud.com';
const API_RECORD = `${BASE_URL}/bp-acs/record/queryIdentifyRecord`;

/**
 * 查询某人的通行记录
 * @param {string} token - 认证 Token
 * @param {string} personId - 人员 ID
 * @param {string} startTime - 开始时间 (yyyy-MM-dd HH:mm:ss)
 * @param {string} endTime - 结束时间 (yyyy-MM-dd HH:mm:ss)
 * @returns {Array} 通行记录数组
 */
export async function queryRecords(token, personId, startTime, endTime) {
  const body = {
    pageNum: 1,
    pageSize: 100,
    startTime,
    endTime,
    times: [],
    personName: '',
    identifyStatus: '',
    identifyStatus1: '',
    personId,
  };

  // sa-token 框架通过 Cookie 传递会话，需要带上登录时获取的 Cookie
  const cookie = getAuthCookie();

  const { data } = await api.post(API_RECORD, body, {
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
    },
  });

  if (!data.success) {
    throw new Error(`查询通行记录失败: ${data.msg} (personId: ${personId})`);
  }

  return data.data || [];
}

/**
 * 获取今天的日期范围
 * @returns {{ startTime: string, endTime: string }}
 */
export function getTodayRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return {
    startTime: `${y}-${m}-${d} 00:00:00`,
    endTime: `${y}-${m}-${d} 23:59:59`,
  };
}

/**
 * 从单条通行记录中提取抓拍图片 URL
 * @param {object} record
 * @returns {string|null}
 */
export function extractPhotoUrl(record) {
  if (!record || !record.identifyImage) return null;
  const val = record.identifyImage;
  if (typeof val !== 'string' || val.length === 0) return null;
  // 已经是完整 URL 就直接返回
  if (val.startsWith('http://') || val.startsWith('https://')) return val;
  // 否则拼接基础 URL
  return `https://api.maxvisioncloud.com${val.startsWith('/') ? '' : '/'}${val}`;
}

/**
 * 从通行记录中提取下班打卡记录
 * 判断逻辑：设备名称包含"出"（出口方向）的记录视为离岗/下班
 * @param {Array} records - 通行记录数组
 * @returns {Array} 下班记录数组 [{ time, location, similarity, photoUrl }]
 */
export function extractLeaveRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  // 过滤出门方向的记录（deviceName 包含 "出"）
  const leaveRecords = records.filter((r) => {
    const name = (r.deviceName || '').toLowerCase();
    return name.includes('出');
  });

  // 按时间倒序，取最近的一条作为"下班时间"
  if (leaveRecords.length === 0) return [];

  // 排序：最新的在前面
  leaveRecords.sort(
    (a, b) => new Date(b.identifyTime) - new Date(a.identifyTime)
  );

  // 返回最晚的一条
  const latest = leaveRecords[0];
  return [
    {
      time: latest.identifyTime,
      location: latest.deviceName,
      similarity: latest.similarity,
      passStatus: latest.passStatus === '1',
      photoUrl: extractPhotoUrl(latest),
    },
  ];
}

/**
 * 查询某人今天的下班信息
 * @param {string} token
 * @param {string} personId
 * @param {string} personName
 * @param {{ startTime?: string, endTime?: string }} timeConfig
 * @returns {{ name: string, leaveInfo: object|null, allRecords: Array }}
 */
export async function getPersonLeaveToday(token, personId, personName, timeConfig = {}) {
  const { startTime: customStart, endTime: customEnd } = timeConfig;
  const todayRange = getTodayRange();
  const startTime = customStart || todayRange.startTime;
  const endTime = customEnd || todayRange.endTime;

  console.log(`[Record] 查询 ${personName} (${personId}) 的通行记录...`);
  const records = await queryRecords(token, personId, startTime, endTime);
  console.log(`[Record] 查到 ${records.length} 条记录`);

  const leaveRecords = extractLeaveRecords(records);
  const leaveInfo = leaveRecords.length > 0 ? leaveRecords[0] : null;

  return {
    name: personName,
    personId,
    leaveInfo,
    allRecords: records,
    leaveCount: leaveRecords.length,
  };
}
