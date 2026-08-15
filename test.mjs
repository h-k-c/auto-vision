// auto-vision 单元测试（npm test）
// 自包含：不依赖 DSH 运行时、真实图片或网络；视觉 API 调用用 mock fetch。
// 运行：node test.mjs
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.mjs';

const pass = (name, detail = '') => console.log(`  PASS: ${name}${detail ? ' — ' + detail : ''}`);
const fail = (name, detail) => { throw new Error(`FAIL: ${name} — ${detail}`); };

// 环境隔离：清掉所有可能干扰的变量，测试结束恢复
const ENV_KEYS = ['VISION_ENDPOINT', 'VISION_MODEL', 'VISION_MAX_TOKENS', 'VISION_MAX_FILE_BYTES',
  'VISION_MAX_DIMENSION', 'VISION_TIMEOUT_MS', 'VISION_API_KEY', 'MODELSCOPE_API_KEY',
  'ZHIPU_API_KEY', 'AUTO_VISION_NOTE', 'VISION_TOOL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
for (const k of ENV_KEYS) delete process.env[k];

// mock fetch：记录请求体，按 handler 返回
const sentBodies = [];
let fetchHandler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  sentBodies.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
  return fetchHandler
    ? fetchHandler(url, opts)
    : { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '默认描述' } }] }) };
};

// fake 基础设施
const fakeLlm = {
  stream(options) { sentBodies.push({ llm: options }); return (async function* () { yield { type: 'text', text: 'ok' }; })(); },
};
let toolDef = null;
const makeCtx = () => {
  const listeners = {};
  return {
    listeners,
    get(name) {
      if (name === 'llm') return fakeLlm;
      if (name === 'tools') return { register: (def) => { toolDef = def; return () => {}; } };
      return undefined;
    },
    on(name, cb, opts) { listeners[name] = { cb, opts }; },
  };
};
const reset = () => {
  sentBodies.length = 0;
  fetchHandler = null;
  toolDef = null;
  delete globalThis.__dshVisionLatest;
};

