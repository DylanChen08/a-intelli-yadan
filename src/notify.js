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

/**
 * 生成饭堂同场检测表格
 * 从所有人员记录中筛出"总部八楼收银"设备记录，判断是否和吴雅丹同时在场
 * @param {Array} allResults - 所有人员的查询结果（核心+部门同事）
 * @returns {string} Markdown 格式的饭堂同场报告
 */
function buildCanteenTable(allResults) {
  const CANTEEN_KEYWORD = '总部八楼收银';
  const MATCH_THRESHOLD_MINUTES = 5;

  // 餐次时段定义
  const mealPeriods = [
    { label: '午餐', startHour: 10, endHour: 14 },
    { label: '晚餐', startHour: 17, endHour: 21 },
  ];

  let result = '';

  for (const period of mealPeriods) {
    // 收集该时段内每个人的收银打卡记录
    const personCanteen = {};
    let wuYadanRecord = null;

    for (const person of allResults) {
      const records = (person.allRecords || []).filter((r) => {
        const deviceName = r.deviceName || '';
        if (!deviceName.includes(CANTEEN_KEYWORD)) return false;
        const timeStr = r.identifyTime || '';
        const hour = parseInt(timeStr.split(' ')[1]?.split(':')[0], 10);
        return hour >= period.startHour && hour < period.endHour;
      });

      if (records.length > 0) {
        // 按时间排序，取最早的一条
        records.sort((a, b) => new Date(a.identifyTime) - new Date(b.identifyTime));
        personCanteen[person.name] = records[0];
        if (person.name === '吴雅丹') {
          wuYadanRecord = records[0];
        }
      }
    }

    // 吴雅丹没有该时段收银记录 → 跳过该餐次
    if (!wuYadanRecord) continue;

    const yadanTimestamp = new Date(wuYadanRecord.identifyTime).getTime();
    const yadanTimeStr = wuYadanRecord.identifyTime.split(' ')[1]; // HH:mm:ss

    let table = `🍽️ **饭堂同场记录（${period.label}）**\n\n`;
    table += `| 姓名 | 打卡时间 | 是否同场 |\n`;
    table += `|------|---------|----------|\n`;
    table += `| 吴雅丹 | ${yadanTimeStr} | - |\n`;

    // 其他人
    for (const person of allResults) {
      if (person.name === '吴雅丹') continue;
      const record = personCanteen[person.name];
      if (record) {
        const timeStr = record.identifyTime.split(' ')[1];
        const recordTimestamp = new Date(record.identifyTime).getTime();
        const diffMinutes = Math.abs(recordTimestamp - yadanTimestamp) / 60000;
        const diffStr = diffMinutes < 1 ? '不到1分钟' : `${Math.round(diffMinutes)}分钟`;
        if (diffMinutes <= MATCH_THRESHOLD_MINUTES) {
          table += `| ${person.name} | ${timeStr} | ✅ 是（差${diffStr}） |\n`;
        } else {
          table += `| ${person.name} | ${timeStr} | ❌ 否（差${diffStr}） |\n`;
        }
      } else {
        table += `| ${person.name} | - | ❌ 否 |\n`;
      }
    }

    result += table + '\n';
  }

  if (!result) {
    result = '🍽️ **饭堂同场记录**\n\n今日暂无总部八楼收银打卡记录\n\n';
  }

  return result;
}

/**
 * 生成下班时间对比表格
 * @param {Array} allResults - 所有人员的查询结果（核心+部门同事）
 * @returns {string} Markdown 格式的下班时间对比表格
 */
function buildComparisonTable(allResults) {
  let table = '📊 **下班时间对比**\n\n';
  table += '| 姓名 | 下班时间 | 备注 |\n';
  table += '|------|---------|------|\n';

  for (const person of allResults) {
    const name = person.name;
    const records = person.allRecords || [];
    const leaveInfo = person.leaveInfo;

    // 无打卡记录
    if (records.length === 0) {
      table += `| ${name} | - | ❌ 今日无打卡记录 |\n`;
      continue;
    }

    // 有打卡但没下班
    if (!leaveInfo) {
      table += `| ${name} | 仍在上班 | 🕐 |\n`;
      continue;
    }

    // 有下班记录
    const clockOutTime = leaveInfo.time.split(' ')[1]; // HH:mm:ss
    let note = '';

    // 加班提醒
    const hour = parseInt(clockOutTime.split(':')[0], 10);
    if (hour >= 20) {
      note = '⚠️ 加班较晚';
    } else if (hour >= 19) {
      note = '🌙 稍晚下班';
    }

    // 通行异常
    if (leaveInfo.passStatus !== '1') {
      note = note ? `${note} | ⚠️ 异常` : '⚠️ 通行异常';
    }

    table += `| ${name} | ${clockOutTime} | ${note} |\n`;
  }

  return table;
}

