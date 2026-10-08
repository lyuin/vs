// app.js — 画面の動作。
//
// 流れ: ページを開くと左の欄に自動でフォーカス → 貼り付け → 右の欄をクリック/Tab → 貼り付け
//       → 下に差分が即表示（入力欄は自動で縮み、差分が画面の大半を使う）。
//       どちらかを編集すると少し待って（デバウンス）自動で再計算する。
//       クリア後5秒間は「Undo」で両方の文字列を戻せる（メモリ上だけで保持）。
//
// 表示の約束:
//  - 同じ行も含めて全行を常に表示する（折りたたまない）。全体をひと目で見渡せることを優先する。
//  - 広い画面は左右に並べて表示、狭い画面（640px 未満）は自動で1列表示（切替ボタンはない）。
//  - 左 = 赤、右 = 緑（古い/新しいとは決めない）。件数は違う行の数だけを中立に出す（赤/緑の色は付けない）。
//    入力欄の上端の帯・列見出しの帯・ルーラーで同じ色を使う。
//  - 画面の文言は英語のみ（短く、言語に依らず使える見た目にする）。
//  - 見出しは 左 = 読むだけの情報、右 = 操作（ボタン）。
//
// 変更間の移動（v1.3）:
//  - 「変更」= 色の付いた行が続くひとかたまり（diff.js の change ブロック1つ）。
//  - 次/前の変更へ移ると、その先頭の行が差分欄の上から約1/5の位置に来るようにスクロールする
//    （素早いアニメーション。動きを減らす設定なら一瞬で）。移動先はルーラーの印を短く太くし、行の左端に線を出す。
//  - 「いまどの変更にいるか」を覚えておく。ただし手でスクロールした後は、表示位置から次/前を決め直す。
//  - キー: 差分欄を選択中は ↓/↑ = 次/前の変更、⌘↓/⌘↑（Mac 以外は Ctrl）= 末尾/先頭。
//    F7 / Shift+F7 はどこでも次/前（入力欄の中でも。ただし日本語入力の変換中は変換に使うので奪わない）。
//    入力欄の中の矢印キーは普通のカーソル移動のまま（奪わない）。
//
// フォーカスとキー（v1.3.2）:
//  - Tab = 左の欄 → 右の欄 → 差分欄 → 左の欄…と循環（Shift+Tab は逆順）。ボタンには寄り道しない。
//  - Esc = ヘルプが開いていれば閉じる（直前にいた場所へ戻る）/ 入力欄なら差分欄へ移る /
//    差分欄なら両方をクリア（Clear ボタンと同じ。Undo が5秒出る。両方とも空なら何もしない）。
//  - ? = ヘルプの開閉（入力欄の中では普通に ? を入力する）。
//  - どのキーも、日本語入力の変換中は変換に使うので奪わない。
//
// セキュリティ上の約束（変更するときも必ず守ること）:
//  - 入力テキストを保存しない: localStorage / sessionStorage / IndexedDB / Cookie / Cache API を使わない。
//  - 入力テキストを持ち越さない（v1.3.3）: 開いたとき・離れるとき（pagehide）・「戻る」で bfcache から
//    戻ったとき（pageshow の persisted）に両方の欄を空にする（末尾の wipe）。ブラウザのタブ復元が
//    前回の入力を戻しても使わない。ブラウザ自身がクラッシュ復元用に持つ写しは、このページからは制御できない。
//  - 入力テキストを送信しない: fetch / XHR / WebSocket / sendBeacon などを使わない（CSP でも禁止）。
//  - クリップボード読み取り API は使わない（貼り付けはブラウザ標準の動作に任せる）。
//  - ユーザーの文字列は textContent / createTextNode / replaceChildren でのみ描画する。
//    innerHTML / outerHTML / insertAdjacentHTML / document.write / eval は使わない
//    （CSP の Trusted Types 'none' により、使うとブラウザがエラーにする）。
//  - setTimeout には必ず関数を渡す（文字列は渡さない）。

import { computeDiff, MAX_CHARS, MAX_LINES } from './diff.js';

const DEBOUNCE_MS = 120;
const CHUNK = 100;       // 行をこの数ずつ1つの塊（div.chunk）にまとめる
const LARGE = 2000;      // 行数がこれを超えたら、画面外の塊の描画を省く（CSS の content-visibility）
const MARK_MIN = 2;      // ルーラーの印の最小の高さ（px）
const VIEW_MIN = 8;      // ルーラーの「見えている範囲」の枠の最小の高さ（px）
// 狭い画面の判定（style.css の @media と同じ値にすること）
const narrowMq = window.matchMedia('(max-width: 639.98px)');

