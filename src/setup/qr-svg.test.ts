import { describe, it, expect } from 'vitest';
import { renderQrSvgDataUrl } from './qr-svg.ts';

describe('renderQrSvgDataUrl', () => {
  it('真实渲染：返回 SVG data URL', async () => {
    const result = await renderQrSvgDataUrl('https://q.qq.com/qqbot/connect.html?task_id=x');
    expect(result).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
    const svg = Buffer.from(result.split(',')[1]!, 'base64').toString('utf8').trim();
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
  });
});