/**
 * 生成详细下班时间对比分析（文字描述版）
 * 以吴雅丹为基准，逐人与其他人对比，包含时间差、状态分析、加班提醒等
 * @param {Array} allResults - 所有人员的查询结果（核心+部门同事）
 * @returns {string} Markdown 格式的详细分析文字
 */
function buildComparisonAnalysis(allResults) {
  const wuYadan = allResults.find(p => p.name === '吴雅丹');
  const others = allResults.filter(p => p.name !== '吴雅丹');

  let text = '📝 **详细分析**\n\n';

  // 吴雅丹自身状态
  if (!wuYadan || (wuYadan.allRecords || []).length === 0) {
    text += '吴雅丹今日无打卡记录，暂无法进行对比分析。\n';
    return text;
  }

  if (!wuYadan.leaveInfo) {
    text += '吴雅丹仍在上班，暂未下班。以下为其他人员当前状态：\n\n';
    for (const person of others) {
      const records = person.allRecords || [];
      if (records.length === 0) {
        text += `- ${person.name}：今日无打卡记录\n`;
      } else if (!person.leaveInfo) {
        text += `- ${person.name}：仍在上班，和吴雅丹一样还没走\n`;
      } else {
        const t = person.leaveInfo.time.split(' ')[1];
        text += `- ${person.name}：已下班（${t}），比吴雅丹先走了\n`;
      }
    }
    return text;
  }

  // 吴雅丹已下班
  const yadanTime = wuYadan.leaveInfo.time;
  const yadanTs = new Date(yadanTime).getTime();
  const yadanHM = yadanTime.split(' ')[1];
  const yadanHour = parseInt(yadanHM.split(':')[0], 10);

  text += `吴雅丹今日 ${yadanHM} 下班。`;
  if (yadanHour >= 20) {
    text += '⚠️ 加班到比较晚，主人留意。';
  } else if (yadanHour >= 19) {
    text += '稍晚下班。';
  } else if (yadanHour >= 18) {
    text += '正常时间下班。';
  }
  text += '\n\n';

  // 逐人对比
  for (const person of others) {
    const records = person.allRecords || [];
    const name = person.name;

    if (records.length === 0) {
      text += `**${name}**：今日无任何打卡记录。\n\n`;
      continue;
    }

    if (!person.leaveInfo) {
      text += `**${name}**：仍在上班，暂无下班记录。`;
      text += '吴雅丹比此人先走了';
      if (yadanHour >= 20) {
        text += '，而此人还在加班中';
      }
      text += '。\n\n';
      continue;
    }

    const pTime = person.leaveInfo.time;
    const pTs = new Date(pTime).getTime();
    const pHM = pTime.split(' ')[1];
    const pHour = parseInt(pHM.split(':')[0], 10);
    const diffMinutes = Math.round(Math.abs(pTs - yadanTs) / 60000);

    const yadanFirst = yadanTs < pTs;
    const diffStr = diffMinutes < 1 ? '不到1分钟' : `${diffMinutes}分钟`;

    text += `**${name}**：${pHM} 下班。`;
    text += yadanFirst
      ? `吴雅丹比此人先走 ${diffStr}。`
      : `此人比吴雅丹先走 ${diffStr}。`;

    // 时间相近
    if (diffMinutes <= 10) {
      text += ' ⚡ 两人下班时间很接近。';
    }

    // 此人加班提醒
    if (pHour >= 20) {
      text += ' ⚠️ 此人加班到较晚，主人可关注。';
    }

    // 通行异常
    if (person.leaveInfo.passStatus !== '1') {
      text += ' ❗ 此人下班通行状态异常。';
    }

    text += '\n\n';
  }

  // 汇总
  const leftPersons = others.filter(p => p.leaveInfo);
  const stillWorking = others.filter(p => (p.allRecords || []).length > 0 && !p.leaveInfo);
  const noRecords = others.filter(p => (p.allRecords || []).length === 0);

  // 按下班时间排序
  const allWithLeave = [
    { name: '吴雅丹', ts: yadanTs, hm: yadanHM },
    ...leftPersons.map(p => ({
      name: p.name,
      ts: new Date(p.leaveInfo.time).getTime(),
      hm: p.leaveInfo.time.split(' ')[1],
    })),
  ].sort((a, b) => a.ts - b.ts);

  if (allWithLeave.length >= 2) {
    text += `**下班顺序**：${allWithLeave.map(a => `${a.name}（${a.hm}）`).join(' → ')}。`;
    text += `最早 ${allWithLeave[0].name}，最晚 ${allWithLeave[allWithLeave.length - 1].name}。`;
    if (allWithLeave.length > 2) {
      text += '\n\n';
      const totalTimeRange = Math.round((allWithLeave[allWithLeave.length - 1].ts - allWithLeave[0].ts) / 60000);
      text += `时间跨度 ${totalTimeRange} 分钟。`;
    }
  }

  if (stillWorking.length > 0) {
    text += '\n\n';
    text += `仍在加班：${stillWorking.map(p => p.name).join('、')}。`;
  }

  if (noRecords.length > 0) {
    text += '\n\n';
    text += `今日缺勤：${noRecords.map(p => p.name).join('、')}。`;
  }

  return text;
}