// ---- 文言（英語のみ） ----
const TEXT = {
  empty: 'Paste text into both boxes to see the diff.',
  // 両方とも空のときだけ、上の文の下に小さく出す安全性の一言（v1.3.1）。
  // 「ブラウザの中だけで動く」= CSP の default-src 'none' + script-src 'self'（外部のコードを読まない）、
  // 「送らない」= connect-src 'none' と form-action 'none'（通信もフォーム送信もブラウザが止める）、
  // 「保存しない」= 保存系の API（localStorage / Cookie など）を一切使わない、に対応する
  privacy: 'Runs entirely in your browser. Nothing is sent or saved.',
  oneEmpty: 'Now paste into the other box.',
  same: 'No differences',
  tooLarge: `Too large to compare (limit: ${MAX_CHARS.toLocaleString('en')} characters or ${MAX_LINES.toLocaleString('en')} lines).`,
  coarse: 'Large diff: part of it is shown in a simplified form.',
  // 件数は「追加/削除」ではなく、違う行の数だけを中立に言う
  differ: (n) => (n === 1 ? '1 line differs' : `${n} lines differ`),
  cleared: 'Cleared. Undo is available for 5 seconds.',
  restored: 'Restored',
};

const $ = (id) => document.getElementById(id);
const textA = $('text-a');
const textB = $('text-b');
const statusEl = $('status');
const diffEl = $('diff');
const scroller = $('scroller');
const rulerEl = $('ruler');
const rulerMarks = $('ruler-marks');
const rulerView = $('ruler-view');
const countsEl = $('counts');

let result = null;

// ---- 差分の計算（デバウンス付き） ----
let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(update, DEBOUNCE_MS);
}
function update() {
  clearTimeout(timer);
  timer = 0;
  result = computeDiff(textA.value, textB.value);
  render();
}

// ---- 描画 ----
// sub … 2行目の小さな補足（空の状態の安全性の一言だけで使う）。文字列は textContent でのみ入れる
function setStatus(text, kind, sub) {
  statusEl.textContent = text;
  if (sub) statusEl.append(el('span', 'status-sub', sub));
  statusEl.className = kind ? `status is-${kind}` : 'status';
}

// ルーラー用に、描画した行の情報を持っておく（行の要素・塊・削除/追加の有無）
let rowEls = [];
let chunkEls = [];
let runs = [];          // [{ lane: 'del' | 'add', from, to }]（行番号ではなく rowEls の添字）
let hunks = [];         // 変更のかたまり [{ from, to }]（rowEls の添字。移動ボタンに使う）
let large = false;

function render() {
  resetNav();
  hunks = [];
  const r = result || { status: 'empty' };
  // 違う行の数 = 左右表示で色の付く行の数（diff.js の rows の数。組になった行は1行と数える）。
  // 画面の表示方式（左右 / 1列）に関係なく同じ数にするため、DOM ではなく計算結果から数える。
  // 完全一致のときは「No differences」、空・片方だけ空・大きすぎるときは何も出さない
  const same = r.status === 'same';
  let differ = 0;
  if (r.status === 'diff') for (const b of r.blocks) if (b.type === 'change') differ += b.rows.length;
  countsEl.textContent = same ? TEXT.same : r.status === 'diff' ? TEXT.differ(differ) : '';

  rowEls = [];
  chunkEls = [];
  runs = [];
  diffEl.replaceChildren();
  switch (r.status) {
    case 'empty': setStatus(TEXT.empty, 'empty', TEXT.privacy); requestRuler(true); updateNav(); return;
    case 'one-empty': setStatus(TEXT.oneEmpty, 'empty'); requestRuler(true); updateNav(); return;
    case 'too-large': setStatus(TEXT.tooLarge, 'warn'); requestRuler(true); updateNav(); return;
  }
  setStatus(r.coarse ? TEXT.coarse : '', r.coarse ? 'note' : '');

  const split = !narrowMq.matches;
  diffEl.className = `diff ${split ? 'split' : 'single'}`;
  diffEl.style.setProperty('--nw', `${String(same ? r.lines.length : r.maxLine).length + 2}ch`);

  // 1行ごとに「削除を含むか / 追加を含むか」を記録する（ルーラーの印に使う）
  const del = [];
  const add = [];
  const push = (row, d, a) => { rowEls.push(row); del.push(d); add.push(a); };
  if (same) {
    r.lines.forEach((text, i) => push(equalRow(text, i + 1, i + 1, split), false, false));
  } else {
    for (const b of r.blocks) {
      if (b.type === 'equal') {
        b.lines.forEach((text, i) => push(equalRow(text, b.aStart + i, b.bStart + i, split), false, false));
      } else {
        // 変更ブロック1つ = 移動の単位（左右表示でも1列表示でも行は連続して並ぶ）
        const from = rowEls.length;
        if (split) {
          // diff.js が似ている行同士を同じ行（rows）にまとめてある
          for (const { del: d, add: a } of b.rows) push(splitChangeRow(d, a), !!d, !!a);
        } else {
          for (const d of b.del) push(singleChangeRow(d, 'del'), true, false);
          for (const a of b.add) push(singleChangeRow(a, 'add'), false, true);
        }
        hunks.push({ from, to: rowEls.length - 1 });
      }
    }
  }

  // 行を塊にまとめて一度に DOM へ入れる（レイアウトの読み取りはここでは一切しない）
  const frag = document.createDocumentFragment();
  if (split) frag.append(columnHeads());
  for (let i = 0; i < rowEls.length; i += CHUNK) {
    const chunk = el('div', 'chunk');
    const part = rowEls.slice(i, i + CHUNK);
    chunk.append(...part);
    // 最後の塊は行数が少ないので、描画を省いたときの仮の高さを行数に合わせる
    if (part.length < CHUNK) chunk.style.setProperty('--rows', String(part.length));
    chunkEls.push(chunk);
    frag.append(chunk);
  }
  large = rowEls.length > LARGE;
  diffEl.classList.toggle('is-large', large);
  diffEl.replaceChildren(frag);

  // 削除/追加が続く範囲（ラン）を求める
  for (const [lane, flags] of [['del', del], ['add', add]]) {
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) continue;
      const from = i;
      while (i + 1 < flags.length && flags[i + 1]) i++;
      runs.push({ lane, from, to: i });
    }
  }
  // ルーラーと移動ボタンの状態は次のフレームで更新する（描画処理の中でレイアウトを読まないため）。
  // スクロール位置は保つ（編集のたびに先頭へ戻らないように）
  requestRuler(true);
}

