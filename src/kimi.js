import axios from 'axios';

const KIMI_API_BASE = 'https://api.moonshot.cn/v1';

/**
 * Kimi 大模型调用模块
 * 负责将通行记录数据发送给 Kimi，生成智能日报
 */

const SYSTEM_PROMPT = `你是主人的私人智能管家，负责分析通行记录，向主人汇报今日打卡情况的对比分析。

身份设定：
- 你称呼接收报告的人为"主人"
- 你是忠诚可靠、观察细致的管家
- 报告对象是主人本人，不是被监控的人

你的任务：
只负责生成对比分析部分，不需要生成表格或打卡记录（表格由系统自动生成）。

输出格式要求：
1. 开头标题："📊 吴雅丹 vs 黄治富 对比"
2. 用纯文字描述两人的打卡情况对比
3. 包括：谁先到、谁先走、工作时间差异、下班时间差几分钟等
4. 不要用表格，纯文字描述
5. 查到几个人就如实说几个人，绝对不要用"大家""你们""所有人"这类词
6. 如果有人加班较晚（20:00以后下班），提醒主人关注
7. 如果有人当天没有任何打卡记录，明确报告
8. 如果有通行异常的记录，明确标注
9. 适当使用 emoji，保持专业
10. 收尾简短，一两句话即可
11. 不要输出"主人，今日汇报如下"等开头语，直接从标题开始
12. 不要输出分隔线"---"

注意：
- 你是在向主人汇报，不是在对被监控的人说话
- 整体保持简短精炼，不要啰嗦
- 只输出对比分析内容，不要包含打卡记录表格

数据格式说明：
- identifyTime: 通行时间
- deviceName: 设备名称（包含"出"的是出门/下班记录，包含"进"的是进门/上班记录）
- similarity: 人脸识别相似度
- passStatus: "1" 表示正常通行
- photoUrl: 抓拍图片的完整 URL（如果有）`;

/**
 * 调用 Kimi API 生成智能日报
 * @param {string} apiKey - Moonshot API Key
 * @param {string} model - 模型名称（默认 moonshot-v1-8k）
 * @param {Array} personResults - 人员通行记录查询结果
 * @returns {Promise<string>} AI 生成的 Markdown 报告内容
 */
export async function generateSmartReport(apiKey, personResults, model = 'moonshot-v1-8k') {
  if (!apiKey) {
    throw new Error('未配置 KIMI_API_KEY');
  }

  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekDay = weekDays[now.getDay()];
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // 构建用户消息：传入结构化数据
  const dataDescription = personResults.map((person) => {
    const lines = [`## ${person.name}`];
    lines.push(`- 身份ID: ${person.personId}`);
    lines.push(`- 今日通行记录数: ${person.allRecords?.length || 0}`);
    lines.push(`- 出门记录数: ${person.leaveCount}`);

    if (person.leaveInfo) {
      lines.push(`- 最近下班时间: ${person.leaveInfo.time}`);
      lines.push(`- 出口位置: ${person.leaveInfo.location || '未知'}`);
      lines.push(`- 通行状态: ${person.leaveInfo.passStatus ? '正常' : '异常'}`);
      if (person.leaveInfo.photoUrl) {
        lines.push(`- 抓拍图片: ${person.leaveInfo.photoUrl}`);
      }
    } else {
      lines.push(`- 下班状态: 今天还没有下班打卡记录`);
    }

    // 附加所有通行记录的详细信息，每条都带 photoUrl
    if (person.allRecords && person.allRecords.length > 0) {
      lines.push(`- 所有通行记录（按时间）:`);
      for (const record of person.allRecords) {
        const photoUrl = record.photoUrl || '无';
        const direction = (record.deviceName || '').includes('出') ? '出门' : '进门';
        lines.push(`    - 时间:${record.identifyTime} | 方向:${direction} | 设备:${record.deviceName || '未知'} | 相似度:${record.similarity || '-'} | 状态:${record.passStatus === '1' ? '正常' : '异常'} | 抓拍照片:${photoUrl}`);
      }
    }

    return lines.join('\n');
  }).join('\n\n');

  const userMessage = `请根据以下通行记录数据，生成一份今日（${dateStr} 周${weekDay}，当前时间 ${currentTime}）的下班日报：

${dataDescription}

请直接输出 Markdown 格式的日报内容，不要加额外的解释说明。`;

  console.log('[Kimi] 正在调用 Kimi 生成智能日报...');

  try {
    const response = await axios.post(
      `${KIMI_API_BASE}/chat/completions`,
      {
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 1024,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 30000,
      }
    );

    const { choices } = response.data;
    if (choices && choices.length > 0) {
      let content = choices[0].message?.content?.trim();
      if (content) {
        // 去掉 Kimi 可能返回的 markdown 代码块包裹（首尾和中间的残留）
        content = content.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*/g, '').trim();
        console.log(`[Kimi] 生成成功 (${content.length} 字符)`);
        // 统计 token 用量
        const usage = response.data.usage;
        if (usage) {
          console.log(`[Kimi] Token 用量: 输入=${usage.prompt_tokens}, 输出=${usage.completion_tokens}, 总计=${usage.total_tokens}`);
        }
        return content;
      }
    }

    throw new Error('Kimi 返回了空内容');
  } catch (err) {
    if (err.response) {
      console.error(`[Kimi] API 调用失败: HTTP ${err.response.status}`, err.response.data);
    } else {
      console.error('[Kimi] API 调用失败:', err.message);
    }
    throw err;
  }
}

/**
 * 检查 Kimi API Key 是否有效
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
export async function checkKimiApiKey(apiKey) {
  if (!apiKey) return false;
  try {
    const response = await axios.get(`${KIMI_API_BASE}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 10000,
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