/**
 * 计算两个 HH:mm 时间相差的分钟数（time2 - time1）
 */
function timeDiffMinutes(time1, time2) {
  const [h1, m1] = time1.split(':').map(Number);
  const [h2, m2] = time2.split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}

/**
 * 格式化时间差为短格式（用于表格内联显示）
 * @param {number} minutes - 时间差（正值=晚于，负值=早于）
 * @returns {string} 如 "+5"、"-3"、"同时"
 */
function formatDiffShort(minutes) {
  if (minutes === 0) return '同时';
  return minutes > 0 ? `+${minutes}` : `${minutes}`;
}

/**
 * 格式化单人一格的上下班内容
 * @param {string|null} firstIn - 上班时间 HH:mm
 * @param {string|null} lastOut - 下班时间 HH:mm
 * @param {string|null} ydIn - 吴雅丹上班时间 HH:mm（null 表示本人就是吴雅丹）
 * @param {string|null} ydOut - 吴雅丹下班时间 HH:mm
 * @returns {string}
 */
function formatPersonCell(firstIn, lastOut, ydIn, ydOut) {
  if (!firstIn && !lastOut) return '缺勤';

  const parts = [];

  // 上班时间
  if (firstIn && ydIn) {
    const d = timeDiffMinutes(ydIn, firstIn);
    parts.push(`进${firstIn}(${formatDiffShort(d)})`);
  } else if (firstIn) {
    parts.push(`进${firstIn}`);
  } else {
    parts.push('进-');
  }

  // 下班时间
  if (lastOut && ydOut) {
    const d = timeDiffMinutes(ydOut, lastOut);
    parts.push(`出${lastOut}(${formatDiffShort(d)})`);
  } else if (lastOut) {
    parts.push(`出${lastOut}`);
  } else {
    parts.push('出-');
  }

  return parts.join(' ');
}

/**
 * 生成近一周上下班差异对比表格（以吴雅丹为基准）
 * 列出每个人每天的实际上班/下班时间，括号内标注与吴雅丹的时间差
 * @param {Array} weekData - [{ name, dailyTimes: [{ date, firstIn, lastOut }] }]
 * @returns {string} Markdown 表格
 */
function buildWeeklyComparison(weekData) {
  if (!weekData || weekData.length === 0) return '';

  const wuYadan = weekData.find(p => p.name === '吴雅丹');
  if (!wuYadan || !wuYadan.dailyTimes || wuYadan.dailyTimes.length === 0) return '';

  const others = weekData.filter(p => p.name !== '吴雅丹');
  const dailyTimes = wuYadan.dailyTimes;

  let text = '📅 **近一周上下班差异对比（以吴雅丹为基准）**\n\n';

  // 表头
  text += '| 日期 | 吴雅丹 |';
  for (const p of others) text += ` ${p.name} |`;
  text += '\n';

  // 分隔线
  text += '|------|--------|';
  for (const p of others) text += '---------|';
  text += '\n';

  // 每一天
  for (let i = 0; i < dailyTimes.length; i++) {
    const yd = dailyTimes[i];
    const dateLabel = yd.date.substring(5); // MM-DD

    // 吴雅丹这一格：不显示差异，纯时间
    text += `| ${dateLabel} | ${formatPersonCell(yd.firstIn, yd.lastOut, null, null)} |`;

    // 其他人：显示实际时间 + 与吴雅丹的差异
    for (const p of others) {
      const pd = (p.dailyTimes || [])[i];
      if (!pd || (!pd.firstIn && !pd.lastOut)) {
        text += ' 缺勤 |';
      } else {
        text += ` ${formatPersonCell(pd.firstIn, pd.lastOut, yd.firstIn, yd.lastOut)} |`;
      }
    }

    text += '\n';
  }

  text += '\n> 括号内为与吴雅丹的时间差（分钟），+晚于、-早于\n';
  return text;
}

export function buildSmartReport(personResults, allResults, weekData = null) {
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

  // 周对比部分
  const weekPart = weekData ? `${buildWeeklyComparison(weekData)}---\n\n` : '';

  const content = `${tablePart}${buildCanteenTable(allResults)}---\n\n${buildComparisonTable(allResults)}\n\n---\n\n${buildComparisonAnalysis(allResults)}\n\n---\n\n${weekPart}> 🤖 智能日报 | ${dateStr} 周${weekDay}`;

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
