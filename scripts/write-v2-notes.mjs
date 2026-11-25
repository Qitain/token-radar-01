import { readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const context = {};
runInNewContext(readFileSync('out/data.js','utf8'), context);
const d = context.__TOKEN_RADAR__, v = d.model.valuation, o = d.model.odds, a = d.model.farm_assumptions;
const verify = JSON.parse(readFileSync('out/verification.json','utf8'));
const browser = JSON.parse(readFileSync('out/browser-verification.json','utf8'));
const planner = JSON.parse(readFileSync('out/planner-verification.json','utf8'));
const determinism = JSON.parse(readFileSync('out/determinism.json','utf8'));
const f = (n, digits=6) => Number(n).toFixed(digits);
const pct = n => f(100*n,2)+'%';
const dollars = n => '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const factor = m => f(m.median_error_factor)+'×';
const terms = v.ablation.terms.map(t => `| ${t.term} | ${factor(t.with_term.loo)} / ${factor(t.without_term.loo)} | ${factor(t.with_term.walk_forward)} / ${factor(t.without_term.walk_forward)} | ${t.retained?'KEEP':'CUT'} — ${t.reason} |`).join('\n');
const forms = v.curves.map(c=>`| ${c.form} | ${factor(c.loo)} | ${factor(c.walk_forward)} | ${pct(c.loo.within_2x)} / ${pct(c.walk_forward.within_2x)} | ${c.chosen?'selected':''} |`).join('\n');
const counts = Object.fromEntries(['FARM','THIN','SKIP'].map(k=>[k,d.board.filter(r=>r.farm.verdict===k).length]));
const sampleRows = verify.samples.map(s=>`| #${s.rank} ${s.slug} | ${dollars(s.snapshot_tvl_usd)} | ${dollars(s.valuation.implied_value_usd)} | ${f(s.odds.probability,9)} | ${dollars(s.farm.expected_airdrop_usd)} | ${dollars(s.farm.net_per_hour)} | ${dollars(s.farm.p10_net_usd)} | ${s.farm.verdict} |`).join('\n');
const outer = v.validation.nested_audit, ch=v.validation.chronology;
const note = `# Token Radar v2 — 实现与验收记录

本文由 scripts/write-v2-notes.mjs 从实际构建和验证报告生成。所有模型输出都在本次运行中从密封快照计算；固定数字只用于任务要求、统计方法或明确声明的情景假设。未提交、未推送、未运行赛事打包或提交工具。

## 快照与复现

- 工作快照日期：${d.snapshot.as_of}，从未刷新或写入。
- SHA-256：\`${d.integrity.snapshot_sha256}\`，构建入口验证原始字节；不匹配时拒绝覆盖产物。
- schema：\`${d.schema}\`。浏览器资源版本：20261125v2。
- 运行：\`node --experimental-strip-types main.ts\`；Node 22.14 必须带该 flag。
- 检查：\`node --experimental-strip-types scripts/verify-v2.ts\`、\`node scripts/verify-planner.mjs\`、\`node scripts/verify-browser.mjs\`。
- 生成本说明：\`node scripts/write-v2-notes.mjs\`。截图刷新：浏览器检查加 \`--screenshots\`，然后再次构建以同步 out/screenshots 与 dossier。
- 参考仓库已在实现前阅读并删除 refs/；实现为独立代码。没有引入新数据源、依赖或网络请求。

## 1 / 6 / 10：盲测、曲线选择、完整消融与验证面板

估值样本 ${v.sample_count} 个：有正 market cap、正 TVL 和类别的已发币协议。目标是快照中的 market capitalization，而非缺少供应量数据的 FDV。模型每次运行重拟合，不保存榜单价值常数。

最终模型：**${v.selected.form}**；保留 ${v.selected.terms.length} / ${v.ablation.terms.length} 个旧乘数。

\`\`\`
${v.selected.equation}
\`\`\`

样本内 log(mcap) R² = ${f(v.fit.r2_log_mcap)}，仅描述拟合程度。误差倍数定义为 exp(median(abs(log(预测 mcap/TVL ÷ 实际 mcap/TVL))))，1× 最好；完整 JSON 同时保留有方向的预测/实际比值、每条留出预测及 within-2× 比例。

LOO：每次排除目标，再拟合其余 ${v.validation.loo.n-1} 个样本。时间留出：${ch.train_n} 个较早收录样本（截至 ${ch.cutoff}）拟合，${ch.test_n} 个较晚收录样本测试；${ch.undated_excluded} 个无日期样本不混进时间训练。相同日期不会跨边界。

| 曲线 | LOO 误差 | 时间留出误差 | 2× 内比例 LOO / 时间 | 选择 |
| --- | --- | --- | --- | --- |
${forms}

曲线按两项 median absolute log error 之和选择。对选出的曲线测试五个 v1 乘数的全部 ${v.ablation.tested_configurations} 个开关组合。类别的 P10–P90 截断、n/(n+8) 收缩与其余四项的原始公式都保留作实验对象；类别统计只由训练折计算。每个候选在同一批留出对象上评分。保留项必须同时改善 LOO 和时间留出，且对同配置移除该项的对照也必须同时改善；其余删除。旧乘数是系数固定为 1 的旧规则测试，最终保留项为空，因此最终所有非 TVL 系数均由曲线拟合产生。

| 旧项 | LOO 有 / 无 | 时间留出 有 / 无 | 决定与理由 |
| --- | --- | --- | --- |
${terms}

**额外外层留出：** 主 LOO / 时间分数用于选择，不能再冒充独立最终测试。另在任何形式和乘数选择前，封存最新约四分之一的有日期可比样本。仅在更早的 ${outer.train_n} 个样本（截至 ${outer.cutoff}）内部重做所有选型，再对从未参与选型的 ${outer.test_n} 个样本评估。内层选择 ${outer.selected.form}、${outer.selected.terms.length} 个乘数；最终外层误差 **${factor(outer.metrics)}**，2× 内比例 ${pct(outer.metrics.within_2x)}。该模型与最终全样本模型不同，这是正常的选型不确定性。

面板显示全部曲线、五项有/无误差、全部 ${v.ablation.tested_configurations} 配置、按类别的留出误差及外层审计。此结果不声称优于其他作品在不同划分上的数字。

**时间含义：** listed_at 是协议收录日期，不是代币上市日期；TVL 和 mcap 都是同一快照的当前值。因此 walk-forward 是收录队列压力测试，不能重建历史交易回测，也不能预测发币日期。

## 2：经验 token 概率

使用全部 ${o.cohort_n} 条记录，包括 ${o.issued_n} 个已发币标签及 ${o.pretoken_n} 个无币标签；没有只拿估值有效样本充当总体。方法为类别 × 年龄三分位 × TVL 二分位的经验分桶，并保留未知年龄桶。所有分位数和先验强度在每个训练折内部重算。

父桶先验强度 = sqrt(训练记录数)，类别格先验强度 = sqrt(已填充父桶支持数的中位数)。先用年龄/TVL 父桶向全局比例收缩，再用类别格向父桶收缩。每一行计算时排除自身已知的无币标签，并展示支持计数、实际先验及公式。

\`\`\`
${o.formula}
\`\`\`

| 概率验证 | n | Brier 模型 / 基准 | log loss 模型 / 基准 |
| --- | --- | --- | --- |
| LOO | ${o.validation.loo.n} | ${f(o.validation.loo.brier)} / ${f(o.validation.loo.base_brier)} | ${f(o.validation.loo.log_loss)} / ${f(o.validation.loo.base_log_loss)} |
| 收录队列时间留出 | ${o.validation.walk_forward.n} | ${f(o.validation.walk_forward.brier)} / ${f(o.validation.walk_forward.base_brier)} | ${f(o.validation.walk_forward.log_loss)} / ${f(o.validation.walk_forward.base_log_loss)} |

基准也仅用训练集比例。时间留出 ${o.validation.walk_forward.train_n} 训练 / ${o.validation.walk_forward.test_n} 测试，截止 ${o.validation.walk_forward.cutoff}，排除 ${o.validation.walk_forward.undated_excluded} 条无日期记录。时间测试平均预测 ${pct(o.validation.walk_forward.mean_probability)}，实际 ${pct(o.validation.walk_forward.observed_rate)}，存在高估；板上明示此结果。

这里的“概率”是存活快照中相似协议当前已有币的比例，用作发币情景权重；不是已知仍无币条件下未来某个期限发币的概率。快照无法识别后者。

## 3：农场美元经济账

每行六步。资本按 v1 的 TVL 尺度规则计算，不把它冒充实际最低资格资金。固定情景如下，板上及详情均明示：

- 假设农民池为 token market cap 的 ${pct(a.pool_fraction)}，平均分给 ${a.qualifying_wallets.toLocaleString('en-US')} 个假想合格钱包；个人分成 ${pct(a.farmer_share)}（${a.farmer_share}）。这些不是快照观察。
- 假设每次交易 gas ${dollars(a.gas_per_transaction_usd)}，所有链采用相同情景费用；没有伪称链费用来自拟合。
- 时间单价 ${dollars(a.time_value_usd_per_hour)}/小时，观察 ${a.hold_weeks} 周。步骤累计 ${d.board[0].farm.transactions} 次交易、${d.board[0].farm.time_hours*60} 分钟；gas ${dollars(d.board[0].farm.gas_usd)}、时间 ${dollars(d.board[0].farm.time_cost_usd)}，总费用 ${dollars(d.board[0].farm.total_cost_usd)}。
- 期望空投 = 隐含市值 × 经验 token 概率 × 个人分成；成本 = 步骤 gas + 步骤工时 × 时间单价；净 $/小时 = (期望空投 − 成本) / 工时。
- 回本个人分成 = 成本 / (隐含市值 × 经验概率)，同时列出 P10 回本分成、可承受钱包数及所需池比例。
- 资本作为可回收的占用资金，计入资金预算，但不重复当作损失；不含收益率、资本损失、滑点、税和机会成本。没有公共入口或资格证据时，步骤要求先检查并停止。

保守估值取 min(残差预测 P10, bootstrap 拟合 P10)。该估值乘概率与个人分成，再减全部成本，得到 P10 估值情景净值。净值 < 0 为 SKIP；非负但小于总成本为 THIN；至少达到总成本为 FARM。

**默认实际结果：${counts.FARM} FARM / ${counts.THIN} THIN / ${counts.SKIP} SKIP。** 这是宽预测误差及当前假设下算出的结果，没有为了制造农场数量调高分成。P10 是低估值情景，不是无条件空投收益第十分位；零收益完全可能。规划器可修改分配及时间价格，并重新应用同一 P10 规则。

## 4 / 8：可失败的完整性条与全量审计

封面实时重算行数、rank、严格递减且互异的价值、watchlist 身份、无代币及全量唯一身份；合并构建阶段全部检查。失败显示红色 FAIL，构建失败则拒绝覆盖原输出。另对 issued 数量、固定入选集合、快照字节 seal、六步文本有效性检查。

**${d.integrity.counts.ranked} 板上 + ${d.integrity.counts.issued} 有币 + ${d.integrity.counts.excluded} 排除 = ${d.integrity.counts.total}。** 每个排除记录均列 slug、名称、类别、TVL 和具体选择原因；有币 ${d.issued.length} 条完整可查看。排除只是超出原来的固定选择范围，没有借排除口径改动结构。验证脚本给全部完整性规则注入了故障并确认相应规则变红/失败。

## 5 / 7：诚实区间与 bootstrap

每行显示两个不同区间：

- 预测 P10–P90：已发币样本 LOO 的 log(mcap/TVL) 残差分位数，乘回该行点估值。残差 P10 ${f(v.intervals.residual_p10,9)}、P90 ${f(v.intervals.residual_p90,9)}。名义 ${pct(v.intervals.target_coverage)}；校准描述性覆盖 ${pct(v.intervals.calibration_coverage)}。
- 只使用较早训练样本重新校准残差后，在时间测试集覆盖 **${pct(v.intervals.walk_forward_coverage)}**（${v.intervals.walk_forward_n} 条）；外层未参与选型测试覆盖 **${pct(outer.interval.coverage)}**（${outer.test_n} 条）。未把名义 80% 伪称实测覆盖，也未宣称 conformal 保证。
- bootstrap：${v.bootstrap.refits} 次有放回协议重采样、重新拟合、重新估值和排名；种子 ${v.bootstrap.seed} 从密封样本内容确定性派生。每行有拟合价值 P10/P90 与 rank P10/P90。保留曲线形式和项集合，明确这是条件于已选模型的参数稳定性。

当前曲线在入选 TVL 范围保持单调，所以 rank bootstrap 大多或全部固定，这是方法的实际结果；它并不消除单协议的宽预测残差。板上和详情同时列这两类区间。

## 9：精确组合规划器

输入资本+gas预算、每周工时，并可调整情景分成及时间单价。排除当前情景 P10 SKIP，精确最大化总期望空投价值；所选项目按单位占用资金期望价值展示。实现为不可分割的 0/1 子集优化：当前相同每周工时转换为数量约束，按资金与价值的非支配前沿精确求解；非一致工时使用资金/时间/价值 Pareto 前沿。没有用排序贪心冒充全局最优，没有舍入期望值来凑解。

输出占用本金、gas、总 reserve、周工时、总期望价值、净值及 P10 情景净值之和；最后一项不冒充组合第十分位。默认合格集为空，返回不配置资金；敏感性情景下可生成非空最优组合。独立穷举校验包含贪心反例、240 个小样本及实际快照小集合，另测试完整 ${d.board.length} 行压力场景。

## 复算抽查与旧功能

对全部 ${d.board.length} 行独立复算原始源字段、入选集合、概率支持计数与分位切分、费用、工时、回本、估值及预测区间。以下 ${verify.samples.length} 行另保存详细手工式算式，涵盖榜首、中部、榜尾和缺失年龄：

| 行 | 快照 TVL | 重算价值 | 重算概率 | 期望空投 | 净 $/小时 | P10 净值 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${sampleRows}

例如 ${verify.samples[0].slug}：p = ${verify.samples[0].odds.expression} = ${f(verify.samples[0].odds.probability,12)}；期望空投 = ${verify.samples[0].valuation.implied_value_usd} × p × ${a.farmer_share} = ${dollars(verify.samples[0].farm.expected_airdrop_usd)}；净 $/小时 = (${dollars(verify.samples[0].farm.expected_airdrop_usd)} − ${dollars(verify.samples[0].farm.cost_usd)}) / ${f(d.board[0].farm.time_hours,9)} = ${dollars(verify.samples[0].farm.net_per_hour)}。完整精度在 verification.json，没有以页面四舍五入值反推模型。

原前五名重算对照：${d.model.rank_migration.map(r=>`${r.name} #${r.old_rank} → #${r.new_rank}（${dollars(r.old_value_usd)} → ${dollars(r.new_value_usd)}）`).join('；')}。顺序相同，估值尺度变化来自移除未验证乘数并使用实拟合曲线，没有名称特例。

- 构建完整性：${d.integrity.checks.filter(c=>c.pass).length}/${d.integrity.checks.length} PASS。
- 独立数学与故障注入：${verify.checks.filter(c=>c.pass).length}/${verify.checks.length} ${verify.passed?'PASS':'FAIL'}。
- 精确规划器：${planner.checks?.filter(c=>c.pass).length ?? planner.passed_checks}/${planner.checks?.length ?? planner.total_checks} ${planner.passed?'PASS':'FAIL'}。
- 浏览器：${browser.checks.filter(c=>c.pass).length}/${browser.checks.length} ${browser.passed?'PASS':'FAIL'}；英文、排序、搜索、类别/链过滤、无结果状态、有币页、详情六步、Esc/遮罩/按钮关闭、焦点回归、移动端、实时红色故障条、规划器输入均检查。页面 JS 错误 ${browser.errors.length}，外部请求 ${browser.external_requests.length}。
- 重复构建：${determinism.artifact_count} 个正式产物逐字节 SHA-256 一致，${determinism.passed?'PASS':'FAIL'}；包含 board/data/model-report/audit/dossier、全部 dashboard 文件和截图。无时钟、非确定随机或联网依赖。
- 产物：board.json、data.js、model-report.json、audit.json、dashboard/、screenshots/、dossier.json；验证报告为额外生成文件。计算研究摘要也进入 dashboard/00-evidence.md，让 dossier 文本直接携带数值证据。
`;
writeFileSync('V2-NOTES.md',note);
console.log('Wrote V2-NOTES.md from computed reports');
