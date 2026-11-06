/**
 * ensureVisionInputModal 写 ~/.dsh/settings.yaml 的回归用例（D1）
 *
 * 该文件是宿主用户级配置、多写者共存，补写必须满足：文档保真（注释/锚点/其他
 * 命名空间的值原样保留）、原子写、读写窗口内被外部改动则放弃。
 * 覆盖 vision-modal.test.ts 之外的约束：锚点、值保真、原子性、乐观校验。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as hostParse } from 'yaml';
import type { VisionConfig } from '../config.ts';
import type { Logger } from '../types.ts';

/** fs 钩子：模拟写入中途失败 / 读写窗口内宿主并发写入 */
const fsHooks = vi.hoisted(() => ({
  realWrite: undefined as undefined | ((path: string, data: string) => void),
  beforeWrite: undefined as undefined | ((path: string, data: string) => void),
  afterRead: undefined as undefined | ((path: string) => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsHooks.realWrite = (path, data) => actual.writeFileSync(path, data, 'utf8');
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const out = actual.readFileSync(...args);
      fsHooks.afterRead?.(String(args[0]));
      return out;
    }) as typeof actual.readFileSync,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      fsHooks.beforeWrite?.(String(args[0]), String(args[1]));
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
  };
});

const { ensureVisionInputModal } = await import('./vision-tool.ts');

const vision: VisionConfig = {
  enabled: true,
  provider: 'hunyuan',
  model: 'hunyuan-vision',
  defaultPrompt: 'Describe this image in detail.',
  maxBytes: 10 * 1024 * 1024,
  maxTokens: 1024,
  timeoutMs: 120000,
};

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/** 宿主 settings-file 维护的真实形态：注释、锚点、其他命名空间 */
const SETTINGS = [
  '# DSH 用户设置（宿主 settings-file 以保留注释的叶子级 diff 维护）',
  'agent-default-model:',
  '  provider: deepseek-official # 默认模型',
  '  model: deepseek-v4-flash',
  'retry-defaults: &retry',
  '  attempts: 3',
  'llm-pi-ai:',
  '  providers:',
  '    hunyuan:',
  '      apiKeyEnv: HUNYUAN_API_KEY # 不要提交密钥',
  '      retry: *retry',
  '      models:',
  '        - id: hunyuan-vision',
  '          name: Hunyuan Vision',
  'some-plugin:',
  '  since: 2026-10-30',
  '  installId: 2054134973171351552',
  '',
].join('\n');

let dshHome: string;
let settingsPath: string;
let prevDshHome: string | undefined;

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'im-qqbot-settings-'));
  settingsPath = join(dshHome, 'settings.yaml');
  prevDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
});

afterEach(() => {
  fsHooks.beforeWrite = undefined;
  fsHooks.afterRead = undefined;
  if (prevDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevDshHome;
  rmSync(dshHome, { recursive: true, force: true });
});

describe('ensureVisionInputModal — 对照组', () => {
  it('已声明 image 输入：幂等跳过，不写文件', () => {
    const content = SETTINGS.replace('          name: Hunyuan Vision', '          name: Hunyuan Vision\n          input: [text, image]');
    writeFileSync(settingsPath, content, 'utf8');

    ensureVisionInputModal(vision, createLogger());

    expect(readFileSync(settingsPath, 'utf8')).toBe(content);
  });

  it('未声明 image 输入：补齐 input（功能本身生效）', () => {
    writeFileSync(settingsPath, SETTINGS, 'utf8');

    ensureVisionInputModal(vision, createLogger());

    const after = hostParse(readFileSync(settingsPath, 'utf8')) as {
      'llm-pi-ai': { providers: { hunyuan: { models: Array<{ input?: string[] }> } } };
    };
    expect(after['llm-pi-ai'].providers.hunyuan.models[0]?.input).toEqual(['text', 'image']);
  });
});

describe('ensureVisionInputModal — D1 写入约束', () => {
  it('D1-1 注释与用户锚点原样保留（不被重命名为 &ref_0）', () => {
    writeFileSync(settingsPath, SETTINGS, 'utf8');

    ensureVisionInputModal(vision, createLogger());

    const after = readFileSync(settingsPath, 'utf8');
    expect(after).toContain('# 不要提交密钥');
    expect(after).toContain('retry-defaults: &retry');
    expect(after).toContain('retry: *retry');
    expect(after).not.toContain('&ref_0');
  });

  it('D1-2 其他命名空间的值不被改写：日期保持字符串、大整数不丢精度', () => {
    writeFileSync(settingsPath, SETTINGS, 'utf8');
    const before = hostParse(SETTINGS) as { 'some-plugin': { since: unknown } };

    ensureVisionInputModal(vision, createLogger());

    const raw = readFileSync(settingsPath, 'utf8');
    const after = hostParse(raw) as { 'some-plugin': { since: unknown } };
    expect(after['some-plugin'].since).toBe(before['some-plugin'].since);
    expect(raw).toContain('2054134973171351552');
  });

  it('D1-3 原子写：临时文件写入中途失败（如 ENOSPC）后原文件完好，无 tmp 残留', () => {
    writeFileSync(settingsPath, SETTINGS, 'utf8');
    fsHooks.beforeWrite = (path, data) => {
      if (!path.startsWith(settingsPath) || path === settingsPath) return;
      // 临时文件写入半份后失败：原文件此时尚未被 rename 覆盖
      fsHooks.realWrite?.(path, data.slice(0, 40));
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    };
    const logger = createLogger();

    ensureVisionInputModal(vision, logger);

    expect(readFileSync(settingsPath, 'utf8')).toBe(SETTINGS);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));
    expect(readdirSync(dshHome).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('D1-4 乐观校验：读写窗口内宿主保存了设置 → 放弃本次补写，宿主内容不丢', () => {
    writeFileSync(settingsPath, SETTINGS, 'utf8');
    const hostSaved = `${SETTINGS}host-saved-key: from-settings-ui\n`;
    let fired = false;
    fsHooks.afterRead = (path) => {
      if (path !== settingsPath || fired) return;
      fired = true;
      // 模拟宿主设置界面在插件 read 之后、write 之前完成一次保存
      fsHooks.realWrite?.(settingsPath, hostSaved);
    };
    const logger = createLogger();

    ensureVisionInputModal(vision, logger);

    expect(fired).toBe(true);
    const after = readFileSync(settingsPath, 'utf8');
    expect(after).toBe(hostSaved); // 宿主写入胜出，插件不覆盖
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('外部修改'));
  });
});

describe('ensureVisionInputModal — 误报澄清（未复现）', () => {
  it('行首 tab 规范化不会改写合法 YAML 的块文本内容', () => {
    // 合法 YAML 中第 0 列 tab 不可能出现在块标量内部（js-yaml 直接报错）；
    // 缩进内的 tab 不匹配 /^\t+/m。故此前「提示词内容被改动」的判断不成立。
    const content = `${SETTINGS}prompts:\n  system: |\n    line1\n    \tindented-by-tab\n`;
    writeFileSync(settingsPath, content, 'utf8');

    ensureVisionInputModal(vision, createLogger());

    const before = hostParse(content) as { prompts: { system: string } };
    const after = hostParse(readFileSync(settingsPath, 'utf8')) as { prompts: { system: string } };
    expect(after.prompts.system).toBe(before.prompts.system);
  });
});