// 要素生成の小さなヘルパー（文字列は必ず textContent で入れる）
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// 左右表示の列見出し: 文字のない色の帯だけ（左の列 = 赤、右の列 = 緑。入力欄の上端の帯と同じ色）。
// 飾りなので読み上げでは省く（各行の記号セルの − / + で左右はわかる）。
// 1列表示（狭い画面）では出さない: 1列の中に赤い行と緑の行が交互に並ぶため、列全体に1色の帯を付けると
// 「この列は全部その側」と誤解させる。中立の色の帯も意味を持たないので置かない。
function columnHeads() {
  const h = el('div', 'cols');
  h.setAttribute('aria-hidden', 'true');
  h.append(el('div', 'col pane-del'), el('div', 'col pane-add'));
  return h;
}

// 本文セル。変わった部分は <mark> で濃く、片側だけで足された/消された位置には細い縦線（.ins-point）を出す。
// 変わった部分の中の空白と、変更行の行末の空白は、見える印にする（appendVisible）。
// 例: 左「東京　都」右「東京 都」→ 左の強調の中に四角、右の強調の中に中黒が出る
// （空白だけが違う行でも、強調が「何もない色の帯」にならない）。
function codeCell(line, kind) {
  const c = el('div', `code ${kind}`);
  const segs = line.segs || [{ text: line.text, changed: false }];
  // 行末の空白が始まる位置（この位置以降の空白は、変わっていない部分でも薄い印を付ける）。
  // 正規表現 /\s+$/ は空白の多い長い行で極端に遅くなるため、末尾から1文字ずつ数える
  let tail = line.text.length;
  while (tail > 0 && /\s/u.test(line.text[tail - 1])) tail--;
  let pos = 0;
  for (const s of segs) {
    if (s.marker) {
      const m = el('span', 'ins-point');
      m.setAttribute('aria-hidden', 'true');
      c.append(m);
      continue;
    }
    if (s.changed) {
      const m = el('mark');
      appendVisible(m, s.text, '');
      c.append(m);
    } else {
      // 変わっていない部分は行末の空白だけ印を付け、それ以外は文字のまま
      const cut = Math.max(0, Math.min(s.text.length, tail - pos));
      if (cut > 0) c.append(document.createTextNode(s.text.slice(0, cut)));
      if (cut < s.text.length) appendVisible(c, s.text.slice(cut), ' ws-tail');
    }
    pos += s.text.length;
  }
  return c;
}

