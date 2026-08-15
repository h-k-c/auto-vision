# Changelog

## [1.0.0] - 2026-08-15

### 初始发布

- **图片清洗（核心）**：`llm/stream` 瀑布最前面把发往模型的请求副本里所有
  image 块（含 tool-result 嵌套）替换为文字说明，解决纯文本上游
  （如 opencode-go / "Console Go"）收到 `image_url` 导致整条请求 400 的问题；
  只改请求副本、不改会话，气泡里的图片原样保留。
- **最近图片路径记录**：`agent/pre-step` 记录最近粘贴图片的本地路径
  （共享槽 `globalThis.__dshVisionLatest`），供 `see_image` 工具兜底。
- **see_image 看图工具**：调用任意 OpenAI chat/completions 兼容的视觉模型 API
  返回图片文字描述；超限图片自动按比例缩放（默认 macOS `sips`，可通过
  `preprocessCommand` 换成 ffmpeg/ImageMagick）；429/限流自动降级到备用模型。
- **内置免费视觉源预设**：`provider: zhipu | modelscope`（或 `VISION_PROVIDER`）
  一键切换智谱 GLM-4V-Flash / 魔搭 Qwen3-VL 免费档，也支持 `endpoint`/`models`
  完全自定义（如本地 Ollama）。
- **配置化**：插件 config > 环境变量 > 默认值三级配置，视觉源不绑定厂商。
- **测试**：`npm test` 自包含单元测试（11 项，mock 网络与图片，不依赖运行时）。
