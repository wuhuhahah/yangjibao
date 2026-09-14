# -*- coding: utf-8 -*-
"""持仓体检：读 yjb-data.json，拉历史净值，算集中度/回撤/相关性，出报告。"""
import json, os, time, math, re, statistics
import requests
import pandas as pd
import akshare as ak  # 仅用新浪指数日 K 作 push2his 被限流时的兜底

HDRS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'http://fund.eastmoney.com/'}


def fetch_nav(code):
    """东财 pingzhongdata 接口，返回累计净值 Series（akshare 同源但更稳，可带 Referer）"""
    r = requests.get(f'http://fund.eastmoney.com/pingzhongdata/{code}.js', headers=HDRS, timeout=15)
    r.raise_for_status()
    m = re.search(r'Data_ACWorthTrend\s*=\s*(\[.*?\]);', r.text)
    if not m:
        raise ValueError(f'未找到净值数据 status={r.status_code} body={r.text[:50]!r}')
    m2 = re.search(r'Data_performanceEvaluation\s*=\s*(\{.*?\});', r.text)
    if m2:
        try:
            d = json.loads(m2.group(1))
            EVAL[code] = {'avr': d.get('avr'),
                          'detail': dict(zip(d.get('categories') or [], d.get('data') or []))}
        except Exception:
            pass
    arr = [x for x in json.loads(m.group(1)) if x[1] is not None]  # 个别基金历史净值有 null
    s = pd.Series({pd.Timestamp(x[0], unit='ms'): float(x[1]) for x in arr})
    return s.sort_index().tail(DAYS + 1)

DAYS = 250  # 近一年
CACHE = 'nav_cache.json'
cache = json.load(open(CACHE, encoding='utf-8')) if os.path.exists(CACHE) else {}
EVAL = {}  # 每只基金的机构业绩评价（阶段收益/抗风险/收益稳定性）

# 主题归类（按基金名人工判定，比自动分类可靠）
THEME = {
    '008163': '红利防御', '012547': '红利防御', '018099': '保险', '000950': '券商保险',
    '012590': '券商保险', '016186': '公用事业', '008280': '煤炭周期',
    '002611': '黄金',
    '025209': '半导体', '020671': '半导体', '013841': '半导体',
    '023408': 'AI科技', '013305': 'AI科技', '012349': '港股科技', '019830': 'AI科技',
    '022365': 'AI科技', '003984': '新能源', '022754': 'A股选股', '016874': 'A股选股',
    '018957': 'A股选股',
    '017731': '全球科技', '022184': '全球科技', '024239': '全球科技',
    '040046': '美股宽基', '014978': '美股宽基', '016453': '美股宽基', '016452': '美股宽基',
    '008706': '欧洲宽基', '539003': '欧洲宽基',
    '110017': '债券',
}

data = json.load(open('yjb-data.json', encoding='utf-8'))['fundList']
funds = {f['code']: f for f in data.values() if (f.get('money') or 0) > 10}  # 键带 a 前缀，用内部 code 字段
total = sum(f['money'] for f in funds.values())
print(f'参与统计基金 {len(funds)} 只，合计 {total:.2f} 元\n')