// 空白を見える印付きで追加する。本物の文字は span の中に残す（幅とコピー結果を保つ。印は CSS の飾り）。
// 改行はここには来ない（行ごとに分けてある）
const WS_RE = /\s/gu;
function appendVisible(parent, text, extra) {
  let last = 0;
  for (const m of text.matchAll(WS_RE)) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const ch = m[0];
    const kind = ch === '\t' ? 'ws-tab' : ch === '\u3000' ? 'ws-ideo' : 'ws-sp';
    parent.append(el('span', `ws ${kind}${extra}`, ch));
    last = m.index + ch.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function splitChangeRow(d, a) {
  const row = el('div', 'row');
  if (d) row.append(el('div', 'no del', String(d.no)), el('div', 'sign del', '−'), codeCell(d, 'del'));
  else row.append(el('div', 'no void'), el('div', 'sign void'), el('div', 'code void'));
  if (a) row.append(el('div', 'no add', String(a.no)), el('div', 'sign add', '+'), codeCell(a, 'add'));
  else row.append(el('div', 'no void'), el('div', 'sign void'), el('div', 'code void'));
  return row;
}

function singleChangeRow(line, kind) {
  const row = el('div', 'row');
  if (kind === 'del') row.append(el('div', 'no del', String(line.no)), el('div', 'no del'));
  else row.append(el('div', 'no add'), el('div', 'no add', String(line.no)));
  row.append(el('div', `sign ${kind}`, kind === 'del' ? '−' : '+'), codeCell(line, kind));
  return row;
}

function equalRow(text, noA, noB, split) {
  const row = el('div', 'row');
  if (split) {
    row.append(el('div', 'no', String(noA)), el('div', 'sign'), el('div', 'code', text),
      el('div', 'no', String(noB)), el('div', 'sign'), el('div', 'code', text));
  } else {
    row.append(el('div', 'no', String(noA)), el('div', 'no', String(noB)), el('div', 'sign'), el('div', 'code', text));
  }
  return row;
}

// ---- 概要ルーラー（VS Code の差分の概要ルーラーに相当） ----
// ルーラーの高さ = 差分全体（scroller の scrollHeight）。各ランの縦位置をその比率で縮めて印を置く。
// 行の位置は、通常は行の要素から読む（正確）。行数が多い（large）ときは画面外の塊の描画を省いているため、
// 塊の位置と高さから比例で求める（塊の中で行の高さがそろっている前提の近似。塊は100行なので誤差は小さい）。
// 狭い画面ではルーラーを出さない（style.css 参照）。そのときは何もしない。
function rowSpan(i) {
  if (!large) {
    const e = rowEls[i];
    return [e.offsetTop, e.offsetTop + e.offsetHeight];
  }
  const c = chunkEls[(i / CHUNK) | 0];
  const n = c.childElementCount;
  const k = i % CHUNK;
  return [c.offsetTop + (k / n) * c.offsetHeight, c.offsetTop + ((k + 1) / n) * c.offsetHeight];
}

function drawRuler() {
  const H = rulerEl.clientHeight;
  if (!H || !rowEls.length) {
    rulerMarks.replaceChildren();
    updateView();
    return;
  }
  const total = scroller.scrollHeight || 1;
  const scale = H / total;
  const frag = document.createDocumentFragment();
  markList = [];
  // 同じ帯で重なる/接する印は1つにまとめる（印の数を画面のピクセル数程度に抑える）
  const last = { del: null, add: null };
  for (const { lane, from, to } of runs) {
    let top = rowSpan(from)[0] * scale;
    let bottom = rowSpan(to)[1] * scale;
    // 短すぎるランは中心を保ったまま最小の高さに広げる（印の中央をクリックすると、その行が中央に来る）
    if (bottom - top < MARK_MIN) {
      const mid = (top + bottom) / 2;
      top = Math.min(Math.max(0, mid - MARK_MIN / 2), H - MARK_MIN);
      bottom = top + MARK_MIN;
    }
    const prev = last[lane];
    if (prev && top <= prev.bottom) {
      prev.bottom = Math.max(prev.bottom, bottom);
      continue;
    }
    last[lane] = { top, bottom, e: el('div', `m-${lane}`) };
    if (prev) place(prev);
    markList.push(last[lane]);
    frag.append(last[lane].e);
  }
  for (const m of Object.values(last)) if (m) place(m);
  rulerMarks.replaceChildren(frag);
  // 移動直後の強調表示の途中で描き直した場合は、強調を付け直す
  if (flashing) applyFlash();
  updateView();
}
function place(m) {
  m.e.style.top = `${m.top.toFixed(1)}px`;
  m.e.style.height = `${Math.min(m.bottom, rulerEl.clientHeight) - m.top}px`;
}

// 見えている範囲の枠（スクロール位置に合わせて動かす）
function updateView() {
  const H = rulerEl.clientHeight;
  const total = scroller.scrollHeight;
  if (!H || !rowEls.length || !total) {
    rulerView.hidden = true;
    rulerEl.setAttribute('aria-valuenow', '0');
    return;
  }
  const h = Math.max(VIEW_MIN, (scroller.clientHeight / total) * H);
  const top = Math.min(H - h, (scroller.scrollTop / total) * H);
  rulerView.hidden = false;
  rulerView.style.top = `${top.toFixed(1)}px`;
  rulerView.style.height = `${h.toFixed(1)}px`;
  const max = total - scroller.clientHeight;
  rulerEl.setAttribute('aria-valuenow', String(max > 0 ? Math.round((scroller.scrollTop / max) * 100) : 0));
}

// スクロール・大きさの変化は1フレームに1回だけ処理する
let frame = 0;
let needFull = false;
function requestRuler(full) {
  if (full) needFull = true;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (needFull) { needFull = false; drawRuler(); } else updateView();
    updateNav();
  });
}
scroller.addEventListener('scroll', () => requestRuler(false), { passive: true });
// 狭い画面ではページ全体がスクロールする（移動ボタンの有効/無効を更新するため）
window.addEventListener('scroll', () => requestRuler(false), { passive: true });
// 差分欄の大きさ（入力欄の伸び縮み・ウィンドウの大きさ）や、塊の実際の高さが変わったら印を描き直す
new ResizeObserver(() => requestRuler(true)).observe(scroller);
new ResizeObserver(() => requestRuler(true)).observe(diffEl);

// クリック/ドラッグ: 押した位置が差分欄の中央に来るようにスクロールする
let dragging = false;
function scrollToPointer(e) {
  const r = rulerEl.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  scroller.scrollTop = f * scroller.scrollHeight - scroller.clientHeight / 2;
}
rulerEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !rowEls.length) return;
  e.preventDefault(); // 文字の選択や、入力欄のフォーカスが外れるのを防ぐ
  cancelAnim();
  dragging = true;
  rulerEl.setPointerCapture(e.pointerId);
  scrollToPointer(e);
});
rulerEl.addEventListener('pointermove', (e) => { if (dragging) scrollToPointer(e); });
const endDrag = () => { dragging = false; };
rulerEl.addEventListener('pointerup', endDrag);
rulerEl.addEventListener('pointercancel', endDrag);

