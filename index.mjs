// ============================================================================
// auto-vision —— 图片一体化插件（清洗 + 路径记录 + see_image 看图工具）
//
// 单插件完成原本两个插件（auto-vision + zhipu-vision）的全部工作：
//
//   1. 清洗（核心）：llm/stream 瀑布最前面把发往模型的请求 messages 副本里
//      所有 image 块替换成一句文字说明。背景：DeepSeek 官方 API（本部署的
//      opencode-go / "Console Go" 上游）不收图，上游 messages 内容枚举只有
//      text，image 块一旦被序列化成 image_url 就会让整条请求 400
//      （unknown variant `image_url`, expected `text`），且历史里只要有图，
//      之后每一条消息都会跟着报错。清洗只改请求副本、不改会话 —— 气泡里的
//      图片原样保留。
//   2. 记录：agent/pre-step 把最近粘贴图片的本地路径记入
//      globalThis.__dshVisionLatest（内部契约，无跨插件依赖），供 see_image
//      工具在模型没给 / 给错路径时兜底。
//   3. 看图：注册 see_image 工具，读本地图片 -> base64 -> 调用任意 OpenAI
//      chat/completions 兼容的视觉模型 API -> 返回图片的文字描述。模型在
//      对话中需要看图时自行调用（可通过配置关闭）。图片边长超过视觉 API
//      上限（maxDimension）时，先用系统工具按比例缩放再发送（默认 macOS
//      自带 sips，可通过 preprocessCommand 换成 ffmpeg/ImageMagick 等）。
//
// 独立性：单插件、零外部依赖（tools/llm 均为 DSH 核心服务）。视觉源完全可配
// 置，不绑定厂商；没有 tools 服务或配置 tool:false 时，清洗与记录照常工作，
// 只是不注册看图工具。
//
// 配置（优先级：插件 config > 环境变量 > 默认值）：
//   键              config 字段      环境变量                默认值
//   看图工具开关    tool             VISION_TOOL(0/false)    true
//   API 地址        endpoint         VISION_ENDPOINT        魔搭 api-inference
//   模型列表        models           VISION_MODEL(单个)     [Qwen3-VL-235B, Qwen3-VL-8B]
//   高端模型别名    heavyModels      -                      {heavy/internvl: InternVL3.5-241B}
//   最大输出 token  maxTokens        VISION_MAX_TOKENS      1500
//   图片大小上限    maxFileBytes     VISION_MAX_FILE_BYTES  10MB
//   最长边长上限    maxDimension     VISION_MAX_DIMENSION   2048
//   缩放命令模板    preprocessCommand -                     ['sips','-z','{height}','{width}','{input}','--out','{output}']
//   请求超时        timeoutMs        VISION_TIMEOUT_MS      60s
//   API Key         apiKey           VISION_API_KEY/MODELSCOPE_API_KEY/ZHIPU_API_KEY
//                                    或 ~/.dsh/.credentials.yaml 同名键
//   占位说明文本    note             AUTO_VISION_NOTE      内置中文说明
//   路径槽容量      maxLatestPaths   -                     20
//
// cordis.yml 配置示例（换本地 Ollama 只改配置，不改代码）：
//   - id: auto-vision
//     name: auto-vision
//     config:
//       endpoint: http://127.0.0.1:11434/v1/chat/completions
//       models: [qwen2.5-vl:7b]
//       tool: true
// ============================================================================

import { readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as yaml from 'js-yaml';
import { defineTool } from '@deepseek-ai/dsh-tools';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({
  tool: true,
  endpoint: 'https://api-inference.modelscope.cn/v1/chat/completions',
  models: ['Qwen/Qwen3-VL-235B-A22B-Instruct', 'Qwen/Qwen3-VL-8B-Instruct'],
  heavyModels: Object.freeze({
    heavy: 'OpenGVLab/InternVL3_5-241B-A28B',
    internvl: 'OpenGVLab/InternVL3_5-241B-A28B',
  }),
  maxTokens: 1500,
  maxFileBytes: 10 * 1024 * 1024, // 10MB
  maxDimension: 2048, // 视觉 API 的最长边长上限，超限先缩放
  timeoutMs: 60_000,
  apiKey: '',
  note: '[图片] 用户粘贴了一张图片，图片本体不会直接发送给模型，路径已由 auto-vision 记录；如需了解图片内容，请调用 see_image 工具。',
  maxLatestPaths: 20,
  // 缩放命令模板（占位符：{input} {output} {width} {height}）。
  // 默认 macOS 自带 sips；其他平台可换成 ffmpeg / ImageMagick / Windows 工具。
  preprocessCommand: ['sips', '-z', '{height}', '{width}', '{input}', '--out', '{output}'],
});

/** 环境变量名 -> 配置键的映射（数值型键在读取时做校验）。 */
const ENV_MAP = {
  endpoint: 'VISION_ENDPOINT',
  maxTokens: 'VISION_MAX_TOKENS',
  maxFileBytes: 'VISION_MAX_FILE_BYTES',
  maxDimension: 'VISION_MAX_DIMENSION',
  timeoutMs: 'VISION_TIMEOUT_MS',
};

/** API Key 的候选来源顺序：插件配置 -> 环境变量 -> DSH 凭证文件。 */
const API_KEY_ENVS = ['VISION_API_KEY', 'MODELSCOPE_API_KEY', 'ZHIPU_API_KEY'];
const CREDENTIAL_FILE_KEYS = ['MODELSCOPE_API_KEY', 'ZHIPU_API_KEY'];

/** "最近粘贴图片路径"共享槽（内部契约，供 see_image 兜底）。 */
const LATEST_SLOT = '__dshVisionLatest';

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function readEnv(name) {
  return typeof process !== 'undefined' && process.env ? (process.env[name] || '') : '';
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

/** DSH 数据目录：$DSH_HOME 或 ~/.dsh（DSH 生态标准约定）。 */
function dshHome() {
  return readEnv('DSH_HOME') || join(homedir(), '.dsh');
}

/** 合并插件 config（apply 第二参）与环境变量覆盖，产出最终配置。 */
function resolveConfig(config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) };
  for (const [key, env] of Object.entries(ENV_MAP)) {
    const raw = readEnv(env);
    if (!raw) continue;
    if (key === 'endpoint') cfg.endpoint = raw;
    else {
      const num = Number(raw);
      if (Number.isFinite(num) && num > 0) cfg[key] = num;
    }
  }
  const singleModel = readEnv('VISION_MODEL').trim();
  if (singleModel) cfg.models = [singleModel];
  const toolFlag = readEnv('VISION_TOOL').trim().toLowerCase();
  if (toolFlag) cfg.tool = toolFlag !== '0' && toolFlag !== 'false' && toolFlag !== 'no';
  return cfg;
}

