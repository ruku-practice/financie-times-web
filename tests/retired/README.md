# 退役した検査（2026-09-13・合体 v3.2.3）

旧「分析」タブ（`?tab=analysis`・`#analysis-view`・`data/analysis/*.json`）を外したため、そのタブを開いて確かめていた検査をここへ移した。消してはいない（git の履歴と、このフォルダに残る）。

| ファイル | 何を見ていたか | いま同じことを見ている検査 |
|---|---|---|
| `check_analysis.js`（57項目） | 旧タブの図・表・KPI が `reference_analysis.py`（data/analysis 系の独立計算）と一致 | `tests/check_merged_ref.js`（合体の集計を別実装 `reference_merged.py` と実データで突き合わせ）・`tests/check_merged.js`（見せ方の図・KPI・結論・機運） |
| `check_analysis_parts.js`（6項目） | 分析の部品（AnalysisParts）を旧タブと別インスタンスで動かしても干渉しない・機運の式が旧タブと一致 | `tests/check_merged.js` M2（全体市況の箱で分析の部品が描く）・M10／M23（KPI） |
| `reference_analysis.py` | `check_analysis.js` の期待値（data/analysis 系） | `tests/reference_merged.py` |

旧タブへ戻すときは、`index.html` の `#analysis-view` と釦、`js/advanced.js` の `analysis-tab` の分岐、`.gitignore` の `data/analysis/` を v3.2.2（コミット `99973cda`）へ戻し、`python3 scripts/build_analysis.py` でデータを作り直す。