// 画面幅が 640px をまたいだら、左右表示 / 1列表示を自動で切り替える
narrowMq.addEventListener('change', render);

// ---- 変更間の移動（⤒ ↑ ↓ ⤓ ボタン、↓/↑ キー、F7） ----
const NAV_MS = 160;      // 移動のアニメーションの長さ（素早く）
const FLASH_MS = 600;    // 移動先のルーラーの印を太くしておく時間
const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');
const resultEl = $('result');
const headEl = document.querySelector('.result-head');
const navBtns = { top: $('nav-top'), prev: $('nav-prev'), next: $('nav-next'), bottom: $('nav-bottom') };
let markList = [];       // ルーラーの印 [{ top, bottom, e }]（drawRuler が作る）
let navIdx = -1;         // 最後に移動した変更の番号（-1 = なし）
let navAt = 0;           // そのときのスクロール位置（ここから動いていなければ navIdx を「いまの変更」とみなす）
let anim = 0;            // スクロールのアニメーション（requestAnimationFrame の番号）
let flashing = null;     // 強調中の範囲 { from, to }（rowEls の添字）
let flashTimer = 0;
let hereRows = [];       // 行の左端に線を出している行

// スクロールする対象と位置の情報。広い画面 = 差分欄（scroller）、狭い画面 = ページ全体。
//  base … 差分本体（scroller）の先頭のスクロール位置（行の offsetTop にこれを足すとスクロール位置になる）
//  top  … 「先頭」ボタンの行き先（狭い画面では差分の見出しが画面の上端に来る位置）
//  off  … 移動先の行を置く、表示範囲の上端からの距離（上に残る見出しの下から、残りの高さの1/5）
function view() {
  if (narrowMq.matches) {
    const se = document.scrollingElement;
    const pos = se.scrollTop;
    const max = Math.max(0, se.scrollHeight - se.clientHeight);
    const head = headEl.offsetHeight;
    const top = Math.min(max, Math.round(resultEl.getBoundingClientRect().top + pos));
    return { el: se, pos, max, top, base: scroller.getBoundingClientRect().top + pos, off: head + Math.round((se.clientHeight - head) / 5) };
  }
  const cols = diffEl.querySelector('.cols');
  const head = cols ? cols.offsetHeight : 0;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  return { el: scroller, pos: scroller.scrollTop, max, top: 0, base: 0, off: head + Math.round((scroller.clientHeight - head) / 5) };
}

// いま次/前に行ける変更の番号（-1 = なし）
function targets(v) {
  if (!hunks.length) return { prev: -1, next: -1 };
  // 直前に移動した位置から動いていなければ、その変更の次/前（末尾付近で同じ位置に止まる変更も順に回れる）
  if (navIdx >= 0 && (anim || Math.abs(v.pos - navAt) <= 2)) {
    return { prev: navIdx - 1, next: navIdx + 1 < hunks.length ? navIdx + 1 : -1 };
  }
  // 先頭にいるときは、見えている変更も含めて最初の変更から。末尾にいるときはその逆（前 = 最後の変更）
  if (v.pos <= v.top + 1) return { prev: -1, next: 0 };
  if (v.pos >= v.max - 1) return { prev: hunks.length - 1, next: -1 };
  // 手でスクロールした後: 移動先の位置（上から約1/5）より下にある最初の変更 / 上にある最後の変更
  const a = v.pos - v.base + v.off;
  let prev = -1, next = -1;
  for (let i = 0; i < hunks.length; i++) {
    const t = rowSpan(hunks[i].from)[0];
    if (t < a - 1) prev = i;
    else if (t > a + 1 && next < 0) next = i;
  }
  return { prev, next };
}

// ボタンの有効/無効を今の位置に合わせる。押したボタンが無効になったら、フォーカスを差分欄へ移す
// （フォーカスが消えると次のキー操作が効かなくなるため）
function updateNav() {
  const has = rowEls.length > 0;
  const v = has ? view() : null;
  const t = has ? targets(v) : { prev: -1, next: -1 };
  const off = {
    top: !has || v.pos <= v.top + 1,
    prev: t.prev < 0,
    next: t.next < 0,
    bottom: !has || v.pos >= v.max - 1,
  };
  for (const [k, b] of Object.entries(navBtns)) {
    if (b.disabled === off[k]) continue;
    const had = document.activeElement === b;
    b.disabled = off[k];
    if (had && off[k]) scroller.focus({ preventScroll: true });
  }
}

function resetNav() {
  cancelAnim();
  navIdx = -1;
  hereRows = [];
  flashing = null;
  clearTimeout(flashTimer);
}

function cancelAnim() {
  if (anim) cancelAnimationFrame(anim);
  anim = 0;
}

