// diff.js — 差分計算だけを行う純粋なモジュール（DOM には一切触れない）。
//
// 方針:
// - 行単位の差分は Myers の O(ND) アルゴリズムを自前実装。
// - 色の約束: 薄い色 =「この行に変更がある」、濃い色 =「変わった中身そのもの」。
//   薄い色の付いた行には必ず濃い部分（または挿入位置マーカー）が1つ以上ある（不変条件）。
// - 変更ブロック内の削除行と追加行は「位置」ではなく「似ている度合い」で組にする。
//   位置で組にすると、1行消えただけで以降の行が全部ずれて無関係な行同士が並び、
//   強調のない薄い色の行が生まれてしまうため（v1 の問題）。
//   似ていない行は組にせず、行全体を濃い色にする（丸ごと削除/追加された行）。
// - 組になった行は「単語（トークン）単位」の Myers 差分をとる。1文字単位だと
//   偶然一致した文字で強調が細切れになるため。漢字・かなは1文字ずつ、英数字は語ごと。
// - 片側にだけ文字が増えた/消えた場合、もう片側にはその位置に細い縦線（挿入位置マーカー）を出す。
// - フリーズ防止: 入力サイズ上限（MAX_CHARS）、編集距離上限（MAX_D）、
//   計算量上限（MAX_WORK）を設け、超えたら粗い結果（ブロック全体を削除→追加）に切り替える。
//   行の組み合わせ・行内差分にも上限があり、超えたら簡易な方法に切り替える。
// - 入力文字列はどこにも保存・送信しない（このファイルは計算して返すだけ）。

/** これを超える文字数の入力は計算しない（DoS 対策を兼ねる） */
export const MAX_CHARS = 500000;

const MAX_D = 2000;          // 行差分で許す最大編集距離
const MAX_WORK = 50000000;   // 行差分の計算ステップ上限
const CHAR_MAX_LEN = 3000;   // 1組の行（左右合計）でこれを超えたら行内強調をあきらめる
const CHAR_MAX_D = 400;      // 行内（トークン）差分の最大編集距離
const CHAR_BUDGET = 400000;  // 1回の差分計算全体で行内差分に使う文字数の上限
const PAIR_MIN = 0.5;        // 行を組にする類似度（Dice 係数）の下限
const PAIR_MAX_CELLS = 40000; // 削除行数×追加行数がこれを超えたら類似度での組み合わせをやめる（200×200）
const SIM_BUDGET = 3000000;  // 類似度計算に使う文字数の上限。超えたら位置で組にする

// 行内差分のトークン: 英数字などの連続は1語、漢字・ひらがな・カタカナは1文字ずつ、
// 空白の連続は1つ、それ以外の記号は1文字ずつ（コードポイント単位なので絵文字も壊さない）
const TOKEN_RE = /(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{M}\p{N}_])+|\s+|[\s\S]/gu;

/**
 * 2つのテキストの差分を計算する。
 * 戻り値:
 *  { status: 'too-large' }                       … どちらかが MAX_CHARS 超
 *  { status: 'empty' | 'one-empty' }             … 入力が空
 *  { status: 'same', lines:[text] }              … 完全一致（lines は表示用の全行）
 *  { status: 'diff', blocks, added, removed, coarse, maxLine }
 *    blocks: [{ type:'equal', aStart, bStart, lines:[text] }
 *           | { type:'change', del:[Line], add:[Line], rows:[{ del: Line|null, add: Line|null }] }]
 *    Line: { no: 行番号(1始まり), text, segs: [{ text, changed, marker? }] }
 *      segs をつなげると text に戻る。changed=true が濃い色の部分。
 *      marker=true は幅0の「ここに文字が足された/消された」位置（text は ''）。
 *      変更ブロック内の行は必ず changed な seg を1つ以上持つ。
 *    rows: 左右表示用の並び。組になった行は同じ行に、組にならない行は空いている側と並べる。
 *    added / removed: 追加行数・削除行数（行単位）。
 */
