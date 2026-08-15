# auto-vision

DSH（DeepSeek Harness）**单插件**图片一体化方案：粘贴的图片**进得了对话、
进不了模型请求**，模型需要时还能**按需看图**。

> 原 zhipu-vision（see_image 工具）已并入本插件。现在只装这一个即可，
> 无需再装两个。

## 解决的问题

DeepSeek 官方 API（例如本部署的 opencode-go / "Console Go" 上游）是纯文本的：
messages 内容枚举只有 `text`。一旦请求里出现 image 块（会被序列化成
`image_url`），上游直接拒绝**整条**请求：

```
unknown variant `image_url`, expected `text`
```

且历史里只要有图，之后每一条消息都会跟着报错。

## 能力

1. **清洗（核心，始终生效）**：`llm/stream` 瀑布最前面把发往模型的请求副本里
   所有 image 块（含 tool-result 嵌套）替换成一句文字说明，然后重新派发。
   只改请求副本、不改会话——气泡里的图片原样保留。没有看图工具时，文本模型
   也能正常继续对话。
2. **记录**：`agent/pre-step` 把最近粘贴图片的本地路径记入
   `globalThis.__dshVisionLatest`，供 `see_image` 在模型没给 / 给错路径时兜底。
3. **看图（默认开启，可关）**：注册 `see_image` 工具——读本地图片 → base64 →
   调用任意 OpenAI chat/completions 兼容的**视觉模型 API** → 返回图片的文字
   描述。模型在对话中需要看图时自行调用。

> 为什么"重新派发"而不是就地替换：`llm/stream` 的 waterfall 无法替换 payload
> （`next` 只透传原对象，且请求对象被 `deepFreeze`），所以采用"不调用 next、
> 用清洗后的请求重新走一遍 `llm.stream`"；清洗后的请求不再含 image 块，只会
> 重入一次，不会死循环。

## 安装

方式一（npm，推荐）：

```bash
npm install auto-vision
# 然后拷到 DSH profile 的 node_modules 下，或在 profile 里以本地依赖方式引用
```

方式二（直接拷贝）：把本目录拷到你的 DSH profile 的 `node_modules` 下
（例如 `~/.dsh/profiles/web/node_modules/auto-vision/`）。

然后（两种方式都需要）在 profile 的 `cordis.patch.yml`（或等价组合文件）中插入：

```yaml
- insert:
    - id: auto-vision
      name: auto-vision
```

最后：

1. 配置视觉 API Key（需要看图时）：环境变量 `VISION_API_KEY` /
   `MODELSCOPE_API_KEY` / `ZHIPU_API_KEY`，或写入 `~/.dsh/.credentials.yaml`
   的同名键。
2. 重启 DSH 进程。

## 平台说明

- **macOS**：开箱即用（默认用系统自带 `sips` 缩放超限图片）。
- **Windows / Linux**：`sips` 不存在。缩放会失败并给出明确报错，此时请把
  `preprocessCommand` 配置为平台可用的缩放命令，例如：
  - ffmpeg：`['ffmpeg', '-y', '-i', '{input}', '-vf', 'scale={width}:{height}', '{output}']`
  - ImageMagick：`['magick', '{input}', '-resize', '{width}x{height}', '{output}']`
- 不需要看图（`tool: false`）时，无需任何视觉 API Key 与缩放工具，清洗功能
  照常工作。

## 配置

优先级：**插件 config > 环境变量 > 默认值**。

| 配置键           | config 字段       | 环境变量                 | 默认值 |
| ---------------- | ----------------- | ------------------------ | ------ |
| 看图工具开关     | `tool`            | `VISION_TOOL`(0/false)   | `true` |
| API 地址         | `endpoint`        | `VISION_ENDPOINT`        | `https://api-inference.modelscope.cn/v1/chat/completions` |
| 模型列表         | `models`          | `VISION_MODEL`（单个）   | `[Qwen/Qwen3-VL-235B-A22B-Instruct, Qwen/Qwen3-VL-8B-Instruct]` |
| 高端模型别名     | `heavyModels`     | —                        | `{heavy: OpenGVLab/InternVL3_5-241B-A28B, internvl: 同}` |
| 最大输出 token   | `maxTokens`       | `VISION_MAX_TOKENS`      | `1500` |
| 图片大小上限     | `maxFileBytes`    | `VISION_MAX_FILE_BYTES`  | `10485760`（10MB） |
| 最长边长上限     | `maxDimension`    | `VISION_MAX_DIMENSION`   | `2048` |
| 缩放命令模板     | `preprocessCommand` | —                      | `['sips','-z','{height}','{width}','{input}','--out','{output}']` |
| 请求超时         | `timeoutMs`       | `VISION_TIMEOUT_MS`      | `60000` |
| API Key          | `apiKey`          | 见上文                   | 无 |
| 占位说明文本     | `note`            | `AUTO_VISION_NOTE`       | 内置中文说明 |
| 路径槽容量       | `maxLatestPaths`  | —                        | `20` |

config 示例（换本地 Ollama 只改配置，不改代码）：

```yaml
- id: auto-vision
  name: auto-vision
  config:
    endpoint: http://127.0.0.1:11434/v1/chat/completions
    models: [qwen2.5-vl:7b]
    tool: true
```

## see_image 工具参数（模型视角）

- `file_path`（可省略）：图片绝对路径；省略时自动采用最近一张粘贴图。
- `question`（可省略）：想从图中提取的具体信息。
- `model`（可省略）：视觉模型 ID，或 `heavy` / `internvl` 高端别名。

## 依赖的 DSH 约定

- 服务：`llm`（核心，必选）；`tools`（可选——缺席时看图工具不注册，
  清洗与记录照常工作）。
- 附件存储位置：`<DSH_HOME 或 ~/.dsh>/attachments/v1/objects/<hex[:2]>/<hex>`
  （DSH 内容寻址附件存储标准）。
