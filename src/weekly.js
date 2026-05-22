import { queryRecords } from './record.js';

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
  const endTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} 23:59:59`;

  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - days + 1);
  const startTime = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')} 00:00:00`;

  console.log(`[Week] 查询 ${personName} 近${days}天 (${startTime} ~ ${endTime})`);
  const records = await queryRecords(token, personId, startTime, endTime);
  console.log(`[Week] ${personName} 查到 ${records.length} 条`);

  return { name: personName, personId, records };
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
