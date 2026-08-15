<p align="center">
  <img src="assets/hero.svg" width="100%" alt="auto-vision — 粘贴即对话 · 图片不进模型 · 需要时自己看图" />
</p>

<h1 align="center">auto-vision</h1>

<p align="center">
  DeepSeek Harness 图片插件：粘贴的图片<b>不会让对话报错</b>（图片块不进模型请求），
  <br/>
  模型需要看图时自动调用 <code>see_image</code> 工具 ——
  <b>支持智谱 / 魔搭社区的免费视觉模型</b>，一键切换，无需额外费用。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-34D399?style=flat" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%3E%3D18-9CA3AF?style=flat" alt="Node >= 18"/>
  <img src="https://img.shields.io/badge/视觉源-智谱%20%7C%20魔搭%20免费-60A5FA?style=flat" alt="free vision"/>
</p>

---

## 为什么需要

DeepSeek 官方 API 不收图：请求里一旦出现图片（`image_url`），上游直接拒绝**整条**请求，而且**历史里有图后，之后每一条消息都会报错**：

```
unknown variant `image_url`, expected `text`
```

auto-vision 解决这个问题：图片只留在你的气泡里，**绝不进入模型请求**；模型需要了解图片内容时，自动调用 `see_image` 工具，用视觉模型读出文字描述。

## 特性

- 🧹 **自动清洗**：发往模型的请求里所有图片块 → 一句文字说明；只改请求副本，气泡原图照常显示。
- 👁️ **see_image 看图工具**：模型按需调用，自动定位最近粘贴的图片，返回图片内容的文字描述。
- 🆓 **免费视觉源，开箱即用**：
  - **魔搭社区**（默认）：Qwen3-VL，配 `MODELSCOPE_API_KEY` 即可（免费额度）
  - **智谱 BigModel**：GLM-4V-Flash（免费），配 `ZHIPU_API_KEY`，一行切换
- 📐 **超限自动缩放**：大图超过视觉 API 上限时自动按比例缩小再发送。
- 🔌 **单包零依赖**：不需要 Python、不需要额外服务；不想看图时 `tool: false` 关掉即可，清洗照常。

## 安装

```bash
# 1. 拷贝到 DSH profile 的 node_modules（或 npm install / dsh plugin add）
# 2. 在 profile 的 cordis.patch.yml 中插入：
```

```yaml
- insert:
    - id: auto-vision
      name: auto-vision
```

```bash
# 3. 配置视觉 API Key（二选一，或都配）
export MODELSCOPE_API_KEY=xxx    # 魔搭（默认）
export ZHIPU_API_KEY=xxx         # 智谱
# 也可以写入 ~/.dsh/.credentials.yaml 同名键

# 4. 重启 DSH 进程
```

## 免费视觉源切换

| 视觉源 | 切换方式 | 免费模型 | Key |
| --- | --- | --- | --- |
| 魔搭社区（默认） | 无需配置 | Qwen3-VL-235B / 8B | `MODELSCOPE_API_KEY` |
| 智谱 BigModel | `VISION_PROVIDER=zhipu` | GLM-4V-Flash | `ZHIPU_API_KEY` |

或写进插件 config：

```yaml
- id: auto-vision
  name: auto-vision
  config:
    provider: zhipu
```

想用自己的视觉 API（比如本地 Ollama）也可以，`endpoint` / `models` 直接覆盖即可：

```yaml
  config:
    endpoint: http://127.0.0.1:11434/v1/chat/completions
    models: [qwen2.5-vl:7b]
```

## 配置一览

优先级：**插件 config > 环境变量 > 默认值**。

| 配置键           | config 字段       | 环境变量                 | 默认值 |
| ---------------- | ----------------- | ------------------------ | ------ |
| 视觉源预设       | `provider`        | `VISION_PROVIDER`        | `modelscope`（`zhipu` 可切智谱） |
| 看图工具开关     | `tool`            | `VISION_TOOL`(0/false)   | `true` |
| API 地址         | `endpoint`        | `VISION_ENDPOINT`        | 随预设（魔搭/智谱） |
| 模型列表         | `models`          | `VISION_MODEL`（单个）   | 随预设 |
| 最大输出 token   | `maxTokens`       | `VISION_MAX_TOKENS`      | `1500` |
| 图片大小上限     | `maxFileBytes`    | `VISION_MAX_FILE_BYTES`  | `10MB` |
| 最长边长上限     | `maxDimension`    | `VISION_MAX_DIMENSION`   | `2048` |
| 缩放命令模板     | `preprocessCommand` | —                      | macOS `sips`（可换 ffmpeg/ImageMagick） |
| 请求超时         | `timeoutMs`       | `VISION_TIMEOUT_MS`      | `60000` |
| API Key          | `apiKey`          | 见上文                   | 无 |
| 占位说明文本     | `note`            | `AUTO_VISION_NOTE`       | 内置中文说明 |

> Windows / Linux 没有 `sips`：把 `preprocessCommand` 换成 ffmpeg
> （`['ffmpeg','-y','-i','{input}','-vf','scale={width}:{height}','{output}']`）
> 或 ImageMagick 即可。

## see_image 工具（模型视角）

- `file_path`：图片路径，可省略（自动用最近一张粘贴图）
- `question`：想从图中获取的信息，可省略
- `model`：视觉模型 ID 或 `heavy`（InternVL 高端），可省略

## 开发

```bash
npm install && npm test   # 11 项自包含单元测试
```

## License

[MIT](LICENSE) · [Changelog](CHANGELOG.md)
