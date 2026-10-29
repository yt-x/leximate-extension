/**
 * 测试侧的**独立**分隔符文本解析器（RFC 4180 / Anki TSV 共用）。
 *
 * 为什么测试要自带一个解析器：§3.2.1 的验收是"逐项导入后卡片数必须等于词数"，
 * 而"数出记录数"这件事必须由**不共用写码路径**的实现来做——
 * 若读的时候复用写的那套引号规则，写错规则、读也错，测试照样全绿。
 *
 * 规则直接照 RFC 4180 的 ABNF 写：
 * `escaped = DQUOTE *(TEXTDATA / COMMA / CR / LF / 2DQUOTE) DQUOTE`。
 *
 * ⚠️ 两条与本项目约定绑定的行为（正是它们让断言有牙）：
 * - **末尾换行会解析出一条多余的空记录**——因此"文件末尾不加换行"是可断言的；
 * - 未包裹的引号不当引号处理（`field === ''` 才进入引号态）。
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      record.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\r' && text[index + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      index += 2;
      continue;
    }
    if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  record.push(field);
  records.push(record);
  return records;
}