/** 解析 API Key：配置 -> 环境变量 -> ~/.dsh/.credentials.yaml。 */
function resolveApiKey(config) {
  if (typeof config.apiKey === 'string' && config.apiKey) return config.apiKey;
  for (const name of API_KEY_ENVS) {
    const value = readEnv(name);
    if (value) return value;
  }
  const file = join(dshHome(), '.credentials.yaml');
  if (!existsSync(file)) return undefined;
  try {
    const doc = yaml.load(readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object') return undefined;
    for (const key of CREDENTIAL_FILE_KEYS) {
      if (typeof doc[key] === 'string' && doc[key]) return doc[key];
    }
  } catch {
    /* 凭证文件损坏时按"无 Key"处理，请求会得到上游 401 并如实上报 */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 最近图片路径记录
// ---------------------------------------------------------------------------

function latestSlot() {
  if (typeof globalThis === 'undefined') return null;
  globalThis[LATEST_SLOT] ??= { paths: [] };
  return globalThis[LATEST_SLOT];
}

/** 追加/刷新最近图片路径：已存在的移到末尾（保持"最近"语义），超容量丢最旧。 */
function recordLatestPaths(found, cap) {
  if (!found || !found.length) return;
  const slot = latestSlot();
  if (!slot) return;
  for (const path of found) {
    const index = slot.paths.indexOf(path);
    if (index >= 0) slot.paths.splice(index, 1);
    slot.paths.push(path);
    if (slot.paths.length > cap) slot.paths.shift();
  }
}

/**
* 从 attachment ref 推导本地附件文件路径（DSH 内容寻址存储）。
* <DSH_HOME 或 ~/.dsh>/attachments/v1/objects/<hex[:2]>/<hex>
*/
function imagePathFromRef(att) {
  const id = att && (att.attachmentId || att.id);
  if (typeof id !== 'string') return undefined;
  const hex = id.startsWith('sha256:') ? id.slice(7) : id;
  if (!/^[a-f0-9]{64}$/i.test(hex)) return undefined;
  return join(dshHome(), 'attachments', 'v1', 'objects', hex.slice(0, 2), hex);
}

/** 收集一组 content blocks 里的图片本地路径（仅存在的文件）。 */
function collectImagePaths(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (block && block.type === 'image' && block.attachment) {
      const path = imagePathFromRef(block.attachment);
      if (path && existsSync(path)) out.push(path);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 请求清洗：image 块 -> 文字说明
// ---------------------------------------------------------------------------

/** 内容（blocks 数组）里是否含 image 块（含 tool-result 嵌套）。 */
function contentHasImageBlocks(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && (
    block.type === 'image' ||
    (block.type === 'tool-result' && Array.isArray(block.content) && contentHasImageBlocks(block.content))
  ));
}

/** 把 blocks 里的 image 块替换为文字说明（递归进 tool-result），并收集图片路径。 */
function replaceImageBlocks(blocks, note, collected) {
  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') { out.push(block); continue; }
    if (block.type === 'image') {
      const path = imagePathFromRef(block.attachment);
      if (path && existsSync(path)) collected.push(path);
      out.push({ type: 'text', text: note });
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      out.push({ ...block, content: replaceImageBlocks(block.content, note, collected) });
    } else {
      out.push(block);
    }
  }
  return out;
}

/**
* 构造"发往模型"的 messages 副本：image 块 -> 文字说明。
* 无图时返回 null（表示无需清洗）；有图时返回新的消息数组，原消息不动。
*/
function sanitizeMessages(messages, note, maxLatestPaths) {
  if (!Array.isArray(messages)) return null;
  let changed = false;
  const collected = [];
  const out = [];
  for (const msg of messages) {
    if (msg && Array.isArray(msg.content) && contentHasImageBlocks(msg.content)) {
      out.push({ ...msg, content: replaceImageBlocks(msg.content, note, collected) });
      changed = true;
    } else {
      out.push(msg);
    }
  }
  recordLatestPaths(collected, maxLatestPaths);
  return changed ? out : null;
}

// ---------------------------------------------------------------------------
// 视觉 API 调用（see_image 工具后端）
// ---------------------------------------------------------------------------

function mimeFromPath(path) {
  const base = path.split('?')[0].toLowerCase();
  if (base.endsWith('.png')) return 'image/png';
  if (base.endsWith('.jpg') || base.endsWith('.jpeg')) return 'image/jpeg';
  if (base.endsWith('.webp')) return 'image/webp';
  if (base.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

/** 显式模型 ID 或高端别名 -> 实际模型列表；未指定时用配置的默认列表。 */
function resolveModels(config, modelArg) {
  const arg = modelArg && modelArg.trim();
  if (arg) {
    const alias = config.heavyModels[arg];
    return [alias || arg];
  }
  return [...config.models];
}

/** 调用一次视觉模型 API，返回 { status, raw }（HTTP 层错误直接抛出）。 */
async function callVisionApi(config, model, key, base64, mime, prompt) {
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        { type: 'text', text: prompt },
      ],
    }],
    max_tokens: config.maxTokens,
    stream: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  return { status: res.status, raw: await res.text() };
}

/** 从上游响应里提取错误详情（尽力而为）。 */
function extractErrorDetail(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
  } catch {
    /* 非 JSON 响应，原样返回 */
  }
  return raw;
}

/** 解析成功响应的文本内容；拿不到文字时返回空字符串。 */
function extractDescription(raw) {
  try {
    const parsed = JSON.parse(raw);
    const content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

/** 构造发给视觉模型的提问（用户给了问题就用问题，否则做通用提取）。 */
function buildPrompt(question) {
  const q = question && question.trim();
  return q
    ? `请根据用户的问题，只从这张图片中提取回答所需的信息（文字/代码/结构/位置等），简洁准确：\n\n${q}`
    : '请把这张图片中的文字、代码、数字、UI结构逐字提取并做简要说明。';
}

/**
* 从图片文件头解析宽高与格式（PNG/JPEG/GIF/WebP），未知格式返回 undefined。
* 不引入解码依赖，只读文件头。格式用于推断缩放输出扩展名与 Content-Type
* （附件文件本身可能没有扩展名，不能依赖文件名）。
*/
function readImageDimensions(buf) {
  if (!buf || buf.length < 24) return undefined;
  // PNG：签名 8 字节 + IHDR，宽高在 16/20 处（大端）
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }
  // GIF：宽高在 6/8 处（小端）
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
  }
  // WebP：RIFF....WEBP 后按块类型解析
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), format: 'webp' };
    }
    if (kind === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
    }
    if (kind === 'VP8L') {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        format: 'webp',
      };
    }
  }
  // JPEG：扫描 SOF 标记（C0-CF，排除 C4/C8/CC），宽高在标记内
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7), format: 'jpeg' };
    }
    offset += 2 + length;
  }
  return undefined;
}