// 指定の位置へスクロールする（素早いアニメーション。動きを減らす設定なら一瞬で）
function scrollToPos(target, done) {
  cancelAnim();
  const el = view().el;
  const from = el.scrollTop;
  const d = target - from;
  if (reduceMq.matches || Math.abs(d) < 2) {
    el.scrollTop = target;
    if (done) done();
    requestRuler(false);
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / NAV_MS);
    el.scrollTop = from + d * (1 - (1 - k) ** 3);
    if (k < 1) { anim = requestAnimationFrame(step); return; }
    anim = 0;
    if (done) done();
    requestRuler(false);
  };
  anim = requestAnimationFrame(step);
}

// i 番目の変更の先頭の行が、移動先の位置に来るスクロール位置
function hunkPos(v, i) {
  return Math.min(v.max, Math.max(0, Math.round(v.base + rowEls[hunks[i].from].offsetTop - v.off)));
}

function goHunk(i) {
  const v = view();
  navIdx = i;
  navAt = hunkPos(v, i);
  markHere(i);
  flash(i);
  scrollToPos(navAt, () => {
    // 行数が多いときは画面外の塊の高さが仮の値なので、着いた後で実際の位置に合わせ直す
    if (navIdx !== i) return;
    const p = hunkPos(view(), i);
    if (Math.abs(p - navAt) > 2) { navAt = p; view().el.scrollTop = p; }
  });
  updateNav();
}

// 結果が古いまま（入力の直後でデバウンス中）なら先に計算し直す
function flush() { if (timer) update(); }

function goNext() {
  flush();
  if (!rowEls.length) return;
  const n = targets(view()).next;
  if (n >= 0) goHunk(n);
}
function goPrev() {
  flush();
  if (!rowEls.length) return;
  const p = targets(view()).prev;
  if (p >= 0) goHunk(p);
}
function goEnd(bottom) {
  flush();
  if (!rowEls.length) return;
  const v = view();
  navIdx = -1;
  for (const r of hereRows) r.classList.remove('is-here');
  hereRows = [];
  scrollToPos(bottom ? v.max : v.top);
  updateNav();
}

// 移動先の変更の行に、左端の線（.is-here）を付ける（次に移動するか、先頭/末尾へ移るか、描き直すまで残る）
function markHere(i) {
  for (const r of hereRows) r.classList.remove('is-here');
  hereRows = rowEls.slice(hunks[i].from, hunks[i].to + 1);
  for (const r of hereRows) r.classList.add('is-here');
}

// ルーラーで、移動先の変更に重なる印を短時間太くする
function flash(i) {
  clearTimeout(flashTimer);
  for (const m of markList) m.e.classList.remove('is-flash');
  flashing = { from: hunks[i].from, to: hunks[i].to };
  applyFlash();
  flashTimer = setTimeout(() => {
    flashing = null;
    for (const m of markList) m.e.classList.remove('is-flash');
  }, FLASH_MS);
}
function applyFlash() {
  const H = rulerEl.clientHeight;
  if (!H || !flashing) return; // 狭い画面ではルーラーを出さない
  const scale = H / (scroller.scrollHeight || 1);
  const top = rowSpan(flashing.from)[0] * scale;
  const bottom = rowSpan(flashing.to)[1] * scale;
  for (const m of markList) {
    // 印は最小の高さに広げてあるので、少し余裕を持って重なりを判定する
    if (m.bottom >= top - 1 && m.top <= bottom + 1) m.e.classList.add('is-flash');
  }
}

navBtns.top.addEventListener('click', () => goEnd(false));
navBtns.prev.addEventListener('click', goPrev);
navBtns.next.addEventListener('click', goNext);
navBtns.bottom.addEventListener('click', () => goEnd(true));
// 手でスクロールし始めたら、移動のアニメーションをやめる（以後は表示位置から次/前を決める）
window.addEventListener('wheel', cancelAnim, { passive: true });
window.addEventListener('touchstart', cancelAnim, { passive: true });

// 差分欄を選択中のキー: ↓/↑ = 次/前の変更、⌘↓/⌘↑（Ctrl も可）= 末尾/先頭。
// ほかのキー（PageDown・Space など）は標準のスクロールのまま
scroller.addEventListener('keydown', (e) => {
  if (e.target !== scroller || e.altKey || e.shiftKey) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') { cancelAnim(); return; }
  e.preventDefault();
  const down = e.key === 'ArrowDown';
  if (e.metaKey || e.ctrlKey) goEnd(down);
  else if (down) goNext();
  else goPrev();
});

