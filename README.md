<p align="center">
  <img src="assets/hero.svg" width="100%" alt="auto-vision" />
</p>

<h1 align="center">auto-vision</h1>

<p align="center">
  贴图不会让对话报错，图片在<b>聊天窗口里正常显示</b>；
  <br/>
  模型<b>自动判断</b>是否需要看图，需要时自己调用视觉模型读取内容 ——
  <b>免费</b>，支持智谱 / 魔搭社区的免费视觉模型，也支持你自己的任意 OpenAI 兼容平台。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-34D399?style=flat" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%3E%3D18-9CA3AF?style=flat" alt="Node >= 18"/>
</p>

---

## 演示

![](assets/demo.mp4)

## 安装

1. 把本目录拷到 DSH profile 的 `node_modules` 下（如 `~/.dsh/profiles/web/node_modules/auto-vision/`）。
2. 在 profile 的 `cordis.patch.yml` 中插入：

   ```yaml
   - insert:
       - id: auto-vision
         name: auto-vision
   ```

3. 配置 Token（见下），重启 DSH 进程。

## 配置 Token

| 视觉平台 | 环境变量 | 免费模型 |
| --- | --- | --- |
| 智谱 BigModel | `ZHIPU_API_KEY` | GLM-4V-Flash（免费） |
| 魔搭 ModelScope | `MODELSCOPE_API_KEY` | Qwen3-VL（免费额度） |
| 其他任意 OpenAI 兼容平台 | `VISION_API_KEY` + `VISION_ENDPOINT` + `VISION_MODEL` | 你平台的模型 |

也可以把 Token 写进 `~/.dsh/.credentials.yaml`（同名键），效果一样。

```bash
export ZHIPU_API_KEY=xxx          # 用智谱
export MODELSCOPE_API_KEY=xxx     # 用魔搭
```

## 切换视觉源

默认魔搭；想用智谱免费档，二选一：

```bash
export VISION_PROVIDER=zhipu      # 环境变量方式
```

```yaml
# 或写在插件 config 里
- id: auto-vision
  name: auto-vision
  config:
    provider: zhipu
```

自己的平台（例如本地 Ollama）直接指定端点：

```yaml
  config:
    endpoint: http://127.0.0.1:11434/v1/chat/completions
    models: [qwen2.5-vl:7b]
```

## License

[MIT](LICENSE) · [Changelog](CHANGELOG.md)