/** 图片格式 -> Content-Type（读不到格式时的兜底）。 */
const MIME_BY_FORMAT = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const execFileAsync = promisify(execFile);

/**
* 按比例把图片缩放到 maxDimension 内，输出到临时文件。
* 命令来自配置的 preprocessCommand 模板（占位符 {input} {output} {width} {height}）。
* 输出扩展名由文件头解析出的格式决定（附件文件可能没有扩展名）。
*/
async function preprocessImage(config, input, dims) {
  const scale = Math.min(config.maxDimension / dims.width, config.maxDimension / dims.height);
  const width = Math.max(1, Math.round(dims.width * scale));
  const height = Math.max(1, Math.round(dims.height * scale));
  const ext = dims.format || 'png';
  const output = join(tmpdir(), `auto-vision-${process.pid}-${Date.now()}.${ext}`);
  const command = config.preprocessCommand.map((part) => String(part)
    .replaceAll('{input}', input)
    .replaceAll('{output}', output)
    .replaceAll('{width}', String(width))
    .replaceAll('{height}', String(height)));
  try {
    await execFileAsync(command[0], command.slice(1), { timeout: config.timeoutMs });
    return { ok: true, path: output };
  } catch (error) {
    try { unlinkSync(output); } catch { /* 临时文件可能未创建 */ }
    return {
      ok: false,
      error: `图片尺寸 ${dims.width}x${dims.height} 超过上限 ${config.maxDimension}，缩放失败（${command[0]}）: ${messageOf(error)}`,
    };
  }
}

/**
* 读取并描述一张图片：超限图片先按比例缩放，再按配置的模型列表逐个尝试；
* HTTP 200 且有文字内容即成功，429/限流或空响应则继续尝试下一个模型。
* 缩放产生的临时文件无论成败都会清理。
*/
async function describeImage(config, path, question, modelArg) {
  let buf;
  let dimensions;
  let tmpPath = null;
  try {
    const stat = statSync(path);
    if (stat.size > config.maxFileBytes) {
      const mb = Math.round(config.maxFileBytes / 1024 / 1024);
      return { ok: false, error: `图片过大（>${mb}MB），不支持` };
    }
    buf = readFileSync(path);
  } catch (error) {
    return { ok: false, error: `读取图片失败: ${messageOf(error)}` };
  }

  try {
    dimensions = readImageDimensions(buf);
    if (dimensions && (dimensions.width > config.maxDimension || dimensions.height > config.maxDimension)) {
      const resized = await preprocessImage(config, path, dimensions);
      if (!resized.ok) return { ok: false, error: resized.error, dimensions };
      tmpPath = resized.path;
      buf = readFileSync(tmpPath);
    }

    const key = resolveApiKey(config);
    const models = resolveModels(config, modelArg);
    const base64 = buf.toString('base64');
    // 缩放可能改变格式（如 JPEG -> PNG），以最终字节的文件头为准推断 Content-Type
    const outDims = readImageDimensions(buf);
    const mime = MIME_BY_FORMAT[outDims && outDims.format] || mimeFromPath(tmpPath || path);
    const prompt = buildPrompt(question);

    const attempts = [];
    let lastError = '';
    for (const model of models) {
      try {
        const res = await callVisionApi(config, model, key, base64, mime, prompt);
        if (res.status === 200) {
          const description = extractDescription(res.raw);
          if (description) {
            return { ok: true, description, model, endpoint: config.endpoint, ...(dimensions ? { dimensions } : {}) };
          }
          lastError = `视觉 API 未返回文字内容（${model}）`;
        } else {
          const detail = extractErrorDetail(res.raw);
          lastError = res.status === 429 || /访问量过大|繁忙|busy|rate.?limit/i.test(detail)
            ? `视觉 API ${res.status}（${model}）限流: ${detail}`
            : `视觉 API HTTP ${res.status}（${model}）: ${detail}`;
        }
      } catch (error) {
        lastError = `请求视觉 API 失败（${model}）: ${messageOf(error)}`;
      }
      attempts.push({ model, error: lastError });
    }
    return {
      ok: false,
      error: lastError || '视觉 API 调用失败',
      endpoint: config.endpoint,
      models,
      attempts,
      ...(dimensions ? { dimensions } : {}),
    };
  } finally {
    if (tmpPath) {
      try { unlinkSync(tmpPath); } catch { /* 尽力清理 */ }
    }
  }
}