// ---- ヘルプ（キーボードショートカットの一覧と、安全性の説明） ----
// 安全性の説明（Privacy）は index.html に静的に書いてある。内容と根拠の対応は index.html のコメント参照。
// 「?」ボタンの下に開く小さなパネル。モーダルではない（フォーカスを閉じ込めない。パネル内の Tab は標準の動き）。
// 開くとパネルにフォーカスを移し、Esc / ? キー / 「?」ボタン / 外側のクリック / 中の Clear で閉じる。
// Esc と ? キーで閉じたときは、直前にいた場所（左の欄・右の欄・差分欄のどれか）へフォーカスを戻す。
// 「?」ボタンで閉じたときは「?」ボタンに残す（外側のクリックではクリックした先に任せる）。
const helpWrap = $('help-wrap');
const helpBtn = $('help-btn');
const helpEl = $('help');
// Mac 以外では ⌘ の代わりに Ctrl と表記する（キー操作はどちらでも効く）
if (!/Mac|iPhone|iPad|iPod/.test(navigator.platform)) {
  for (const k of helpEl.querySelectorAll('kbd[data-pc]')) k.textContent = k.dataset.pc;
}
const helpOpen = () => !helpEl.hidden;
function openHelp() {
  helpEl.hidden = false;
  helpBtn.setAttribute('aria-expanded', 'true');
  helpEl.focus();
}
// to … 閉じた後にフォーカスを移す先（null なら、フォーカスがパネル内にあったときだけ「?」ボタンへ）
function closeHelp(to) {
  if (!helpOpen()) return;
  const inside = helpWrap.contains(document.activeElement) || document.activeElement === document.body;
  helpEl.hidden = true;
  helpBtn.setAttribute('aria-expanded', 'false');
  if (to) to.focus();
  else if (inside) helpBtn.focus();
}
helpBtn.addEventListener('click', () => (helpOpen() ? closeHelp(helpBtn) : openHelp()));
document.addEventListener('pointerdown', (e) => {
  if (helpOpen() && !helpWrap.contains(e.target)) closeHelp(false);
}, true);
// Tab などでパネルの外へフォーカスが移ったら閉じる（移った先はそのまま）
helpWrap.addEventListener('focusout', (e) => {
  if (e.relatedTarget && !helpWrap.contains(e.relatedTarget)) closeHelp(false);
});

// ---- どこでも効くキー ----
const isTextBox = (t) => t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement;
document.addEventListener('keydown', (e) => {
  // 日本語入力の変換中は、F7（カタカナ変換）や Esc（変換の取り消し）を変換に使うので何もしない
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'F7' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (e.shiftKey) goPrev(); else goNext();
    return;
  }
  if (e.key === 'Escape') {
    // 1. ヘルプが開いていれば閉じるだけ（クリアはしない）
    if (helpOpen()) { e.preventDefault(); closeHelp(lastArea); return; }
    // 2. 入力欄の中 → 差分欄へ移る
    if (e.target === textA || e.target === textB) {
      e.preventDefault();
      scroller.focus({ preventScroll: true });
      return;
    }
    // 3. 差分欄（またはどこにもフォーカスがない）→ クリア。両方とも空なら何もしない
    if ((e.target === scroller || e.target === document.body) && !isEmpty()) {
      e.preventDefault();
      clearAll();
    }
    return;
  }
  // 入力欄の中では ? は普通の文字として入力する。開いているときはもう一度押すと閉じる
  if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTextBox(e.target)) {
    e.preventDefault();
    if (helpOpen()) closeHelp(lastArea); else openHelp();
  }
});

// ---- Tab の循環（v1.3.2）: 左の欄 → 右の欄 → 差分欄 → 左の欄…（Shift+Tab は逆順） ----
// ボタンに tabindex="-1" は付けず、この3か所で Tab を受けたときだけ行き先を差し替える。
// 理由: ボタンを Tab 順から外すと、読み上げソフトのフォーカス移動やページ先頭からの Tab でも届かなくなる。
// 差し替えだけなら、ボタンはクリック・読み上げソフトの操作・ページ先頭からの Tab で従来どおり使える。
// ⌘ / Ctrl / Alt 付きの Tab（タブの切り替えなど）と、日本語入力の変換中は標準の動きのまま。
const ring = [textA, textB, scroller];
let lastArea = textA;    // 最後にフォーカスのあった3か所のどれか（ヘルプを閉じたときの戻り先）
for (const area of ring) {
  area.addEventListener('focus', () => { lastArea = area; });
  area.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.target !== area || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    ring[(ring.indexOf(area) + (e.shiftKey ? ring.length - 1 : 1)) % ring.length].focus();
  });
}

// ---- 入力欄の折りたたみ ----
// 想定する使い方:「左に貼る → 右に貼る → 差分が画面の大半を占める → 直したい欄をクリック」。
// そのため、両方の欄に文字が入っている間（.inputs.is-compact）は、フォーカスのない欄を約3行に縮める。
//  - 開いた直後は左にフォーカス・右は空なので、両方とも通常の高さ（貼り付けやすい）。
//  - 右に貼った時点で左が縮み、作業中の右は開いたまま。差分やほかの場所をクリックすると両方縮む。
//  - 縮んだ欄をクリック/Tab で選ぶと元の高さに戻り、そのまま編集すると差分も更新される。
//  - どちらかが空になったら折りたたみを解除する。
//  - 縮んだ欄は常に先頭の行を見せる（スクロール位置を先頭に戻す）。
// 貼り付けのときの特別な動き（クリックなしで「Cmd+V → Cmd+V → ↓」だけで最初の変更まで行けるようにするため）:
//  - 左に貼り付けたとき右が空なら、貼り付け直後に右へフォーカスを移す（右に貼ったときは移さない）。
//  - 貼り付けの結果、両方に文字が入ったら、すぐに差分を計算し、フォーカスを差分欄へ移す（v1.3）。
//    フォーカスが入力欄から外れるので両方の欄が縮み、差分欄はグレーの枠で「選択中」になる。
//    差分欄は先頭から表示し、↓ キーで最初の変更へ移動できる。欄を直したいときはクリック/Tab で選ぶ。
// クラスは「両方入力済みか」が変わった瞬間にだけ切り替える（入力のたびにレイアウトを動かさない）。
const inputsEl = document.querySelector('.inputs');
let compact = false;
function syncCompact() {
  const both = textA.value !== '' && textB.value !== '';
  if (both === compact) return;
  compact = both;
  inputsEl.classList.toggle('is-compact', compact);
  if (compact) {
    // 手動でリサイズした高さ（インライン style）が残っていると縮まないので消す
    textA.style.height = '';
    textB.style.height = '';
    for (const ta of [textA, textB]) if (ta !== document.activeElement) ta.scrollTop = 0;
  }
}

