import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger } from '../types.ts';
import type { DshAgent, DshAgentRegistry } from './types.ts';
import { SessionManager } from './session-manager.ts';

// Use the same scope implementation as the real SystemPrompt service.
const promptRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-system-prompt'));
const { createScope } = await import(pathToFileURL(promptRequire.resolve('@deepseek-ai/dsh-scope')).href);

// Keep tests independent of the user's saved model preferences and settings.
vi.mock('../model/model-resolver.ts', () => ({
  ModelResolver: class {
    getEffectiveRoute() { return undefined; }
    getResumeRoute() { return undefined; }
    getSessionId() { return undefined; }
    setSessionId() {}
    getPreset() { return undefined; }
  },
}));

function extras(assembly: PromptAssembly) {
  return assembly.sections.filter(section => section.name === 'qqbot:extra');
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function promptFile(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-scope-prompt-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '群聊提示词.md');
  await writeFile(path, text, 'utf8');
  return path;
}

async function harness(config: Partial<ImQQBotConfig>, resume = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'qqbot-native-prompt-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const ctx = new Context();
  cleanup.push(async () => { await ctx.fiber.dispose(); });
  await ctx.plugin(SystemPrompt, {});
  ctx.systemPrompt.section({ name: 'host', order: 0, text: 'Harness base prompt' });
  const live = new Map<string, DshAgent>();
  const handle = (id: string) => {
    const agent = {
      id, ctx, status: 'idle', session: { id, snapshotEvents: () => [] },
      cancel: vi.fn(), followup: vi.fn(), whenIdle: async () => {},
    };
    agent.ctx = createScope(ctx, agent).ctx;
    return { agent: agent as unknown as DshAgent, dispose: async () => {} };
  };
  const agents = {
    get: (id: string) => live.get(id),
    resume: vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => {
      if (!resume) throw new Error('no persisted session');
      return handle(resumeSessionId);
    }),
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => handle(sessionId)),
  } as unknown as DshAgentRegistry;
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const effectiveConfig = {
    appId: 'test', sessionIdleTimeout: 0, cwd, ...config,
  } as ImQQBotConfig;
  const manager = new SessionManager(ctx, agents, effectiveConfig, logger);
  cleanup.push(() => manager.disposeAll());
  const base = await ctx.systemPrompt.assemble();
  return {
    manager, agents, base, config: effectiveConfig, ctx, live,
    async record(scope: ChatScope) {
      return manager.getOrCreate(scope, `${scope}-peer`, 'sender', {
        scope, targetId: `${scope}-peer`, msgId: 'test-message',
      });
    },
    async assemble(agent?: DshAgent) {
      return ctx.systemPrompt.assemble(agent ? { agent, scope: agent } : {});
    },
  };
}

describe('QQ scope system prompt assembly', () => {
  it('preserves legacy text configuration and isolates group/private prompts', async () => {
    const test = await harness({ groupPrompt: '群聊规则', directPrompt: '私聊规则' });
    const group = await test.record('group');
    const direct = await test.record('c2c');
    expect(extras(await test.assemble(group.agent))).toEqual([{ name: 'qqbot:extra', text: '群聊规则' }]);
    expect(extras(await test.assemble(direct.agent))).toEqual([{ name: 'qqbot:extra', text: '私聊规则' }]);
    expect((await test.assemble(group.agent)).sections).toContainEqual({ name: 'host', text: 'Harness base prompt' });
    expect(await test.assemble()).toEqual(test.base);
    expect(await test.assemble({ id: 'unrelated', ctx: test.ctx.extend() } as DshAgent)).toEqual(test.base);
  });

  it.each([false, true])('injects the full file once into a created/resumed session (resume=%s)', async (resume) => {
    const text = '# 群聊规则\n\n你好，世界。\n';
    const path = await promptFile(text);
    const test = await harness({
      groupPrompt: '保留但停用的旧文本', groupPromptMode: 'file', groupPromptFile: path,
      directPrompt: '私聊仍使用文本',
    }, resume);
    const group = await test.record('group');
    const assembled = await test.assemble(group.agent);
    expect(extras(assembled)).toEqual([{ name: 'qqbot:extra', text }]);
    const direct = await test.record('c2c');
    expect((await test.assemble(direct.agent)).sections.at(-1)?.text).toBe('私聊仍使用文本');
    expect(test.agents.create).toHaveBeenCalledTimes(resume ? 0 : 2);
  });

  it('reads updated file content on the next turn of an existing session', async () => {
    const path = await promptFile('第一版');
    const test = await harness({ directPromptMode: 'file', directPromptFile: path });
    const record = await test.record('c2c');
    expect((await test.assemble(record.agent)).sections.at(-1)?.text).toBe('第一版');
    await writeFile(path, '第二版', 'utf8');
    expect((await test.assemble(record.agent)).sections.at(-1)?.text).toBe('第二版');
    expect(await test.record('c2c')).toBe(record);
  });

  it('rejects a missing file rather than sending a request with a missing or fallback prompt', async () => {
    const path = await promptFile('必需规则');
    const test = await harness({ groupPrompt: '旧文本', groupPromptMode: 'file', groupPromptFile: path });
    const record = await test.record('group');
    await rm(path);
    await expect(test.assemble(record.agent)).rejects.toThrow();
    await writeFile(path, '文件已恢复', 'utf8');
    expect(extras(await test.assemble(record.agent))).toEqual([{ name: 'qqbot:extra', text: '文件已恢复' }]);
  });

  it('switches live scopes between text and file without mixing inactive sources', async () => {
    const path = await promptFile('文件规则\n');
    const test = await harness({ groupPrompt: '群聊文本', directPrompt: '私聊文本',
      groupPromptMode: 'file', groupPromptFile: path, directPromptFile: path });
    const group = await test.record('group');
    const direct = await test.record('c2c');
    expect(extras(await test.assemble(group.agent))[0]?.text).toBe('文件规则\n');
    expect(extras(await test.assemble(direct.agent))[0]?.text).toBe('私聊文本');
    test.config.groupPromptMode = 'text';
    test.config.directPromptMode = 'file';
    expect(extras(await test.assemble(group.agent))[0]?.text).toBe('群聊文本');
    expect(extras(await test.assemble(direct.agent))[0]?.text).toBe('文件规则\n');
  });

  it('reinstalls the live file provider after disposal without duplicate sections', async () => {
    const path = await promptFile('初始规则');
    const test = await harness({ groupPromptMode: 'file', groupPromptFile: path });
    const record = await test.record('group');
    await test.manager.disposeAll();
    expect(extras(await test.assemble(record.agent))).toEqual([]);
    // The host may retain an Agent after the plugin releases its own handle.
    test.live.set(record.sessionId, record.agent);
    test.agents.get = () => record.agent;
    await writeFile(path, '复用后的规则', 'utf8');
    const reused = await test.record('group');
    expect(reused.agent).toBe(record.agent);
    expect(extras(await test.assemble(reused.agent))).toEqual([{ name: 'qqbot:extra', text: '复用后的规则' }]);
    await test.record('group');
    expect(extras(await test.assemble(reused.agent))).toHaveLength(1);
  });
});
