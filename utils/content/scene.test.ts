/**
 * 从真实选区捕获例句的验收（PLAN.md FR-C1 / FR-C4）。
 *
 * @vitest-environment jsdom
 *
 * 这一层是唯一真的碰 DOM 的例句代码（`Range` + `getComputedStyle`），
 * 所以只有它需要 jsdom；切句规则本身在 `sentence.test.ts` 里用纯函数测。
 */
import { describe, expect, it } from 'vitest';
import { domainOf } from '../db/words';
import { captureScene, displayDomain, sentenceContainer } from './scene';

const SOURCE = { url: 'https://example.com/read/1', title: 'Example 文章' };

/** 把一段选区装进 window（jsdom 的 getSelection 是全局单例） */
function select(
  startNode: Node,
  startOffset: number,
  endNode: Node = startNode,
  endOffset: number = startOffset,
): void {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function textNodeOf(element: Element): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode();
  if (first === null) throw new Error('没有文本节点');
  return first as Text;
}

/** 选中某个词（取该元素下第一个文本节点里的第一个匹配） */
function selectWord(element: Element, word: string): void {
  const node = textNodeOf(element);
  const at = node.data.indexOf(word);
  if (at < 0) throw new Error(`文本里没有 ${word}`);
  select(node, at, node, at + word.length);
}

function reset(): void {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
}

describe('FR-C1：从选区切出所在的句子', () => {
  it('块级 <p> 里的词 → 取该句，偏移指向那个词', () => {
    document.body.innerHTML = '<div><p>He ran fast. She walked.</p></div>';
    const p = document.querySelector('p');
    if (p === null) throw new Error('无 p');
    selectWord(p, 'fast');

    const scene = captureScene(window.getSelection(), document, SOURCE);
    expect(scene).not.toBeNull();
    expect(scene?.text).toBe('He ran fast.');
    expect(scene?.text.slice(scene.highlightFrom, scene.highlightTo)).toBe('fast');
  });

  it('来源元数据带 URL 与标题', () => {
    document.body.innerHTML = '<p>He ran fast.</p>';
    const p = document.querySelector('p');
    if (p === null) throw new Error('无 p');
    selectWord(p, 'ran');

    const scene = captureScene(window.getSelection(), document, SOURCE);
    expect(scene?.sourceUrl).toBe(SOURCE.url);
    expect(scene?.sourceTitle).toBe(SOURCE.title);
  });

  it('行内 <span> 里的词 → 容器仍是块级祖先（不是那个 span）', () => {
    document.body.innerHTML =
      '<div><span>He ran</span> <span>fast. She walked.</span></div>';
    const [, second] = document.querySelectorAll('span');
    if (second === undefined) throw new Error('无 span');
    selectWord(second, 'fast');

    const scene = captureScene(window.getSelection(), document, SOURCE);
    // 容器若是那个 span，例句只会是 "fast."——它不含前一句
    expect(scene?.text).toBe('He ran fast.');
    expect(scene?.text.slice(scene.highlightFrom, scene.highlightTo)).toBe('fast');
  });

  it('跨节点选区（粗体内到句末）偏移仍然正确', () => {
    document.body.innerHTML = '<p>He <b>ran</b> fast.</p>';
    const p = document.querySelector('p');
    const b = document.querySelector('b');
    const text = p?.lastChild;
    if (p === null || b === null || text === null) throw new Error('结构不对');
    // 从 <b> 内 "ran" 的起点选到 "fast." 的末尾
    const endOffset = (text as Text).data.length;
    select(textNodeOf(b), 0, text, endOffset);

    const scene = captureScene(window.getSelection(), document, SOURCE);
    expect(scene?.text).toBe('He ran fast.');
    expect(scene?.text.slice(scene.highlightFrom, scene.highlightTo)).toBe('ran fast.');
  });

  it('中文句子（句号后无空格）同样能切', () => {
    document.body.innerHTML = '<p>今天下雨了。我们待在家。</p>';
    const p = document.querySelector('p');
    if (p === null) throw new Error('无 p');
    selectWord(p, '我们');

    const scene = captureScene(window.getSelection(), document, SOURCE);
    expect(scene?.text).toBe('我们待在家。');
    expect(scene?.text.slice(scene.highlightFrom, scene.highlightTo)).toBe('我们');
  });
});

describe('捕获失败是正常结果（返回 null，不影响划词主链路）', () => {
  it('没有选区 → null', () => {
    reset();
    expect(captureScene(window.getSelection(), document, SOURCE)).toBeNull();
  });

  it('折叠选区（没选到东西）→ null', () => {
    document.body.innerHTML = '<p>He ran fast.</p>';
    const p = document.querySelector('p');
    if (p === null) throw new Error('无 p');
    select(textNodeOf(p), 3);
    expect(captureScene(window.getSelection(), document, SOURCE)).toBeNull();
  });

  it('传 null 也不炸', () => {
    expect(captureScene(null, document, SOURCE)).toBeNull();
  });

  it('容器文本超长（>20000）时退化为起始节点父元素', () => {
    const filler = 'x'.repeat(20001);
    document.body.innerHTML = `<div>${filler}<span>He ran fast.</span></div>`;
    const span = document.querySelector('span');
    if (span === null) throw new Error('无 span');
    selectWord(span, 'fast');

    const scene = captureScene(window.getSelection(), document, SOURCE);
    // 退化后容器是 span 本身：例句只有 "He ran fast."，而不是那两万个字符
    expect(scene?.text).toBe('He ran fast.');
    expect((scene?.text.length ?? 0)).toBeLessThan(100);
  });
});

describe('容器判定', () => {
  it('从文本节点向上找到块级元素', () => {
    document.body.innerHTML = '<div><p><span>text</span></p></div>';
    const span = document.querySelector('span');
    if (span === null) throw new Error('无 span');
    const range = document.createRange();
    range.selectNodeContents(textNodeOf(span));

    const container = sentenceContainer(range, document);
    expect(container?.tagName).toBe('P');
  });
});

describe('displayDomain 与后台的 domainOf 同口径', () => {
  it('同一批 URL 两处给出同样的结果（防止算法漂移）', () => {
    const urls = [
      'https://example.com/a/b?c=1',
      'http://www.example.org:8080/x',
      'https://sub.domain.co.uk/path',
      'not a url',
      '',
    ];
    for (const url of urls) {
      expect(displayDomain(url)).toBe(domainOf(url));
    }
  });
});
