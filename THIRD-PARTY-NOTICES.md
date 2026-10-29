# 第三方声明

本扩展的**全部代码与自撰内容**以 MIT 许可发布（见 `LICENSE`）。
下面列出随包分发的第三方数据及其许可。这些数据是**数据**，不是本项目的代码。

## CMU Pronouncing Dictionary（CMUdict）

用途：`data/core-words.tsv` 的美音音标列由该词典经本项目自建的 ARPAbet→IPA 映射表派生
（生成脚本 `scripts/build-phonetics.ts`，映射表 `utils/dict/arpabet.ts`）。
钉版副本位于 `data/pronunciation/cmudict.dict`。

- 来源：https://github.com/cmusphinx/cmudict
- 引用格式：Carnegie Mellon University, *The CMU Pronouncing Dictionary*.

### 许可全文

```
Copyright (C) 1993-2015 Carnegie Mellon University. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
   The contents of this file are deemed to be source code.

2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in
   the documentation and/or other materials provided with the
   distribution.

This work was supported in part by funding from the Defense Advanced
Research Projects Agency, the Office of Naval Research and the National
Science Foundation of the United States of America, and by member
companies of the Carnegie Mellon Sphinx Speech Consortium. We acknowledge
the contributions of many volunteers to the expansion and improvement of
this dictionary.

THIS SOFTWARE IS PROVIDED BY CARNEGIE MELLON UNIVERSITY ``AS IS'' AND
ANY EXPRESSED OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL CARNEGIE MELLON UNIVERSITY
NOR ITS EMPLOYEES BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## British National Corpus（BNC）

用途：`data/core-words.tsv` 的**选词与词频排序**由 BNC Baby（400 万词）自行统计得出
（统计脚本 `scripts/count-corpus.ts`，挑选脚本 `scripts/build-wordlist.ts`）。
**语料本体与任何文本片段都不随包分发**，随包分发的只有"我们算出的词表"。

- 来源：https://llds.web.ox.ac.uk/repository （Literary and Linguistic Data Service，牛津大学；原 Oxford Text Archive）
- 引用格式：The British National Corpus, version 3 (BNC XML Edition). 2007. Distributed by Oxford University Computing Services on behalf of the BNC Consortium. URL: http://www.natcorp.ox.ac.uk/
- 许可要点（BNC User Licence）：`There is no restriction on the use of the Licensee's Results`；
  官方 FAQ 明确 `It's also permitted to publish wordlists`。本项目不复制、不再分发 BNC 文本。

## Wikidata Lexeme（屈折数据）

用途：`public/dict/inflections.json` 的英文屈折形式（名词复数、动词各时态、形容词比较级等）
由 Wikidata Lexeme 命名空间派生；钉版原始产物位于 `data/inflections/wikidata-forms.tsv`
（生成脚本 `scripts/fetch-inflections.ts`）。

- 来源：https://www.wikidata.org/wiki/Wikidata:Lexicographical_data
- 许可：**CC0 1.0**（公共领域贡献，无署名义务；此处仍致谢）
- 引用格式：Wikidata contributors, *Wikidata Lexicographical data* (CC0 1.0).

## NVIDIA NeMo 的 IPA 版 CMUdict（仅测试用对照）

用途：`data/pronunciation/nemo-stress-fixture.tsv` 是本项目的**音标交叉校验对照数据**
（从 `ipa_cmudict-0.7b_nv26.07.txt` 抽出本项目词表的 IPA，每词只取首个发音）。**只参与测试，不随扩展分发。**

- 来源：https://github.com/NVIDIA-NeMo/Speech/blob/main/scripts/tts_dataset_files/ipa_cmudict-0.7b_nv26.07.txt
- 许可：仓库 Apache-2.0；文件头原样保留 CMUdict 的 BSD 式声明（`Copyright (C) 1993-2015 Carnegie Mellon University`）
- 引用格式：NVIDIA NeMo, *ipa_cmudict-0.7b_nv26.07.txt*（Apache-2.0；数据承 CMUdict 的 BSD 式许可）。

## 没有随包分发的数据

以下内容**不在**本扩展的分发包里，仅在此说明，避免后来者重复调研：

- **BNC 语料本体**：只用于构建期统计，不入库、不随包分发。
- **ECDICT**：完整词库由用户自行下载导入，扩展包不含其数据。
- **中文释义**：全部由本项目自行撰写，不取自任何第三方词典。
- **英音音标**：暂无来源，`phoneticUk` 列为空。
- **NeMo 对照数据**：只在仓库里做音标交叉校验，不随包分发。

来源调研、排除理由与被放弃的方案见 `decisions/0001-dictionary-source.md`、
`decisions/0003-dictionary-data-sources.md` 与 `decisions/0007-wordlist-sourcing.md`。