const tmpFile = (bytes = 4096) => {
  const path = join(tmpdir(), `auto-vision-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  writeFileSync(path, Buffer.alloc(bytes));
  return path;
};

// 1) 单插件同时提供：工具 + llm/stream 监听 + pre-step 监听
{
  reset();
  const ctx = makeCtx();
  apply(ctx, { apiKey: 'k' });
  if (!toolDef || toolDef.name !== 'see_image') fail('工具注册', String(toolDef && toolDef.name));
  if (!ctx.listeners['llm/stream'] || !ctx.listeners['agent/pre-step']) fail('监听注册', '缺监听');
  if (!toolDef.parameters || !toolDef.parameters.properties) fail('参数 schema', '');
  pass('工具 + 清洗 + 记录同时注册');
}

// 2) see_image 显式路径（mock 200）
{
  reset();
  const ctx = makeCtx();
  apply(ctx, { apiKey: 'k' });
  const file = tmpFile();
  const out = await toolDef.execute({ file_path: file, question: '内容' });
  unlinkSync(file);
  if (!out.ok || out.description !== '默认描述') fail('看图', JSON.stringify(out).slice(0, 120));
  const req = sentBodies[0];
  if (req.body.model !== 'Qwen/Qwen3-VL-235B-A22B-Instruct') fail('默认模型', req.body.model);
  if (!req.body.messages[0].content[0].image_url.url.startsWith('data:image/png;base64,')) fail('base64 前缀', '');
  if (req.headers.Authorization !== 'Bearer k') fail('Authorization', '');
  pass('see_image 显式路径看图');
}

// 3) 省略 file_path -> 共享槽兜底
{
  reset();
  const ctx = makeCtx();
  apply(ctx, { apiKey: 'k' });
  const file = tmpFile();
  globalThis.__dshVisionLatest = { paths: ['/nonexistent/a.png', file] };
  const out = await toolDef.execute({ question: '看' });
  unlinkSync(file);
  if (!out.ok) fail('槽兜底', JSON.stringify(out).slice(0, 120));
  pass('省略 file_path 走共享槽兜底');
}

// 4) 图片过大拦截（不调 fetch）
{
  reset();
  const ctx = makeCtx();
  apply(ctx, { apiKey: 'k', maxFileBytes: 100 });
  const file = tmpFile(1024);
  const out = await toolDef.execute({ file_path: file });
  unlinkSync(file);
  if (out.ok || !/图片过大/.test(out.error)) fail('过大拦截', JSON.stringify(out));
  if (sentBodies.length !== 0) fail('过大时不应调 fetch', '');
  pass('图片过大拦截');
}

// 5) 限流 fallback 到第二个模型
{
  reset();
  let n = 0;
  fetchHandler = async () => {
    n++;
    if (n === 1) return { status: 429, text: async () => '{"error":{"message":"访问量过大"}}' };
    return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'fallback 成功' } }] }) };
  };
  const ctx = makeCtx();
  apply(ctx, { apiKey: 'k' });
  const file = tmpFile();
  const out = await toolDef.execute({ file_path: file });
  unlinkSync(file);
  if (!out.ok || out.model !== 'Qwen/Qwen3-VL-8B-Instruct') fail('fallback', JSON.stringify(out).slice(0, 140));
  if (sentBodies.filter((b) => b.body).length !== 2) fail('fetch 次数', '');
  pass('限流 fallback 到第二个模型');
}

// 6) 有图清洗：veto + 重派发一次 + 原消息不动 + tool-result 嵌套
{
  reset();
  const ctx = makeCtx();
  apply(ctx, {});
  const imgBlock = { type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64) } };
  const original = [
    { role: 'user', content: [{ type: 'text', text: '看' }, imgBlock] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }, { ...imgBlock }] }] },
  ];
  let vetoed = true;
  const stream = ctx.listeners['llm/stream'].cb({ provider: 'p', messages: original }, () => { vetoed = false; throw new Error('有图必须 veto'); });
  for await (const _ of stream) {}
  const wire = JSON.stringify(sentBodies.find((b) => b.llm).llm.messages);
  if (!vetoed) fail('veto', '');
  if (wire.includes('"type":"image"')) fail('清洗', 'image 块仍在');
  if (!wire.includes('用户粘贴了一张图片')) fail('note', '');
  if (original[0].content[1].type !== 'image' || original[1].content[0].content[1].type !== 'image') fail('原消息被改', '');
  pass('有图清洗 + veto 重派发一次 + 原消息不动');
}

// 7) 无图直通 + 清洗后无死循环
{
  reset();
  const ctx = makeCtx();
  apply(ctx, {});
  let viaNext = false;
  const s1 = ctx.listeners['llm/stream'].cb({ provider: 'p', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, () => { viaNext = true; return (async function* () { yield 'p'; })(); });
  for await (const _ of s1) {}
  if (!viaNext) fail('无图直通', '未走 next');
  const img = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64) } }] }];
  const s2 = ctx.listeners['llm/stream'].cb({ provider: 'p', messages: img }, () => { throw new Error('x'); });
  for await (const _ of s2) {}
  const sent = sentBodies.find((b) => b.llm).llm.messages;
  const before = sentBodies.length;
  let passThrough = false;
  const s3 = ctx.listeners['llm/stream'].cb({ provider: 'p', messages: sent }, () => { passThrough = true; return (async function* () {})(); });
  for await (const _ of s3) {}
  if (!passThrough || sentBodies.length !== before) fail('递归防护', '');
  pass('无图直通 + 清洗后无死循环');
}

// 8) note 可配置（config 优先于默认，环境变量优先于 config）
{
  reset();
  const ctx = makeCtx();
  apply(ctx, { note: 'CFG_NOTE' });
  const img = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64) } }] }];
  const s1 = ctx.listeners['llm/stream'].cb({ provider: 'p', messages: img }, () => { throw new Error('x'); });
  for await (const _ of s1) {}
  if (!JSON.stringify(sentBodies.find((b) => b.llm).llm.messages).includes('CFG_NOTE')) fail('config.note', '');
  reset();
  process.env.AUTO_VISION_NOTE = 'ENV_NOTE';
  const ctx2 = makeCtx();
  apply(ctx2, { note: 'CFG_NOTE' });
  const s2 = ctx2.listeners['llm/stream'].cb({ provider: 'p', messages: img }, () => { throw new Error('x'); });
  for await (const _ of s2) {}
  if (!JSON.stringify(sentBodies.find((b) => b.llm).llm.messages).includes('ENV_NOTE')) fail('env 优先', '');
  delete process.env.AUTO_VISION_NOTE;
  pass('note 配置化与优先级');
}

// 9) tool:false 只关工具，清洗照常
{
  reset();
  const ctx = makeCtx();
  apply(ctx, { tool: false });
  if (toolDef !== null) fail('tool:false 仍注册工具', '');
  const img = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64) } }] }];
  const s = ctx.listeners['llm/stream'].cb({ provider: 'p', messages: img }, () => { throw new Error('x'); });
  for await (const _ of s) {}
  if (!sentBodies.find((b) => b.llm)) fail('tool:false 清洗失效', '');
  pass('tool:false 只关工具');
}

// 10) 环境变量覆盖配置
{
  reset();
  process.env.VISION_MAX_TOKENS = '777';
  process.env.VISION_MODEL = 'custom-vl';
  const ctx = makeCtx();
  apply(ctx, { apiKey: 'k' });
  const file = tmpFile();
  const out = await toolDef.execute({ file_path: file });
  unlinkSync(file);
  if (!out.ok || out.model !== 'custom-vl') fail('env 模型覆盖', JSON.stringify(out).slice(0, 100));
  if (sentBodies[0].body.max_tokens !== 777) fail('env maxTokens 覆盖', '');
  delete process.env.VISION_MAX_TOKENS;
  delete process.env.VISION_MODEL;
  pass('环境变量覆盖配置');
}

// 11) provider 预设一键切换：zhipu（config 与 VISION_PROVIDER 环境变量）
{
  reset();
  const ctx = makeCtx();
  apply(ctx, { provider: 'zhipu', apiKey: 'k' });
  const file = tmpFile();
  const out = await toolDef.execute({ file_path: file });
  unlinkSync(file);
  if (!out.ok) fail('zhipu provider 看图', JSON.stringify(out).slice(0, 120));
  const req = sentBodies[0];
  if (req.url !== 'https://open.bigmodel.cn/api/paas/v4/chat/completions') fail('zhipu endpoint', req.url);
  if (req.body.model !== 'glm-4v-flash') fail('zhipu 默认模型', req.body.model);
  pass('provider: zhipu 一键切换（智谱免费档）');

  reset();
  process.env.VISION_PROVIDER = 'zhipu';
  const ctx2 = makeCtx();
  apply(ctx2, { apiKey: 'k' });
  const out2 = await toolDef.execute({ file_path: tmpFile() });
  if (!out2.ok || out2.model !== 'glm-4v-flash') fail('VISION_PROVIDER 环境变量', JSON.stringify(out2).slice(0, 120));
  delete process.env.VISION_PROVIDER;
  pass('VISION_PROVIDER 环境变量切换');

  // 未知 provider 回退默认（魔搭），显式 endpoint/models 仍可覆盖
  reset();
  const ctx3 = makeCtx();
  apply(ctx3, { provider: 'unknown', apiKey: 'k', endpoint: 'http://localhost:1/v1', models: ['m'] });
  const out3 = await toolDef.execute({ file_path: tmpFile() });
  if (!out3.ok || out3.model !== 'm') fail('自定义覆盖', JSON.stringify(out3).slice(0, 120));
  pass('未知 provider 回退默认 + 显式 endpoint/models 覆盖');
}

// 12) pre-step 决策原样透传
{
  reset();
  const ctx = makeCtx();
  apply(ctx, {});
  const decision = await ctx.listeners['agent/pre-step'].cb({}, () => Promise.resolve({ kind: 'enter', messages: [] }));
  if (decision.kind !== 'enter') fail('pre-step 透传', '');
  pass('pre-step 决策透传');
}

// 恢复环境
for (const k of ENV_KEYS) {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
}
globalThis.fetch = realFetch;

console.log('\nALL TESTS PASSED');
