import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureVisionInputModal } from './vision-tool.ts';

const vision = { enabled: true, provider: 'pi-ai', model: 'qwen-vl-max' } as const;

let home: string;
let settingsPath: string;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-vision-'));
  settingsPath = resolve(home, 'settings.yaml');
  vi.stubEnv('DSH_HOME', home);
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** 带 vision 模型与其他内容的典型 settings.yaml（含注释与其他 provider） */
const BASE = [
  '# 用户级 dsh 配置（注释应保留）',
  'llm-pi-ai:',
  '  providers:',
  '    pi-ai:',
  '      models:',
  '        - id: qwen-vl-max',
  '          # 视觉模型',
  '          apiKey: sk-x',
  '        - id: deepseek-chat',
  '          input: [text]',
  'other-section: keep-me',
].join('\n');

describe('ensureVisionInputModal（settings.yaml 写入四约束）', () => {
  it('补写 input: [text, image] 且保留注释与其他配置（文档保真）', () => {
    writeFileSync(settingsPath, BASE, 'utf8');
    ensureVisionInputModal(vision as never, logger);

    const out = readFileSync(settingsPath, 'utf8');
    expect(out).toMatch(/input:\n\s+- text\n\s+- image/);
    expect(out).toContain('# 用户级 dsh 配置（注释应保留）');
    expect(out).toContain('# 视觉模型');
    expect(out).toContain('other-section: keep-me');
    expect(out).toContain('id: deepseek-chat');
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('幂等：已声明 image 时不写（不触 mtime）', () => {
    const content = BASE.replace(
      '          # 视觉模型',
      '          input: [text, image]\n          # 视觉模型',
    );
    writeFileSync(settingsPath, content, 'utf8');
    const before = readFileSync(settingsPath, 'utf8');

    ensureVisionInputModal(vision as never, logger);

    expect(readFileSync(settingsPath, 'utf8')).toBe(before); // 原样未动
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('fail-closed：非法 YAML → warn 不写', () => {
    writeFileSync(settingsPath, 'a:\n\tb: [unclosed', 'utf8');
    const before = readFileSync(settingsPath, 'utf8');

    ensureVisionInputModal(vision as never, logger);

    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('补写后文件可再次解析且二次调用幂等（写入产物有效）', () => {
    writeFileSync(settingsPath, BASE, 'utf8');
    ensureVisionInputModal(vision as never, logger);
    const after = readFileSync(settingsPath, 'utf8');

    // 二次调用（模拟下次启动）：幂等不写
    vi.mocked(logger.info).mockClear();
    ensureVisionInputModal(vision as never, logger);
    expect(readFileSync(settingsPath, 'utf8')).toBe(after);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('未找到模型 → warn 不写', () => {
    writeFileSync(settingsPath, BASE, 'utf8');
    const before = readFileSync(settingsPath, 'utf8');

    ensureVisionInputModal({ ...vision, model: 'nonexistent' } as never, logger);

    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('未找到 vision 模型'));
  });

  it('tab 缩进归一化后仍可补写（全文件 tab 缩进形态）', () => {
    // 每 2 空格 = 1 tab，层级保持一致（配置界面/编辑器写入 tab 的真实形态）
    const tabbed = BASE.replace(/^( +)/gm, (m) => '\t'.repeat(m.length / 2));
    writeFileSync(settingsPath, tabbed, 'utf8');
    ensureVisionInputModal(vision as never, logger);
    expect(readFileSync(settingsPath, 'utf8')).toMatch(/input:\n\s+- text\n\s+- image/);
  });
});