// ---- クリアと「元に戻す」 ----
// クリアした文字列はこの変数（メモリ上）にだけ一時的に持つ。保存・送信は一切しない。
// 5秒経つか、どちらかの欄を編集するか、元に戻した時点で null にして捨てる。
const UNDO_MS = 5000;
const undoBtn = $('undo');
const announceEl = $('announce');
let undoData = null;
let undoTimer = 0;
let lastFocused = textA;

function dismissUndo() {
  clearTimeout(undoTimer);
  // Undo ボタンにフォーカスがあったまま消すとフォーカスが失われるので、左の欄へ移す
  if (document.activeElement === undoBtn) textA.focus();
  undoData = null;
  undoBtn.hidden = true;
  announceEl.textContent = '';
}

function onInput(e) {
  if (undoData) dismissUndo();
  syncCompact();
  schedule();
  // 貼り付け（クリップボードは読まず、ブラウザが値を入れた後の input イベントの種類で判定する）
  if (e.inputType !== 'insertFromPaste') return;
  if (e.target === textA && textB.value === '') {
    textB.focus();
  } else if (compact) {
    // 新しい比較なので、差分は先頭から見せる（↓ で最初の変更へ）
    update();
    view().el.scrollTop = 0;
    scroller.focus({ preventScroll: true });
    for (const ta of [textA, textB]) ta.scrollTop = 0;
    // 貼り付け後にブラウザがカーソル位置へスクロールすることがあるので、次のフレームでも先頭に戻す
    requestAnimationFrame(() => { for (const ta of [textA, textB]) if (ta !== document.activeElement) ta.scrollTop = 0; });
  }
}
for (const ta of [textA, textB]) {
  ta.addEventListener('input', onInput);
  ta.addEventListener('focusin', () => { lastFocused = ta; });
  ta.addEventListener('focusout', () => {
    if (!compact) return;
    // 折りたたみ中に手動リサイズした欄も縮むようにし、縮んだ欄は先頭の行を見せる
    ta.style.height = '';
    ta.scrollTop = 0;
  });
}

// 両方の欄をクリアする（ツールバーの Clear・ヘルプの中の Clear・差分欄での Esc が共通で使う）
function isEmpty() { return textA.value === '' && textB.value === ''; }
function clearAll() {
  // 両方とも空なら何もしない（直前の「元に戻す」も残す）
  if (isEmpty()) { textA.focus(); return; }
  clearTimeout(undoTimer);
  undoData = { a: textA.value, b: textB.value, focus: lastFocused };
  undoBtn.hidden = false;
  announceEl.textContent = TEXT.cleared;
  undoTimer = setTimeout(dismissUndo, UNDO_MS);
  textA.value = '';
  textB.value = '';
  update();
  syncCompact();
  textA.focus();
}
$('clear').addEventListener('click', clearAll);
// ヘルプの中の Clear: ヘルプを閉じてからクリアする（フォーカスは左の欄へ）
$('help-clear').addEventListener('click', () => { closeHelp(textA); clearAll(); });

undoBtn.addEventListener('click', () => {
  if (!undoData) return;
  const { a, b, focus } = undoData;
  dismissUndo();
  textA.value = a;
  textB.value = b;
  update();
  syncCompact();
  focus.focus();
  announceEl.textContent = TEXT.restored;
});

// ---- 初期化 ----
// 入力は残さない方針。ブラウザがタブ復元などで前回の入力を戻しても、開いた時点で捨てる
// （「元に戻す」の一時データも捨てる。dismissUndo がタイマー停止・データ破棄・ボタンを隠すまで行う）
function wipe() { dismissUndo(); textA.value = ''; textB.value = ''; }
wipe();
result = computeDiff(textA.value, textB.value);
syncCompact();
render();
// 開いてすぐ Cmd+V できるよう左の欄にフォーカス（HTML の autofocus は使わずここで一本化）
textA.focus();

// ページを離れるとき（別ページへ移動・タブを閉じる）にも消す。
// 「戻る」で戻ったとき（bfcache で丸ごと保持されていた場合）も空の状態で表示し直す
// （update は計算と描画をすぐに行う。デバウンスするのは入力時の schedule だけ）
addEventListener('pagehide', wipe);
addEventListener('pageshow', (e) => { if (e.persisted) { wipe(); update(); syncCompact(); textA.focus(); } });
