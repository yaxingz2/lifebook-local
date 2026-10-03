# LifeBook 人生之书（本地版）

通过温和的 AI 语音访谈保存回忆，接续之前的话题，并整理带原话出处的书稿。**完全在你自己的电脑上运行，数据留在本机。**

> 项目仍在试用和改进中。自动测试验证程序行为；语音听感、停顿和打断需要真人麦克风体验。生成的书稿应由讲述者核对。

## 快速开始

需要 Node.js 24（版本记录在 `.nvmrc`）。

```sh
git clone https://github.com/yaxingz2/lifebook-local.git
cd lifebook-local
npm ci --ignore-scripts --no-audit --no-fund
npm start
```

打开终端显示的本机地址即可。**默认是演示模式，无需 API Key**，可以体验访谈流程、书稿整理、导出与备份。

## 启用真实 AI 与语音

在设置页填入你自己的千问 AI 平台 API Key（在 [千问 AI 平台](https://www.qianwen.com/) 的 API 控制台创建并开通模型权限）。

- 实时语音使用千问 Audio 3.0 Flash 的 WebRTC 路径；文字聊天和书稿整理使用千问文字模型。
- 启用后，相关语音和聊天内容会发送给该服务商，可能产生费用，请自行评估隐私和成本。
- 密钥保存在本机数据目录的单独文件中，不会写入书籍备份，也不应提交到 Git。

## 数据位置

默认存于用户目录下的 `~/LifeBook`，也可以指定：

```sh
LIFEBOOK_DATA_DIR="$PWD/local-data" npm start
```

数据目录包含书籍、聊天及密钥，**不要提交或上传**。本地服务只监听 `127.0.0.1`，没有登录，假定你的系统账号是可信的。

## 功能

- 语音开场、顺着具体故事追问；文字聊天可选。
- 保存会话、接续旧话题、纠正原话、避开不愿讨论的话题。
- 从有出处的聊天整理书稿，分批处理长资料，保留手工修改。
- 书架归档、导出，以及 JSON 备份和恢复。

尚未提供原始录音保存、原声回放或独立事实核查。

## 开发

```sh
npm test
node scripts/check-repository.mjs
```

欢迎提交小而清楚的 PR，说明用户行为变化和验证结果。**请勿提交真实录音、个人故事、密码或 API Key。**

设计说明见 [架构](docs/architecture.md) 和 [访谈策略](INTERVIEW_STRATEGY.md)。许可：[MIT](LICENSE)。[English](README.en.md)
