# 项目长期记忆

## 服务器信息
- IP: 106.52.246.40 (腾讯云 Ubuntu 24.04 LTS)
- 用户: ubuntu（不是 root）
- 密码: Openclaw888@
- yadan-report 项目路径: /home/ubuntu/yadan/
- PM2 进程名: yadan-report
- A2UI Playground 路径: /var/www/a2ui/（Nginx 托管）

## 已知 API Bug
- MaxVision `queryIdentifyRecord` 接口：查询范围包含无数据日期时，该日期之后的所有记录丢失
- 解决方案：周数据改为按天单独查询再合并（见 src/weekly.js getPersonWeekRecords）

## 部署流程
1. 本地修改测试 → 验证通过 → scp 同步 src/ 下修改的文件 → pm2 restart yadan-report --update-env
2. 同步命令：`sshpass -e scp -o StrictHostKeyChecking=no <本地文件> ubuntu@106.52.246.40:/home/ubuntu/yadan/src/`
