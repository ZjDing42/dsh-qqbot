/** 本地提示词来源：插件直接读取文件正文，不借助模型读取工具。 */
import { closeSync, constants, fstatSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { extname, isAbsolute, normalize } from 'node:path';
import { TextDecoder } from 'node:util';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope } from '../types.ts';

export const MAX_PROMPT_FILE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

export interface LoadedPromptFile {
  path: string;
  text: string;
  bytes: number;
  characters: number;
  modifiedAt: string;
}

class PromptFileError extends Error {}

function promptFilePath(path: string): string {
  if (typeof path !== 'string' || !path.trim()) {
    throw new PromptFileError('请选择本地提示词文件');
  }
  const filePath = normalize(path.trim());
  if (!isAbsolute(filePath)) throw new PromptFileError('提示词文件必须使用绝对路径');
  if (!TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new PromptFileError('提示词文件仅支持 .md、.markdown 和 .txt 格式');
  }
  return filePath;
}

function checkFile(stats: Stats): void {
  if (!stats.isFile()) throw new PromptFileError('提示词路径必须指向普通文件');
  if (stats.size > MAX_PROMPT_FILE_BYTES) throw new PromptFileError('提示词文件不能超过 1 MiB');
}

function decodeFile(filePath: string, buffer: Buffer, modifiedAt: Date): LoadedPromptFile {
  if (buffer.length > MAX_PROMPT_FILE_BYTES) throw new PromptFileError('提示词文件不能超过 1 MiB');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    throw new PromptFileError('提示词文件编码无效，请将文件另存为 UTF-8');
  }
  if (!text.trim()) throw new PromptFileError('提示词文件不能为空');
  if (text.includes('\0')) throw new PromptFileError('提示词文件包含二进制内容，请选择 UTF-8 文本文件');
  return { path: filePath, text, bytes: buffer.length, characters: Array.from(text).length, modifiedAt: modifiedAt.toISOString() };
}

function fileError(error: unknown): never {
  if (error instanceof PromptFileError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new PromptFileError('提示词文件不存在，请重新选择');
  if (code === 'EACCES' || code === 'EPERM') throw new PromptFileError('没有权限读取提示词文件');
  throw new PromptFileError('无法读取提示词文件，请确认文件可访问后重试');
}

/** 每次读取当前文件；限制读取量，文件即使在读取期间膨胀也不会越界。 */
export async function loadPromptFile(path: string): Promise<LoadedPromptFile> {
  const filePath = promptFilePath(path);
  try {
    checkFile(await stat(filePath));
    // 非阻塞标志避免误选 FIFO 等特殊文件时等待；Windows 普通文件不受影响。
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const stats = await handle.stat();
      checkFile(stats);

      const buffer = Buffer.alloc(MAX_PROMPT_FILE_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const chunk = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (chunk.bytesRead === 0) break;
        bytes += chunk.bytesRead;
      }
      return decodeFile(filePath, buffer.subarray(0, bytes), stats.mtime);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return fileError(error);
  }
}

/** Native SystemPrompt section providers are synchronous. Read at each assembly
 * with the same bounds/validation as preview; never cache stale or failed content.
 */
export function loadPromptFileSync(path: string): LoadedPromptFile {
  const filePath = promptFilePath(path);
  try {
    checkFile(statSync(filePath));
    const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const stats = fstatSync(fd);
      checkFile(stats);
      const buffer = Buffer.alloc(MAX_PROMPT_FILE_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
        if (count === 0) break;
        bytes += count;
      }
      return decodeFile(filePath, buffer.subarray(0, bytes), stats.mtime);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return fileError(error);
  }
}

export type ScopePromptConfig = Pick<ImQQBotConfig,
  'groupPrompt' | 'directPrompt' | 'groupPromptMode' | 'directPromptMode' | 'groupPromptFile' | 'directPromptFile'>;

/** 每个 scope 只使用所选来源；文件错误抛出，避免无提示词运行或回退旧文本。 */
export async function resolveScopePrompt(config: ScopePromptConfig, scope: ChatScope): Promise<string | undefined> {
  const group = scope === 'group';
  const mode = group ? config.groupPromptMode : config.directPromptMode;
  if (mode === 'file') {
    const path = group ? config.groupPromptFile : config.directPromptFile;
    return (await loadPromptFile(path ?? '')).text;
  }
  return group ? config.groupPrompt : config.directPrompt;
}

/** File contents remain verbatim; text keeps the native extra-prompt trimming. */
export function resolveScopePromptSync(config: ScopePromptConfig, scope: ChatScope): string | undefined {
  const group = scope === 'group';
  const mode = group ? config.groupPromptMode : config.directPromptMode;
  if (mode === 'file') {
    return loadPromptFileSync((group ? config.groupPromptFile : config.directPromptFile) ?? '').text;
  }
  return (group ? config.groupPrompt : config.directPrompt)?.trim();
}