export function computeDiff(textA, textB) {
  if (textA.length > MAX_CHARS || textB.length > MAX_CHARS) return { status: 'too-large' };
  if (textA === '' && textB === '') return { status: 'empty' };
  if (textA === '' || textB === '') return { status: 'one-empty' };

  const a = splitLines(textA);
  const b = splitLines(textB);
  // 完全一致でも本文は表示したいので、行の配列を一緒に返す
  if (a.length === b.length && a.every((l, i) => l === b[i])) return { status: 'same', lines: a };

  // 行を整数 ID に変換して比較を高速化する
  const ids = new Map();
  const toIds = (lines) => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      let id = ids.get(lines[i]);
      if (id === undefined) { id = ids.size; ids.set(lines[i], id); }
      out[i] = id;
    }
    return out;
  };
  const ops = diffSeq(toIds(a), toIds(b), MAX_D, MAX_WORK);

  const blocks = [];
  let added = 0, removed = 0;
  let ai = 0, bi = 0;
  let del = [], add = [];
  const budget = { left: CHAR_BUDGET };
  const flush = () => {
    if (del.length || add.length) {
      const rows = pairBlock(del, add, budget);
      blocks.push({ type: 'change', del, add, rows });
      del = []; add = [];
    }
  };
  for (const op of ops.list) {
    if (op === 0) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'equal') last.lines.push(a[ai]);
      else blocks.push({ type: 'equal', aStart: ai + 1, bStart: bi + 1, lines: [a[ai]] });
      ai++; bi++;
    } else if (op === -1) {
      del.push({ no: ai + 1, text: a[ai], segs: null }); ai++; removed++;
    } else {
      add.push({ no: bi + 1, text: b[bi], segs: null }); bi++; added++;
    }
  }
  flush();
  return { status: 'diff', blocks, added, removed, coarse: ops.coarse, maxLine: Math.max(a.length, b.length) };
}

/** 改行で分割（CRLF/CR は LF に正規化、末尾の改行1つは無視） */
function splitLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 汎用の系列差分（Myers O(ND)）。a, b は === で比較できる要素の配列。
 * 戻り値 { list, coarse }: list は 0=一致, -1=削除(a側), 1=追加(b側) の並び。
 * 編集距離が maxD を超えるか計算量が maxWork を超えたら、
 * 共通の先頭・末尾以外をまとめて「全削除→全追加」にした粗い結果を返す。
 */
export function diffSeq(a, b, maxD, maxWork) {
  const n0 = a.length, m0 = b.length;
  // 共通の先頭・末尾を先に取り除く（よくあるケースを高速化）
  let pre = 0;
  while (pre < n0 && pre < m0 && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n0 - pre && suf < m0 - pre && a[n0 - 1 - suf] === b[m0 - 1 - suf]) suf++;
  const n = n0 - pre - suf, m = m0 - pre - suf;

  const list = [];
  for (let i = 0; i < pre; i++) list.push(0);
  let coarse = false;
  const mid = myers(a, b, pre, n, m, maxD, maxWork);
  if (mid) {
    for (const op of mid) list.push(op);
  } else {
    coarse = true;
    for (let i = 0; i < n; i++) list.push(-1);
    for (let i = 0; i < m; i++) list.push(1);
  }
  for (let i = 0; i < suf; i++) list.push(0);
  return { list, coarse };
}

