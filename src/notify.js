import axios from 'axios';

const SERVER_CHAN_URL = 'https://sctapi.ftqq.com';

/**
 * 通过 Server酱 推送微信消息
 * @param {string} sendKey - Server酱 SendKey
 * @param {string} title - 消息标题
 * @param {string} content - 消息内容（支持 Markdown）
 */
export async function sendNotify(sendKey, title, content) {
  if (!sendKey) {
    console.warn('[Notify] 未配置 SendKey，跳过推送。消息内容如下：');
    console.log(`  标题: ${title}`);
    console.log(`  内容: ${content}`);
    return;
  }

  try {
    const { data } = await axios.post(
      `${SERVER_CHAN_URL}/${sendKey}.send`,
      new URLSearchParams({ title, desp: content }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    if (data.code === 0) {
      console.log('[Notify] 推送成功');
    } else {
      console.warn(`[Notify] 推送返回异常: code=${data.code}, message=${data.message}`);
    }
  } catch (err) {
    console.error('[Notify] 推送失败:', err.message);
  }
}

/**
 * 构建智能日报（Kimi 生成）
 * @param {Array} personResults - 人员通行记录查询结果
 * @param {string} kimiContent - Kimi 返回的 Markdown 内容
 * @returns {{ title: string, content: string }}
 */
/**
 * 生成 Markdown 表格（吴雅丹打卡记录）
 * @param {Array} records
 * @returns {string}
 */
function buildTable(records) {
  const lines = [];
  lines.push('| 时间 | 方向 | 门 | 通行状态 | 抓拍照片 |');
  lines.push('|------|------|------|----------|----------|');

  for (const r of records) {
    const time = r.identifyTime || '-';
    const direction = (r.deviceName || '').includes('出') ? '出门' : '进门';
    const door = r.deviceName || '未知';
    const status = r.passStatus === '1' ? '正常' : '异常';
    const photo = r.photoUrl ? `[📷 查看照片](${r.photoUrl})` : '无';
    lines.push(`| ${time} | ${direction} | ${door} | ${status} | ${photo} |`);
  }

  return lines.join('\n');
}

export function buildSmartReport(personResults, kimiContent) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekDay = weekDays[today.getDay()];

  const title = `🤖 智能日报 ${dateStr} 周${weekDay}`;

  // 找到吴雅丹的记录并生成表格
  const wuYadan = personResults.find(p => p.name === '吴雅丹');
  let tablePart = '';
  if (wuYadan && wuYadan.allRecords && wuYadan.allRecords.length > 0) {
    tablePart = `主人，今日汇报如下\n\n📋 **吴雅丹 打卡记录**\n\n${buildTable(wuYadan.allRecords)}\n\n---\n\n`;
  } else {
    tablePart = `主人，今日汇报如下\n\n📋 **吴雅丹 打卡记录**\n\n吴雅丹今天暂无打卡记录\n\n---\n\n`;
  }

  const content = `${tablePart}${kimiContent}\n\n---\n\n> 🤖 由 Kimi AI 智能分析生成 | ${dateStr} 周${weekDay}`;

  return { title, content };
}

/**
 * 构建模板日报（fallback 用）
 * @param {Array} personResults - [{ name, leaveInfo, leaveCount }]
 * @param {number} closeThreshold - 时间差阈值（分钟）
 * @returns {{ title: string, content: string }}
 */
export function buildDailyReport(personResults, closeThreshold = 10) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekDay = weekDays[today.getDay()];

  const title = `📋 下班日报 ${dateStr} 周${weekDay}`;

  let content = `## 📋 下班日报 ${dateStr}（周${weekDay}）\n\n---\n\n`;

  const times = [];

  for (const person of personResults) {
    content += `### ${person.name}\n\n`;

    if (person.leaveInfo) {
      const timeStr = person.leaveInfo.time.split(' ')[1]; // 取 HH:mm:ss
      const hmStr = timeStr.substring(0, 5); // 取 HH:mm
      times.push({ name: person.name, time: person.leaveInfo.time, hm: hmStr });

      content += `- 🕐 下班时间：**${hmStr}**\n`;
      content += `- 📍 出口位置：${person.leaveInfo.location || '未知'}\n`;
      content += `- 🔒 通行状态：${person.leaveInfo.passStatus ? '正常通行' : '异常'}\n`;

      // 嵌入抓拍图片链接（可点击打开）
      if (person.leaveInfo.photoUrl) {
        content += `- 📷 [查看抓拍图片](${person.leaveInfo.photoUrl})\n`;
      }

      // 关怀提示
      const hour = parseInt(timeStr.split(':')[0], 10);
      if (hour >= 20) {
        content += `- ⚠️ **今天加班到很晚，注意休息！**\n`;
      } else if (hour >= 19) {
        content += `- 🌙 今天晚走了一点\n`;
      }
    } else {
      content += `- ❌ **今天没有下班打卡记录**\n`;
    }

    content += `\n`;
  }

  // 比较时间差
  if (times.length >= 2) {
    content += `---\n\n### ⏱️ 时间对比\n\n`;

    for (let i = 0; i < times.length; i++) {
      for (let j = i + 1; j < times.length; j++) {
        const t1 = new Date(times[i].time);
        const t2 = new Date(times[j].time);
        const diffMinutes = Math.abs(t1 - t2) / 60000;

        const closeFlag = diffMinutes <= closeThreshold;
        const tag = closeFlag ? '⚡ **时间相近！**' : '';
        content += `- ${times[i].name} vs ${times[j].name}：时间差 **${Math.round(diffMinutes)}** 分钟 ${tag}\n`;
      }
    }

    content += `\n`;
  }

  content += `> 🤖 由 AI 自动生成\n`;

  return { title, content };
}