/** 工具入参路径兜底：无效/空路径时回退到共享槽里最近一张可用图片。 */
function resolveImagePath(raw) {
  const path = raw && raw.trim();
  if (path && existsSync(path)) return path;
  const slot = latestSlot();
  if (slot) {
    for (let i = slot.paths.length - 1; i >= 0; i--) {
      const candidate = slot.paths[i];
      if (typeof candidate === 'string' && candidate && existsSync(candidate)) return candidate;
    }
  }
  return path || '';
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export const name = 'auto-vision';
export const inject = ['llm'];

export function apply(ctx, config) {
  const llm = ctx.get('llm');
  const cfg = resolveConfig(config);
  const note = readEnv('AUTO_VISION_NOTE') || cfg.note;

  // 1) 记录最近粘贴图片的路径（供 see_image 兜底）；只读不修改任何消息。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision && decision.kind === 'enter' && Array.isArray(decision.messages)) {
      const found = [];
      for (const msg of decision.messages) {
        if (Array.isArray(msg && msg.content)) found.push(...collectImagePaths(msg.content));
      }
      recordLatestPaths(found, cfg.maxLatestPaths);
    }
    return decision;
  });

  // 2) llm/stream 最前面：清洗发往模型的请求副本，图片永远不进上游。
  //    只对含 image 块的消息动手（重入后不再含图，天然终止，不会死循环）。
  ctx.on('llm/stream', (options, next) => {
    if (!options || !Array.isArray(options.messages)) return next();
    const messages = sanitizeMessages(options.messages, note, cfg.maxLatestPaths);
    if (messages === null) return next();
    return llm.stream({ ...options, messages });
  }, { prepend: true, global: true });

  // 3) see_image 看图工具（可配置关闭；tools 服务缺席时静默跳过）。
  const tools = ctx.get('tools');
  let disposeTool = null;
  if (cfg.tool && tools) {
    const defaultModel = cfg.models[0] || '(未配置)';
    disposeTool = tools.register(defineTool({
      name: 'see_image',
      description: `读取一张本地图片，让视觉模型按需提取所需信息。当用户贴图/上传图片而 DeepSeek 看不到图片时，如需根据图片回答，请调用本工具。参数：file_path（图片绝对路径，参数名是 file_path 不是 path）可省略——省略时自动采用当前会话里用户最近一张粘贴图片的路径；question（你想从图中获取的具体信息，如"图中报错信息是什么""这个UI的按钮文字是什么""对比设计图和渲染图的差异"）。默认使用 ${defaultModel}（OCR 取字与视觉理解都够用）；如果需要最高精度的深度视觉分析，可在 model 传 heavy 或 OpenGVLab/InternVL3_5-241B-A28B。`,
      parameters: {
        file_path: { type: 'string', description: '图片文件的绝对路径；可省略，省略时自动采用当前会话用户最近粘贴的图片' },
        question: { type: 'string', description: '你想从图中提取的具体问题/信息；缺省则做通用提取' },
        model: { type: 'string', description: `可选：视觉模型 ID（默认 ${defaultModel}），或写 heavy 使用高端模型` },
      },
      async execute(args) {
        const filePath = String(args.file_path || args.path || '');
        const question = String(args.question || '');
        const modelArg = String(args.model || '');
        return describeImage(cfg, resolveImagePath(filePath), question, modelArg);
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const text = value && value.ok
            ? `图解释义（${value.model || ''}）：\n${value.description}`
            : `看图失败：${(value && value.error) || '未知错误'}`;
          return [{ type: 'text', text }];
        },
      },
    }));
  }

  return () => {
    if (disposeTool) disposeTool();
  };
}

export default { name, inject, apply };