/** Myers 本体。上限超過時は null。a[off..off+n) と b[off..off+m) を比較する。 */
function myers(a, b, off, n, m, maxD, maxWork) {
  if (n === 0 || m === 0) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(-1);
    for (let i = 0; i < m; i++) out.push(1);
    return out;
  }
  const max = n + m;
  const limit = Math.min(max, maxD);
  const v = new Int32Array(2 * max + 3);
  const base = max + 1;
  const snaps = []; // snaps[d] = 各 d の後の v[-d..d]（逆順たどり用）
  let work = 0;
  let found = -1;

  outer:
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[base + k - 1] < v[base + k + 1])) x = v[base + k + 1];
      else x = v[base + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[off + x] === b[off + y]) { x++; y++; work++; }
      v[base + k] = x;
      work++;
      if (x >= n && y >= m) {
        snaps.push(v.slice(base - d, base + d + 1));
        found = d;
        break outer;
      }
    }
    snaps.push(v.slice(base - d, base + d + 1));
    if (work > maxWork) return null;
  }
  if (found < 0) return null;

  // 逆順にたどって編集操作を復元する
  const rev = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = snaps[d - 1];
    const get = (k) => prev[k + d - 1];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && get(k - 1) < get(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { rev.push(0); x--; y--; }
    rev.push(prevK === k + 1 ? 1 : -1);
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { rev.push(0); x--; y--; }
  rev.reverse();
  return rev;
}


/** 行全体を変更扱いにする segs（空行は見えるようにマーカーにする） */
function wholeLine(text) {
  return text === '' ? [{ text: '', changed: true, marker: true }] : [{ text, changed: true }];
}

/** 文字（コードポイント）ごとの出現数 */
function charCounts(text) {
  const m = new Map();
  for (const ch of text) m.set(ch, (m.get(ch) || 0) + 1);
  return m;
}

/** 多重集合の Dice 係数 = 2·共通文字数 / (長さA + 長さB)。0〜1 */
function dice(ca, la, cb, lb) {
  let common = 0;
  const [small, big] = ca.size <= cb.size ? [ca, cb] : [cb, ca];
  for (const [ch, n] of small) {
    const k = big.get(ch);
    if (k) common += Math.min(n, k);
  }
  return (2 * common) / (la + lb);
}

/**
 * 変更ブロック内の削除行 del と追加行 add を「似ている行同士」で組にし、
 * 各行の segs を埋めて、左右表示用の rows を返す。
 * 手順:
 *  1. 各組の類似度（Dice 係数）を計算し、PAIR_MIN 以上の組だけを候補にする。
 *  2. 順序を保ったまま類似度の合計が最大になる組み合わせを DP（重み付き LCS）で選ぶ。
 *  3. 選んだ組で行内差分をとり、共通部分が少なすぎるものは組をやめる。
 *  4. 組と組の間に削除1行・追加1行だけが残った場合は、その2行で行内差分を試す
 *     （短い行で1語だけ変わった場合など、類似度は低くても対応が明らかなため）。
 * ブロックが大きすぎる場合（PAIR_MAX_CELLS / SIM_BUDGET 超）は位置で組にする（同じく 3 で検証）。
 */
function pairBlock(del, add, budget) {
  const nd = del.length, na = add.length;
  let cand = [];

  if (nd > 0 && na > 0) {
    let sumD = 0, sumA = 0;
    for (const l of del) sumD += l.text.length;
    for (const l of add) sumA += l.text.length;
    if (nd * na > PAIR_MAX_CELLS || na * sumD + nd * sumA > SIM_BUDGET) {
      // 大きすぎるブロック: 位置で組にする（フリーズ防止）
      for (let i = 0; i < Math.min(nd, na); i++) cand.push([i, i]);
    } else {
      cand = similarPairs(del, add);
    }
  }

  // 候補の組を行内差分で検証する
  const pairs = [];
  for (const [i, j] of cand) {
    if (tryPair(del[i], add[j], budget)) pairs.push([i, j]);
  }

  // 組と組の間に 1行対1行 だけ残った箇所を試す
  const filled = [];
  let pd = 0, pa = 0;
  for (const p of [...pairs, [nd, na]]) {
    if (p[0] - pd === 1 && p[1] - pa === 1 && tryPair(del[pd], add[pa], budget)) filled.push([pd, pa]);
    if (p[0] < nd) filled.push(p);
    pd = p[0] + 1; pa = p[1] + 1;
  }

  // 組にならなかった行は行全体を変更扱いにする
  for (const l of del) if (!l.segs) l.segs = wholeLine(l.text);
  for (const l of add) if (!l.segs) l.segs = wholeLine(l.text);

  // rows を作る: 組の間の余り行は左右に並べ（どちらも行全体が濃い色なので誤解はない）、組は同じ行に置く
  const rows = [];
  pd = 0; pa = 0;
  for (const p of [...filled, [nd, na]]) {
    const gd = p[0] - pd, ga = p[1] - pa;
    for (let k = 0; k < Math.max(gd, ga); k++) {
      rows.push({ del: k < gd ? del[pd + k] : null, add: k < ga ? add[pa + k] : null });
    }
    if (p[0] < nd) rows.push({ del: del[p[0]], add: add[p[1]] });
    pd = p[0] + 1; pa = p[1] + 1;
  }
  return rows;
}

