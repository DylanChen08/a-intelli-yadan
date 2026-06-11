import { queryRecords, extractPhotoUrl } from './record.js';

/**
 * 查询某人最近 N 天的通行记录（用于周对比）
 * @param {string} token
 * @param {string} personId
 * @param {string} personName
 * @param {number} days - 查询天数，默认 7
 * @returns {{ name: string, personId: string, records: Array }}
 */
export async function getPersonWeekRecords(token, personId, personName, days = 7) {
  const now = new Date();
  const allRecords = [];

  // 按天单独查询并合并（规避 API bug：跨天查询若包含无数据日期会整体返回空）
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const startTime = `${dateStr} 00:00:00`;
    const endTime = `${dateStr} 23:59:59`;

    try {
      const dayRecords = await queryRecords(token, personId, startTime, endTime, 100);
      allRecords.push(...dayRecords);
    } catch (err) {
      console.warn(`[Week] ${personName} ${dateStr} 查询失败: ${err.message}`);
    }
  }

  console.log(`[Week] ${personName} 近${days}天合计 ${allRecords.length} 条`);
  return { name: personName, personId, records: allRecords };
}

/**
 * 查询某人近 N 天的所有通行记录（含抓拍照片URL），用于月度打卡明细
 * 按天单独查询规避 API 跨天 bug，每条记录自动附加 photoUrl 字段
 * @param {string} token
 * @param {string} personId
 * @param {string} personName
 * @param {number} days - 查询天数，默认 30
 * @returns {{ name: string, personId: string, records: Array }}
 */
export async function getPersonMonthRecords(token, personId, personName, days = 30) {
  const now = new Date();
  const allRecords = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const startTime = `${dateStr} 00:00:00`;
    const endTime = `${dateStr} 23:59:59`;

    try {
      // pageSize=200，月度数据单天一般不超过此数
      const dayRecords = await queryRecords(token, personId, startTime, endTime, 200);
      // 给每条记录附上 photoUrl
      for (const r of dayRecords) {
        r.photoUrl = extractPhotoUrl(r);
      }
      allRecords.push(...dayRecords);
    } catch (err) {
      console.warn(`[Month] ${personName} ${dateStr} 查询失败: ${err.message}`);
    }
  }

  console.log(`[Month] ${personName} 近${days}天合计 ${allRecords.length} 条`);
  return { name: personName, personId, records: allRecords };
}

/**
 * 从通行记录中提取每日第一次进门和最后一次出门时间
 * @param {Array} records - 通行记录数组
 * @param {number} days - 天数
 * @returns {Array<{ date: string, firstIn: string|null, lastOut: string|null }>}
 */
export function extractDailyTimes(records, days = 7) {
  const now = new Date();
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }

  const dailyMap = {};
  for (const date of dates) {
    dailyMap[date] = { date, firstIn: null, lastOut: null };
  }

  for (const r of records) {
    const dateStr = (r.identifyTime || '').split(' ')[0];
    if (!dailyMap[dateStr]) continue;

    const deviceName = (r.deviceName || '').toLowerCase();
    const isOut = deviceName.includes('出');
    const timeStr = (r.identifyTime || '').split(' ')[1]?.substring(0, 5) || ''; // HH:mm

    if (!timeStr) continue;

    if (!isOut) {
      // 进门：取最早的一次
      if (!dailyMap[dateStr].firstIn || timeStr < dailyMap[dateStr].firstIn) {
        dailyMap[dateStr].firstIn = timeStr;
      }
    } else {
      // 出门：取最晚的一次
      if (!dailyMap[dateStr].lastOut || timeStr > dailyMap[dateStr].lastOut) {
        dailyMap[dateStr].lastOut = timeStr;
      }
    }
  }

  return dates.map(d => dailyMap[d]);
}