# ---------- 板块估值（东财行业板块 PE 全市场横截面百分位；板块历史 K 线被拒，无 5 年分位） ----------
# 注意：必须在基金净值批量请求之前拉，否则会被临时限流拒接
SECTOR_KEYS = {
    '半导体': ['半导体'], 'AI科技': ['软件开发', '计算机设备', '通信设备', '互联网', '游戏'],
    '新能源': ['光伏设备', '电池', '能源金属'], '公用事业': ['电力'], '保险': ['保险'],
    '券商保险': ['证券'], '黄金': ['贵金属'], '红利防御': ['银行', '煤炭'],
}
PB_KEYS = ('银行', '保险', '证券')  # 金融类板块看 PB 比 PE 靠谱（按板块名判定）
is_pb = lambda n: any(k in n for k in PB_KEYS)
SECTORS = []
print('\n===== 板块估值（PE 在 496 个行业板块中的横截面百分位，越低越便宜）=====')
try:
    rows = []
    for pn in range(1, 6):  # 东财单页上限 100 条，496 个板块需翻页
        d = requests.get('https://push2delay.eastmoney.com/api/qt/clist/get', params={
            'pn': pn, 'pz': 100, 'po': 1, 'np': 1, 'fltt': 2, 'invt': 2, 'fid': 'f12',
            'fs': 'm:90 t:2', 'fields': 'f12,f14,f9,f23'}, headers=HDRS, timeout=15).json()['data']['diff']
        rows.extend(d)
        if len(d) < 100:
            break
    pes = sorted(x['f9'] for x in rows if isinstance(x['f9'], (int, float)))
    def pe_pct(v):
        return round(sum(p < v for p in pes) / len(pes) * 100, 1) if isinstance(v, (int, float)) else None
    byname = {x['f14']: x for x in rows}
    seen = set()
    for theme, kws in SECTOR_KEYS.items():
        for kw in kws:
            b = byname.get(kw) or next((x for n2, x in byname.items() if kw in n2), None)  # 细分行业名带 Ⅱ/Ⅲ 后缀，子串兜底
            if b and b['f12'] not in seen:
                seen.add(b['f12'])
                SECTORS.append((b['f14'], b['f9'], b['f23'], pe_pct(b['f9']), theme))
    SECTORS.sort(key=lambda t: (t[3] is None, t[3] if t[3] is not None else 0))
    # 金融类板块补 PB：板块行情接口不给 PB，用成分股 PB 中位数现算
    for i, (n, pe, _pb, p, theme) in enumerate(SECTORS):
        if not is_pb(n):
            continue
        code = next((x['f12'] for x in rows if x['f14'] == n), None)
        if not code:
            continue
        try:
            d = requests.get('https://push2delay.eastmoney.com/api/qt/clist/get', params={
                'pn': 1, 'pz': 500, 'po': 1, 'np': 1, 'fltt': 2, 'invt': 2, 'fid': 'f3',
                'fs': f'b:{code}', 'fields': 'f23'}, headers=HDRS, timeout=15).json()['data']['diff']
            vals = sorted(x['f23'] for x in d if isinstance(x['f23'], (int, float)) and x['f23'] > 0)
            SECTORS[i] = (n, pe, round(vals[len(vals) // 2], 2) if vals else '-', p, theme)
        except Exception:
            pass
    for n, pe, pb, p, theme in SECTORS:
        print(f'{n:<8} PE {pe}  PB {pb}  分位 {p}%  [{theme}]')
except Exception as e:
    print('板块估值获取失败（不影响其余体检）:', e)

# ---------- 拉净值（带缓存） ----------
navs = {}
for code in funds:
    if code in cache and (cache.get('eval:' + code) or {}).get('avr'):  # 净值有缓存且评价非空才跳过请求
        navs[code] = pd.Series({pd.Timestamp(k): v for k, v in cache[code].items()})
        EVAL[code] = cache.get('eval:' + code, {})
        print(f'{code} 缓存命中')
        continue
    for attempt in range(3):
        try:
            s = fetch_nav(code)
            navs[code] = s
            cache[code] = {str(k): v for k, v in s.items()}
            if code in EVAL:
                cache['eval:' + code] = EVAL[code]
            print(f'{code} {funds[code]["short_name"]}  {len(s)} 天')
            break
        except Exception as e:
            if attempt == 2: print(f'{code} 获取失败: {e}')
            time.sleep(2)
    time.sleep(1.2)
json.dump(cache, open(CACHE, 'w', encoding='utf-8'))

# ---------- 单基金指标 ----------
price = pd.DataFrame(navs).sort_index().ffill().dropna(how='all').ffill()
ret = price.pct_change().dropna()


def mdd(series):
    return ((series / series.cummax()) - 1).min()

rows = []
for code, f in funds.items():
    if code not in price.columns: continue
    w = f['money'] / total
    s, r = price[code].dropna(), ret[code].dropna()
    if len(r) < 30: continue
    ann = (s.iloc[-1] / s.iloc[0]) ** (250 / len(s)) - 1
    vol = r.std() * math.sqrt(250)
    rows.append({'code': code, 'name': f['short_name'], 'theme': THEME.get(code, '其他'),
                 'money': f['money'], 'w': w, 'ann': ann, 'vol': vol, 'mdd': mdd(s),
                 'sharpe': (ann - 0.015) / vol if vol > 0 else 0})
stat = pd.DataFrame(rows)
if stat.empty:
    raise SystemExit('没有任何基金数据获取成功，请检查网络或稍后重试')

# ---------- 组合层面（按权重合成净值曲线） ----------
wret = (ret[stat.code.tolist()].fillna(0) * stat.set_index('code').w).sum(axis=1)
curve = (1 + wret).cumprod()
port = {'年化收益': wret.mean() * 250, '年化波动': wret.std() * math.sqrt(250),
        '近一年最大回撤': mdd(curve)}

# ---------- 输出 ----------
pd.set_option('display.width', 200)
print('\n===== 单基金体检（近一年，按权重排序）=====')
out = stat.sort_values('w', ascending=False).copy()
out['w'] = (out.w * 100).round(1).astype(str) + '%'
for c in ['ann', 'vol', 'mdd']:
    out[c] = (out[c] * 100).round(1).astype(str) + '%'
out['sharpe'] = out.sharpe.round(2)
out.columns = ['代码', '名称', '主题', '金额', '权重', '年化', '波动', '最大回撤', '夏普']
print(out.to_string(index=False))

print('\n===== 主题集中度 =====')
agg = stat.groupby('theme').apply(lambda g: pd.Series({
    '金额': g.money.sum(), '权重': g.w.sum(), '平均年化': (g.w * g.ann).sum() / g.w.sum(),
    '平均回撤': (g.w * g.mdd).sum() / g.w.sum()}), include_groups=False).sort_values('权重', ascending=False)
agg['金额'] = agg['金额'].round(0)
agg['权重'] = (agg['权重'] * 100).round(1).astype(str) + '%'
for c in ['平均年化', '平均回撤']:
    agg[c] = (agg[c] * 100).round(1).astype(str) + '%'
print(agg.to_string())

print('\n===== 组合整体（近一年）=====')
print(f"年化收益 {port['年化收益']*100:.1f}% | 年化波动 {port['年化波动']*100:.1f}% | 最大回撤 {port['近一年最大回撤']*100:.1f}%")

print('\n===== 高相关基金对 (相关系数>0.85，重复度高的候选合并对象) =====')
codes = stat.code.tolist()
pairs = []
for i in range(len(codes)):
    for j in range(i + 1, len(codes)):
        a, b = codes[i], codes[j]
        if a in ret and b in ret:
            common = ret[[a, b]].dropna()
            if len(common) > 60:
                c = common[a].corr(common[b])
                if c > 0.85:
                    pairs.append((c, funds[a]['short_name'], funds[b]['short_name'],
                                  funds[a]['money'] + funds[b]['money']))
for c, na, nb, m in sorted(pairs, reverse=True):
    print(f'{c:.3f}  {na} × {nb}  (合计 {m:.0f} 元)')

# ---------- 指数估值分位（5年价格分位，东财 K 线；口径在报告中标注） ----------
IDX = {'1.000688': '科创50', '0.399006': '创业板指', '1.000300': '沪深300',
       '1.000922': '中证红利', 'fund:012349': '恒生科技', '100.NDX': '纳斯达克100',
       'fund:539003': '富时100'}


def idx_pct(secid):
    key = 'idx:' + secid
    ck = cache.get(key)
    if ck and ck.get('d') == time.strftime('%Y-%m-%d') and 'c' in ck:
        return ck['p']
    vols = None
    if secid.startswith('fund:'):
        # 东财 K 线拒查港股指数，用同走势的联接基金净值代替
        r = requests.get(f'http://fund.eastmoney.com/pingzhongdata/{secid[5:]}.js',
                         headers=HDRS, timeout=15)
        m = re.search(r'Data_ACWorthTrend\s*=\s*(\[.*?\]);', r.text)
        closes = [x[1] for x in json.loads(m.group(1)) if x[1] is not None][-1250:]
    else:
        try:
            r = requests.get('https://push2his.eastmoney.com/api/qt/stock/kline/get', params={
                'secid': secid, 'fields1': 'f1,f2,f3', 'fields2': 'f51,f53,f56',
                'klt': 101, 'fqt': 0, 'beg': '20210101', 'end': '20500101'},
                headers=HDRS, timeout=15).json()
            ks = [k.split(',') for k in r['data']['klines']]
        except Exception:
            # 东财 K 线限流兜底：新浪指数日 K（仅 A 股指数）
            sym = ('sh' if secid.startswith('1.') else 'sz') + secid.split('.')[1]
            df = ak.stock_zh_index_daily(symbol=sym).tail(1300)
            ks = [[str(x.date), x.close, x.volume] for x in df.itertuples()]
        closes = [float(k[1]) for k in ks]
        vols = [float(k[2]) for k in ks]
    p = round(sum(c < closes[-1] for c in closes) / len(closes) * 100, 1)
    cache[key] = {'d': time.strftime('%Y-%m-%d'), 'p': p,
                  'c': closes[-80:], 'v': (vols or [])[-12:]}
    return p


print('\n===== 指数估值分位（近5年价格分位，<30 偏低 / >70 偏高）=====')
vals = []
for secid, name in IDX.items():
    try:
        p = idx_pct(secid)
        tag = '偏低·可定投' if p < 30 else ('偏高·控仓位' if p > 70 else '中性')
        vals.append((name, p, tag))
        print(f'{name:<8} {p:>5.1f}%  {tag}')
    except Exception as e:
        print(f'{name} 获取失败: {e}')
json.dump(cache, open(CACHE, 'w', encoding='utf-8'))

# ---------- 市场技术面（均线金叉/死叉 + 量能，只保留对周频基金组合有用的两个） ----------
print('\n===== 市场技术面（趋势 + 量能）=====')
TECH = []
for secid, name in IDX.items():
    ck = cache.get('idx:' + secid) or {}
    c, v = ck.get('c'), ck.get('v')
    if not c or len(c) < 60:
        continue
    ma20, ma60 = sum(c[-20:]) / 20, sum(c[-60:]) / 60
    cross = '金叉运行' if ma20 > ma60 else '死叉运行'
    pos = '线上' if c[-1] > ma20 else '线下'
    vr = v[-1] / (sum(v[-6:-1]) / 5) if v and len(v) > 6 else None
    vol_tag = ('放量' if vr > 1.2 else ('缩量' if vr < 0.8 else '量能平')) if vr else '-'
    TECH.append((name, pos, cross, vr, vol_tag))
    print(f'{name:<8} MA20{pos}  {cross}  量比 {vr:.2f} {vol_tag}' if vr else f'{name:<8} MA20{pos}  {cross}  无量能数据')
def build_html():
    mt = time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime('yjb-data.json')))
    rows_stat = stat.sort_values('w', ascending=False)
    tr_sec = ''.join(
        f"<tr><td>{n}</td><td>{pe}</td><td>{pb}</td>"
        f"<td class={'lo' if (p is not None and p < 30) else ('hi' if (p is not None and p > 70) else '')}>{p if p is not None else '-'}</td>"
        f"<td>{'PB' if is_pb(n) else 'PE'}</td><td>{theme}</td></tr>"
        for n, pe, pb, p, theme in SECTORS)
    # 主题动量（近3月加权）与四象限：估值分位=赔率 × 动量=胜率
    mom = {}
    for t, g in stat.groupby('theme'):
        sub = price[g.code.tolist()].dropna()
        if len(sub) > 61:
            wts = g.set_index('code').w
            mom[t] = float(((sub.iloc[-1] / sub.iloc[-61] - 1) * wts).sum() / wts.sum())
    secs_by_theme = {}
    for _n, _pe, _pb, _p, _t in SECTORS:
        if _p is not None:
            secs_by_theme.setdefault(_t, []).append(_p)
    sec_pct = {t: statistics.median(v) for t, v in secs_by_theme.items()}  # 主题含多板块时取中位数，避免被单一贵板块带偏

    def quadrant(t):
        p, m = sec_pct.get(t), mom.get(t)
        if p is None or m is None:
            return '-', '海外/债券无对应A股板块'
        if p > 70:
            return f'{p:.0f}%', ('高估+强动量：持有吃趋势，不添新钱' if m > 0 else '高估+弱动量：减仓候选')
        if p < 30:
            return f'{p:.0f}%', ('低估+转强：可分批加' if m > 0 else '低估+弱动量：小仓埋伏，等拐点')
        return f'{p:.0f}%', '中性：维持'
    def ev(code):
        e = EVAL.get(code) or {}
        try:
            avr = float(e['avr'])
        except Exception:
            return '-', ''
        detail = '，'.join(f'{k}{v:.0f}' for k, v in (e.get('detail') or {}).items()
                          if isinstance(v, (int, float)))
        return f'{avr:.0f}分', detail
    tr_funds = ''.join(
        f"<tr><td>{r.code}</td><td>{r.name}</td><td>{r.theme}</td><td>{r.money:.0f}</td>"
        f"<td>{r.w*100:.1f}%</td><td>{r.ann*100:+.1f}%</td><td>{r.mdd*100:.1f}%</td>"
        f"<td{f' title=\"{t2}\"' if (t2 := ev(r.code)[1]) else ''}>{ev(r.code)[0]}</td></tr>"
        for r in rows_stat.itertuples())
    tr_theme = ''.join(
        f"<tr><td>{t}</td><td>{g.money.sum():.0f}</td><td>{g.w.sum()*100:.1f}%</td>"
        f"<td><div class=bar style=width:{g.w.sum()*400:.0f}px></div></td>"
        f"<td>{(g.w*g.ann).sum()/g.w.sum()*100:+.1f}%</td>"
        f"<td>{(mom.get(t) or 0)*100:+.1f}%</td><td>{quadrant(t)[0]}</td><td>{quadrant(t)[1]}</td></tr>"
        for t, g in rows_stat.groupby('theme'))
    tr_val = ''.join(
        f"<tr><td>{n}</td><td class={'lo' if p < 30 else ('hi' if p > 70 else '')}>{p:.1f}%</td><td>{tag}</td></tr>"
        for n, p, tag in vals)
    tr_tech = ''.join(
        f"<tr><td>{n}</td><td>{pos}</td><td class={'lo' if cross == '金叉运行' else 'hi'}>{cross}</td>"
        f"<td>{f'{vr:.2f}' if vr else '-'}</td><td>{tag}</td></tr>"
        for n, pos, cross, vr, tag in TECH)
    pct = (curve / curve.iloc[0] - 1) * 100  # 累计收益%，起点归 0
    pts = pct.iloc[::max(1, len(pct)//200)]
    w, h, ml, mb = 760, 190, 48, 22
    lo, hi = min(pts.min(), 0.0), max(pts.max(), 0.0)
    X = lambda i: ml + i / (len(pts) - 1) * (w - ml - 8)
    Y = lambda v: (h - mb) - (v - lo) / (hi - lo + 1e-9) * (h - mb - 10)
    poly = ' '.join(f'{X(i):.0f},{Y(v):.0f}' for i, v in enumerate(pts))
    axis = (f'<line x1="{ml}" y1="{Y(0):.0f}" x2="{w-8}" y2="{Y(0):.0f}" stroke="#bbb" stroke-dasharray="4,3" />'
            f'<text x="2" y="{Y(hi)+4:.0f}" font-size="11" fill="#666">+{hi:.0f}%</text>'
            f'<text x="2" y="{Y(0)+4:.0f}" font-size="11" fill="#666">0%</text>'
            f'<text x="2" y="{Y(lo)+4:.0f}" font-size="11" fill="#666">{lo:.0f}%</text>'
            f'<text x="{ml}" y="{h-4}" font-size="11" fill="#666">{pts.index[0]:%y-%m-%d}</text>'
            f'<text x="{w-64}" y="{h-4}" font-size="11" fill="#666">{pts.index[-1]:%y-%m-%d}</text>')
    hover = json.dumps([[d.strftime('%Y-%m-%d'), round(v, 2)] for d, v in pts.items()])
    html = f'''<!doctype html><meta charset=utf-8><title>持仓看板</title>
<style>body{{font:14px/1.6 "Microsoft YaHei",sans-serif;margin:24px;color:#222}}
table{{border-collapse:collapse;margin:8px 0 20px}}td,th{{border:1px solid #ddd;padding:4px 10px}}
.bar{{height:10px;background:#4a90d9}}.lo{{color:#0a8f4d;font-weight:700}}.hi{{color:#d43a3a;font-weight:700}}
h2{{margin:24px 0 4px}}.cards span{{display:inline-block;margin-right:24px}}</style>
<h1>持仓看板 <small style="font-size:12px;color:#888">持仓更新 {mt} · 报告生成 {time.strftime('%Y-%m-%d %H:%M')}</small></h1>
<div class=cards><span>总资产 <b>{total:,.2f}</b> 元</span><span>近一年年化 <b>{port['年化收益']*100:+.1f}%</b></span><span>年化波动 <b>{port['年化波动']*100:.1f}%</b></span><span>最大回撤 <b>{port['近一年最大回撤']*100:.1f}%</b></span></div>
<h2>组合累计收益曲线（近一年 · 按当前权重模拟）</h2><div style="position:relative"><svg id="chart" width="{w}" height="{h}">{axis}<polyline fill="none" stroke="#4a90d9" stroke-width="2" points="{poly}" /><circle id="dot" r="3.5" fill="#d43a3a" style="display:none" /></svg><div id="tip" style="position:absolute;display:none;background:#333;color:#fff;padding:3px 8px;border-radius:4px;font-size:12px;pointer-events:none;white-space:nowrap"></div></div>
<p style=color:#888;font-size:12px>曲线 = 29 只持仓的每日收益按当前金额权重合成后逐日累乘，起点 0%；权重假设不变，代表“当前结构”近一年的表现。</p>
<h2>主题 × 估值 × 动量（四象限）</h2><table><tr><th>主题</th><th>金额</th><th>权重</th><th></th><th>加权年化</th><th>近3月动量</th><th>板块分位</th><th>象限动作</th></tr>{tr_theme}</table>
<p style=color:#888;font-size:12px>估值分位是赔率、动量是胜率：高估+强动量=景气在兑现（持有不追），低估+弱动量=可能是价值陷阱（只能埋伏）。加权年化 = 主题内各基金近一年年化按金额加权。</p>
<h2>指数估值分位（近5年价格分位）</h2><table><tr><th>指数</th><th>分位</th><th>信号</th></tr>{tr_val}</table>
<h2>市场技术面（趋势 + 量能）</h2><table><tr><th>指数</th><th>收盘 vs MA20</th><th>MA20×MA60</th><th>量比</th><th>量能</th></tr>{tr_tech}</table>
<p style=color:#888;font-size:12px>金叉=短均线上穿长均线（趋势转强），死叉相反；量比=当日量÷前5日均量，&gt;1.2 放量、&lt;0.8 缩量。仅作执行时点参考（如定投扣款周），不作买卖依据；KDJ/RSI/BOLL 等日线超买超卖指标对周频基金组合是噪音，未纳入。</p>
<h2>板块估值（PE 横截面分位）</h2><table><tr><th>板块</th><th>PE(动)</th><th>PB</th><th>PE分位</th><th>建议看</th><th>关联主题</th></tr>{tr_sec}</table>
<p style=color:#888;font-size:12px>板块分位 = 该板块 PE 在全部 496 个行业板块中的相对位置（越低越便宜）；东财拒查板块历史 K 线，故无 5 年分位口径。分位是赔率参考，非买卖信号：高估值+强动量说明景气在兑现，低估值+弱动量可能是价值陷阱，需结合趋势与仓位角色判断。</p>
<h2>持仓明细（{len(rows_stat)} 只）</h2><table><tr><th>代码</th><th>名称</th><th>主题</th><th>金额</th><th>权重</th><th>近一年</th><th>最大回撤</th><th>机构评价</th></tr>{tr_funds}</table>
<p style=color:#888;font-size:12px>评分为天天基金五维打分（0-100 综合分，悬停看明细：选证能力/收益率/抗风险/业绩稳定性/规模性价比），替代蚂蚁智库（无公开接口）。</p>
<p style=color:#999>数据辅助分析，不构成投资建议。</p>'''
    js = """<script>
const PTS=__PTS__,X0=__X0__,XW=__XW__,Y0=__Y0__,YS=__YS__,LO=__LO__,HI=__HI__;
const svg=document.getElementById('chart'),tip=document.getElementById('tip'),dot=document.getElementById('dot');
svg.addEventListener('mousemove',e=>{
  const r=svg.getBoundingClientRect(),x=e.clientX-r.left;
  const i=Math.max(0,Math.min(PTS.length-1,Math.round((x-X0)/XW*(PTS.length-1))));
  const [d,v]=PTS[i],px=X0+i/(PTS.length-1)*XW,cy=Y0-(v-LO)/(HI-LO)*YS;
  dot.setAttribute('cx',px);dot.setAttribute('cy',cy);dot.style.display='';
  tip.textContent=d+'  '+(v>0?'+':'')+v.toFixed(2)+'%';
  tip.style.display='block';tip.style.left=Math.min(px+12,r.width-150)+'px';tip.style.top=Math.max(0,cy-36)+'px';
});
svg.addEventListener('mouseleave',()=>{tip.style.display='none';dot.style.display='none';});
</script>"""
    js = (js.replace('__PTS__', hover).replace('__X0__', str(ml)).replace('__XW__', str(w-ml-8))
             .replace('__Y0__', str(h-mb)).replace('__YS__', str(h-mb-10))
             .replace('__LO__', str(lo)).replace('__HI__', str(hi)))
    html += js
    open('持仓看板.html', 'w', encoding='utf-8').write(html)
    print('\n看板已生成: 持仓看板.html')


build_html()