/** 類似度が PAIR_MIN 以上の組から、順序を保って合計類似度が最大になる組み合わせを選ぶ */
function similarPairs(del, add) {
  const nd = del.length, na = add.length;
  const prep = (l) => (l.text.length > CHAR_MAX_LEN ? null : { c: charCounts(l.text), n: l.text.length });
  const pD = del.map(prep), pA = add.map(prep);
  const W = na + 1;
  const score = new Float64Array(nd * na);
  for (let i = 0; i < nd; i++) {
    const a = pD[i];
    if (!a) continue;
    for (let j = 0; j < na; j++) {
      const b = pA[j];
      if (!b || a.n + b.n === 0) continue;
      if (del[i].text === add[j].text) continue; // 同じ行は組にしない（粗い結果のとき起こりうる）
      if ((2 * Math.min(a.n, b.n)) / (a.n + b.n) < PAIR_MIN) continue; // 長さだけで足りないものは省く
      const s = dice(a.c, a.n, b.c, b.n);
      if (s >= PAIR_MIN) score[i * na + j] = s;
    }
  }
  // dp[i][j] = del[0..i) と add[0..j) で得られる最大の合計類似度
  const dp = new Float64Array((nd + 1) * W);
  for (let i = 1; i <= nd; i++) {
    for (let j = 1; j <= na; j++) {
      let best = Math.max(dp[(i - 1) * W + j], dp[i * W + j - 1]);
      const s = score[(i - 1) * na + (j - 1)];
      if (s > 0) best = Math.max(best, dp[(i - 1) * W + j - 1] + s);
      dp[i * W + j] = best;
    }
  }
  const out = [];
  let i = nd, j = na;
  while (i > 0 && j > 0) {
    const s = score[(i - 1) * na + (j - 1)];
    if (s > 0 && dp[i * W + j] === dp[(i - 1) * W + j - 1] + s) { out.push([i - 1, j - 1]); i--; j--; }
    else if (dp[i * W + j] === dp[(i - 1) * W + j]) i--;
    else j--;
  }
  return out.reverse();
}

/** 2行に行内差分を付けられたら segs を設定して true（予算・長さの上限つき） */
function tryPair(d, a, budget) {
  if (d.segs || a.segs || d.text === a.text) return false;
  const len = d.text.length + a.text.length;
  if (len === 0 || len > CHAR_MAX_LEN || budget.left < len) return false;
  budget.left -= len;
  const res = inlineDiff(d.text, a.text);
  if (!res) return false;
  d.segs = res.del; a.segs = res.add;
  return true;
}

/**
 * 1組の行の行内差分（トークン単位）。
 * 戻り値 { del:[seg], add:[seg] } または null（共通部分が少なく、強調がノイズになる場合）。
 * 例: 「東京都港区」→「東京都渋谷区」 = 港 が削除、渋谷 が追加。
 *     「host=localhost」→「host=127.0.0.1」 = localhost と 127.0.0.1 が語ごと強調される。
 *     「abc」→「abcdef」 = 左は abc の後ろにマーカー、右は def が追加。
 */
