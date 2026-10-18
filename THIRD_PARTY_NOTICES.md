# Third-Party Notices

OptPdfEditor は以下のサードパーティ・ソフトウェアとフォントを `lib/` に同梱しています。各ソフトウェアの著作権はそれぞれの著作者に帰属し、各ライセンスに従って利用しています。本リポジトリの PolyForm Noncommercial ライセンスは、これらのサードパーティ部分には適用されません。

いずれも改変せずに同梱しています（形式の変換のみ。下の注を参照）。ライセンスの全文は、表の「ライセンス文」の列のファイルにあります。

| 名前 | バージョン | ライセンス | 同梱ファイル | ライセンス文 | 入手先 |
|---|---|---|---|---|---|
| pdf-lib | 1.17.1 | MIT（Copyright (c) 2019 Andrew Dillon） | `lib/pdf-lib.min.js` | `lib/pdf-lib.LICENSE.md` | https://github.com/Hopding/pdf-lib |
| PDF.js（legacy ビルド） | 3.11.174 | Apache-2.0（Mozilla） | `lib/pdf.min.js`, `lib/pdf.worker.min.js` | `lib/pdfjs.LICENSE.txt` | https://github.com/mozilla/pdf.js |
| PDF.js の CMap | 3.11.174 に同梱のもの | BSD-3-Clause 系（Copyright 1990-2009 Adobe Systems Incorporated） | `lib/cmaps/` | `lib/cmaps/LICENSE` | 同上（pdfjs-dist） |
| PDF.js の標準フォント（Foxit） | 同上 | BSD-3-Clause 系（Copyright 2014 PDFium Authors） | `lib/standard_fonts/Foxit*.pfb` | `lib/standard_fonts/LICENSE_FOXIT` | 同上（pdfjs-dist） |
| PDF.js の標準フォント（Liberation Sans） | 同上 | SIL Open Font License 1.1（Reserved Font Name: Liberation ほか） | `lib/standard_fonts/LiberationSans-*.ttf` | `lib/standard_fonts/LICENSE_LIBERATION` | 同上（pdfjs-dist） |
| JSZip | 3.10.2 | MIT と GPLv3 のデュアル。本リポジトリでは **MIT** を選択（内部で pako を使用、MIT） | `lib/jszip.min.js` | `lib/jszip.LICENSE.md` | https://github.com/Stuk/jszip |
| @pdf-lib/fontkit | 1.1.1 | MIT（foliojs/fontkit のフォーク、Copyright (c) Devon Govett） | `lib/fontkit.umd.min.js` | `lib/fontkit.LICENSE.txt` | https://github.com/Hopding/fontkit |
| harfbuzzjs（hb-subset） | — | MIT（Copyright (c) 2019-2026 The harfbuzzjs project authors）。WebAssembly に含まれる HarfBuzz 本体は Old MIT License | `lib/hb-subset.wasm`, `lib/hb-subset-wasm.js` | `lib/harfbuzzjs.LICENSE.txt` | https://github.com/harfbuzz/harfbuzzjs |
| BIZ UDGothic | 1.05 | SIL Open Font License 1.1（Copyright 2022 The BIZ UDGothic Project Authors。Reserved Font Name の指定なし） | `lib/BIZUDGothic-Regular.ttf`, `lib/font-bizudgothic.js` | `lib/BIZUDGothic.OFL.txt` | https://github.com/googlefonts/morisawa-biz-ud-gothic |

## 注

- `lib/font-bizudgothic.js` と `lib/hb-subset-wasm.js` は、それぞれ `BIZUDGothic-Regular.ttf` と `hb-subset.wasm` を base64 にして JavaScript に埋め込んだだけのものです（`file://` で開いたときに読み込むため）。中身は同一です。
- テキストを PDF に変換するとき、BIZ UDGothic を使う文字だけにサブセット化して PDF に埋め込みます。OFL 1.1 は、フォントを文書に埋め込むことを認めています。
- ライブラリを更新したら、この表のバージョンを更新してください。