export function inlineDiff(textA, textB) {
  const ta = textA.match(TOKEN_RE) || [];
  const tb = textB.match(TOKEN_RE) || [];
  const res = diffSeq(ta, tb, CHAR_MAX_D, CHAR_MAX_D * (ta.length + tb.length + 1));
  if (res.coarse) return null;

  // ラン（一致区間 / 変更区間）にまとめる。変更区間は削除側 a と追加側 b の文字列を持つ
  let runs = [];
  let i = 0, j = 0;
  for (const op of res.list) {
    const eq = op === 0;
    let last = runs[runs.length - 1];
    if (!last || last.eq !== eq) { last = { eq, a: '', b: '' }; runs.push(last); }
    if (op === 0) { last.a += ta[i++]; last.b += tb[j++]; }
    else if (op === -1) last.a += ta[i++];
    else last.b += tb[j++];
  }

  // 細切れ防止: 変更に挟まれた短い一致（2文字以下で両隣の変更より短い）は変更に含める
  const size = (r) => Math.max(r.a.length, r.b.length);
  const merged = [];
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    const prev = merged[merged.length - 1];
    const next = runs[k + 1];
    if (r.eq && prev && !prev.eq && next && !next.eq &&
        r.a.length <= 2 && r.a.length < size(prev) && r.a.length < size(next)) {
      prev.a += r.a + next.a; prev.b += r.b + next.b;
      k++;
      continue;
    }
    merged.push({ ...r });
  }
  runs = merged;

  // 1語の中で前後に足しただけ（abc → abcdef など）は、共通部分を一致として切り出す
  const refined = [];
  for (const r of runs) {
    if (!r.eq && r.a && r.b && r.a !== r.b) {
      const [short, long, shortIsA] = r.a.length < r.b.length ? [r.a, r.b, true] : [r.b, r.a, false];
      const rest = long.length - short.length;
      const ins = (s) => (shortIsA ? { eq: false, a: '', b: s } : { eq: false, a: s, b: '' });
      if (long.startsWith(short)) { refined.push({ eq: true, a: short, b: short }, ins(long.slice(short.length))); continue; }
      if (long.endsWith(short)) { refined.push(ins(long.slice(0, rest)), { eq: true, a: short, b: short }); continue; }
    }
    refined.push(r);
  }
  // 隣り合う同種のランを結合する
  runs = [];
  for (const r of refined) {
    const last = runs[runs.length - 1];
    if (last && last.eq === r.eq) { last.a += r.a; last.b += r.b; }
    else runs.push({ ...r });
  }

  // 共通部分が少なすぎる組は強調がノイズになるので採用しない。
  // 基本は「短い方の行の半分以上が一致」。変更箇所が1か所だけなら 1/4 以上で採用する
  // （1語だけ置き換えた短い行を、行全体の強調ではなく語の強調で見せるため）。
  let common = 0, changes = 0;
  for (const r of runs) { if (r.eq) common += r.a.length; else changes++; }
  const shorter = Math.min(textA.length, textB.length);
  if (changes === 0 || common === 0) return null;
  if (common < shorter * 0.5 && !(changes === 1 && common >= shorter * 0.25)) return null;

  const del = [], add = [];
  const push = (arr, text, changed) => {
    if (text === '') {
      // この側には何もない変更 = もう片側で足された/消された位置にマーカーを置く
      if (changed) arr.push({ text: '', changed: true, marker: true });
      return;
    }
    const last = arr[arr.length - 1];
    if (last && !last.marker && last.changed === changed) last.text += text;
    else arr.push({ text, changed });
  };
  for (const r of runs) { push(del, r.a, !r.eq); push(add, r.b, !r.eq); }
  return { del, add };
}
