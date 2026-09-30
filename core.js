/* 下校時刻カレンダー 共通ロジック（ブラウザ／Node両対応・外部通信なし） */
(function (root) {
  'use strict';

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const ALL_GRADES = [1, 2, 3, 4, 5, 6];
  const DISMISSAL_CHARS = '0123456789年全学:・~()※組、は以外下記のみ';

  // ---------- 文字の正規化 ----------
  function toHalfWidth(s) {
    return String(s || '')
      .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ');
  }

  // OCRの癖を吸収（「1」が「I」「|」「l」になる、「～」の揺れ など）
  function normalizeText(s) {
    let t = toHalfWidth(s)
      // PDFの文字データでは「~」が結合文字（U+0303）や「˜」で取り出されることがある
      .replace(/[〜～∼﹏~̃˜⁓]/g, '~')
      .replace(/[…‥_＿]/g, ' ')
      .replace(/([1-6])\s*[へヘ〜]\s*(?=[1-6]\s*年)/g, '$1~')
      .replace(/[：;]/g, ':')
      .replace(/[･·•]/g, '・')
      .replace(/[，,､]/g, '、')
      .replace(/[（]/g, '(').replace(/[）]/g, ')');
    // 「1・2年」の「1・」が「に」に化ける
    t = t.replace(/[Il|!丨]?\s*に\s*(?=[2-6]\s*年)/g, '1・');
    // 数字・年・組・時刻の前後にある I | l ! ] [ を 1 とみなす
    const one = '[Il|!\\]\\[丨]';
    t = t.replace(new RegExp(one + '(?=\\s*(?:[0-9]|年|組|・|~|:))', 'g'), '1');
    t = t.replace(new RegExp('(?<=[0-9:・~]\\s*)' + one, 'g'), '1');
    // 学年範囲の「~ー」「ー」ゆれ
    t = t.replace(/(?<![\d:])([1-6])[\s~ー\-－−‐へヘ]*[~ー\-－−‐へヘ][\s~ー\-－−‐へヘ]*(?=[1-6]\s*年)/g, '$1~');
    t = t.replace(/(\d)\s*[~ー\-]{2,}/g, '$1~');
    // 学年の区切り「・」の代わりに「、」「.」「,」が来た場合
    t = t.replace(/([1-6])\s*[、.]\s*(?=[1-6](?:\s*[・~、.]\s*[1-6])*\s*年)/g, '$1・');
    // 時刻の 「14 : 30」「14.30」を「14:30」へ（直前が年や空白のときだけ）
    t = t.replace(/(\d{1,2})\s*:\s*(\d{2})/g, '$1:$2');
    // 「14時10分」「15時」→「14:10」「15:00」（「5校時」は対象外）
    t = t.replace(/(^|[^\d校])(\d{1,2})\s*時\s*(\d{1,2})\s*分/g, (m0, p, h, mi) => p + h + ':' + String(mi).padStart(2, '0'));
    t = t.replace(/(^|[^\d校])(\d{1,2})\s*時(?![\d間刻限])/g, '$1$2:00');
    t = t.replace(/(\d{1,2}:\d{2})\s*半/g, '$1');
    t = t.replace(/(\d{1,2})\s*[・.。]\s*([0-5]\d)(?![\d年])/g, '$1:$2');
    return t;
  }

  // ---------- 下校時刻セルの解析 ----------
  // 例: "1・2年15:00 3~6年16:00" / "全学年13:15(下記以外)※2年3組…は、14:30"
  function parseGradeSpec(spec) {
    spec = spec.replace(/\s+/g, '');
    if (/全学?年/.test(spec)) return ALL_GRADES.slice();
    const body = spec.replace(/年$/, '');
    const grades = new Set();
    for (const part of body.split('・')) {
      const m = /^([1-6])(?:~([1-6]))?$/.exec(part);
      if (!m) return null;
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      if (b < a) return null;
      for (let g = a; g <= b; g += 1) grades.add(g);
    }
    return Array.from(grades);
  }

  function formatTime(h, m) {
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function parseDismissalText(raw) {
    const text = normalizeText(raw).replace(/\n/g, ' ');
    const times = {};       // grade -> [time,...]
    const flags = {};       // grade -> reason
    const notes = [];

    // 注記（※…、(…のみ…)）を本文から分離
    let main = text;
    const noteRe = /※[^※]*|\([^)]*\)/g;
    let nm;
    while ((nm = noteRe.exec(text)) !== null) notes.push(nm[0].trim());
    main = text.replace(noteRe, ' ');

    // 学級単位の例外（例: 2年3組、6年1組のみ）→ その学年は要確認
    for (const n of notes) {
      const classRe = /([1-6])\s*年\s*\d{1,2}\s*組/g;
      let cm;
      let found = false;
      while ((cm = classRe.exec(n)) !== null) {
        flags[Number(cm[1])] = '学級ごとの例外あり';
        found = true;
      }
      if (!found && /組/.test(n)) {
        // 学級の例外があるが学年を読めない → 全学年を要確認に
        ALL_GRADES.forEach((g) => { flags[g] = '学級ごとの例外あり（学年を読めない）'; });
      } else if (!found && /下校|時刻|異な|時$/.test(n) && !/下記以外/.test(n)) {
        ALL_GRADES.forEach((g) => { if (!flags[g]) flags[g] = 'NOTE'; });
      }
    }

    // 「36年」のように区切り記号が読み取れなかった学年は後で判定する
    const pairRe = /(全学?年|(?<![\d:])[1-6](?:\s*[・~]?\s*[1-6])*\s*年)\s*(?:は|:)?\s*([0-2]?\d):([0-5]\d)/g;
    let m;
    let pairCount = 0;
    const pairs = [];
    while ((m = pairRe.exec(main)) !== null) {
      const h = Number(m[2]);
      if (h > 23) continue;
      pairCount += 1;
      const t = formatTime(h, Number(m[3]));
      const spec = m[1].replace(/\s+/g, '');
      const bare = /^([1-6])([1-6])年$/.exec(spec);
      if (bare && Number(bare[1]) < Number(bare[2])) {
        pairs.push({ t, ambiguous: [Number(bare[1]), Number(bare[2])] });
      } else {
        const grades = parseGradeSpec(spec);
        if (grades) pairs.push({ t, grades });
      }
    }
    let corrected = false;
    const fixed = pairs.filter((p) => p.grades);
    pairs.filter((p) => p.ambiguous).forEach((p) => {
      const [a, b] = p.ambiguous;
      const covered = new Set();
      fixed.forEach((f) => f.grades.forEach((g) => covered.add(g)));
      const range = []; for (let g = a; g <= b; g += 1) range.push(g);
      const options = [range, [a, b]];
      const choice = options.find((opt) => {
        if (opt.some((g) => covered.has(g))) return false;
        const all = new Set(covered); opt.forEach((g) => all.add(g));
        return all.size === 6;
      });
      if (choice) { fixed.push({ t: p.t, grades: choice }); corrected = true; }
      else range.forEach((g) => { flags[g] = flags[g] || '学年の区切りが読み取れない'; times[g] = times[g] || []; if (times[g].indexOf(p.t) === -1) times[g].push(p.t); });
    });
    const mentions = {};
    fixed.forEach((p) => {
      p.grades.forEach((g) => {
        mentions[g] = (mentions[g] || 0) + 1;
        times[g] = times[g] || [];
        if (times[g].indexOf(p.t) === -1) times[g].push(p.t);
      });
    });
    // 同じ学年が2回以上出てくる → 別の日の行が混ざった可能性が高いので行全体を要確認
    if (Object.keys(mentions).some((g) => mentions[g] > 1)) {
      ALL_GRADES.forEach((g) => { flags[g] = '同じ学年が複数回出てくる'; });
    }

    // 時刻らしい文字があるのに学年と結び付かない → 読取不良の可能性
    // 「14:30~」のような行事の開始時刻は数えない
    const looseTimes = (main.match(/\d{1,2}:\d{2}(?!\s*[~ー\-]|\s*から)/g) || []).length;
    const unpaired = looseTimes > pairCount;

    return { text: text.trim(), times, flags, notes, unpaired, corrected };
  }

  // 複数回のOCR結果から、学年と時刻がきれいに対応するものを採用する
  function isClean(p) {
    if (p.unpaired) return false;
    if (Object.keys(p.flags).some((g) => /区切り/.test(p.flags[g]))) return false;
    return ALL_GRADES.every((g) => p.times[g] && p.times[g].length === 1 &&
      (!p.flags[g] || p.flags[g] === 'NOTE' || /組/.test(p.flags[g]) || /学級/.test(p.flags[g])));
  }
  function coverScore(p) {
    return ALL_GRADES.filter((g) => p.times[g] && p.times[g].length === 1).length - (p.unpaired ? 1 : 0);
  }
  function sameTimes(a, b) {
    return ALL_GRADES.every((g) => String(a.times[g] || '') === String(b.times[g] || ''));
  }
  function parseMulti(texts) {
    const list = texts.filter((t) => t && t.trim()).map(parseDismissalText);
    if (list.length === 0) return parseDismissalText('');
    if (list.length === 1) return list[0];
    const clean = list.filter(isClean);
    let chosen;
    let conflict = false;
    let weak = false;
    if (clean.length > 0) {
      // きれいに読めた結果どうしで多数決
      const groups = [];
      clean.forEach((c) => {
        const g = groups.find((x) => sameTimes(x.rep, c));
        if (g) g.n += 1; else groups.push({ rep: c, n: 1 });
      });
      groups.sort((a, b) => b.n - a.n);
      chosen = groups[0].rep;
      if (groups.length > 1 && groups[1].n === groups[0].n) conflict = true;
      if (groups[0].n === 1 && list.length >= 3) weak = true;
    } else {
      chosen = list.slice().sort((a, b) => coverScore(b) - coverScore(a))[0];
    }
    const merged = Object.assign({}, chosen, { flags: Object.assign({}, chosen.flags), text: chosen.text });
    // 注記・学級の例外はどの回で読めても反映（安全側）
    list.forEach((p) => {
      Object.keys(p.flags).forEach((g) => {
        if (/学級/.test(p.flags[g]) || (p.flags[g] === 'NOTE' && !merged.flags[g])) merged.flags[g] = p.flags[g];
      });
      if (p.notes.length && merged.notes.length === 0) merged.text = merged.text + ' ' + p.notes.join(' ');
    });
    if (conflict) ALL_GRADES.forEach((g) => { merged.flags[g] = 'OCRの読取結果が一致しない'; });
    else if (weak) ALL_GRADES.forEach((g) => { if (!merged.flags[g]) merged.flags[g] = 'OCRで一度しか読めなかった'; });
    return merged;
  }

  function isPlausibleTime(t) {
    const h = Number(t.slice(0, 2));
    return h >= 8 && h <= 19;
  }

  // ---------- 年度・月の解析 ----------
  function parseHeader(raw) {
    const t = normalizeText(raw).replace(/\s+/g, '');
    let fiscalYear = null;
    let month = null;
    let m = /(20\d{2})年度/.exec(t);
    if (m) fiscalYear = Number(m[1]);
    if (!fiscalYear) {
      m = /(?:令和|和|R)?(\d{1,2})年度/.exec(t);
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= 40) fiscalYear = 2018 + Number(m[1]);
    }
    m = /(?:^|[^\d])(1[0-2]|[1-9])月(?:行|の|分|予)/.exec(t) || /(?:^|[^\d])(1[0-2]|[1-9])月/.exec(t.replace(/\d+年度/, ''));
    if (m) month = Number(m[1]);
    return { fiscalYear, month };
  }

  function calendarYear(fiscalYear, month) {
    return month >= 4 ? fiscalYear : fiscalYear + 1;
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function weekdayOf(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  function isoDate(y, m, d) {
    return [String(y).padStart(4, '0'), String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
  }

  // ---------- 画像処理（表の罫線検出） ----------
  function toGray(img) {
    const { width, height, data } = img;
    const g = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < g.length; i += 1, p += 4) {
      g[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    }
    return g;
  }

  function groupPositions(positions) {
    const out = [];
    let start = null;
    let prev = null;
    for (const p of positions) {
      if (start === null) { start = p; prev = p; continue; }
      if (p - prev <= 2) { prev = p; continue; }
      out.push(Math.round((start + prev) / 2));
      start = p; prev = p;
    }
    if (start !== null) out.push(Math.round((start + prev) / 2));
    return out;
  }

  function detectGrid(gray, width, height) {
    const DARK = 140;
    const hPos = [];
    for (let y = 0; y < height; y += 1) {
      let run = 0; let best = 0;
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        if (gray[row + x] < DARK) { run += 1; if (run > best) best = run; } else run = 0;
      }
      if (best > width * 0.45) hPos.push(y);
    }
    const hLines = groupPositions(hPos);
    if (hLines.length < 4) return null;
    const top = hLines[0];
    const bottom = hLines[hLines.length - 1];
    const vPos = [];
    const minRun = (bottom - top) * 0.6;
    for (let x = 0; x < width; x += 1) {
      let run = 0; let best = 0;
      for (let y = top; y <= bottom; y += 1) {
        if (gray[y * width + x] < DARK) { run += 1; if (run > best) best = run; } else run = 0;
      }
      if (best > minRun) vPos.push(x);
    }
    const vLines = groupPositions(vPos);
    if (vLines.length < 3) return null;
    return { hLines, vLines };
  }

  // 傾き補正（スキャンで最大±3度程度の傾きを想定）
  function estimateSkew(gray, width, height) {
    const pts = [];
    for (let y = 0; y < height; y += 1) for (let x = (y * 7) % 4; x < width; x += 4) if (gray[y * width + x] < 128) pts.push(x, y);
    if (pts.length < 200) return 0;
    let best = 0; let bestScore = -1;
    const score = (deg) => {
      const t = Math.tan(deg * Math.PI / 180);
      const bins = new Float64Array(height + width);
      for (let i = 0; i < pts.length; i += 2) {
        const yy = Math.round(pts[i + 1] - pts[i] * t) + width;
        if (yy >= 0 && yy < bins.length) bins[yy] += 1;
      }
      let sc = 0; for (let i = 0; i < bins.length; i += 1) sc += bins[i] * bins[i];
      return sc;
    };
    for (let d = -3; d <= 3.0001; d += 0.25) { const sc = score(d); if (sc > bestScore) { bestScore = sc; best = d; } }
    const coarse = best;
    for (let d = coarse - 0.25; d <= coarse + 0.25; d += 0.05) { const sc = score(d); if (sc > bestScore) { bestScore = sc; best = d; } }
    return Math.abs(best) < 0.04 ? 0 : best;
  }

  function rotateGray(gray, width, height, deg) {
    const out = new Uint8Array(width * height).fill(255);
    const a = -deg * Math.PI / 180;
    const cos = Math.cos(a); const sin = Math.sin(a);
    const cx = width / 2; const cy = height / 2;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - cx; const dy = y - cy;
        const sx = Math.round(cx + dx * cos + dy * sin);
        const sy = Math.round(cy - dx * sin + dy * cos);
        if (sx >= 0 && sx < width && sy >= 0 && sy < height) out[y * width + x] = gray[sy * width + sx];
      }
    }
    return out;
  }

  function cellStats(gray, width, x0, y0, x1, y1) {
    let ink = 0; let sum = 0; let n = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const v = gray[y * width + x];
        sum += v; n += 1;
        if (v < 110) ink += 1;
      }
    }
    return { ink: n ? ink / n : 0, inkCount: ink, mean: n ? sum / n : 255 };
  }

  // 複数セルを縦に並べた二値画像を作る（OCRを1回で済ませるため）
  function stackCells(gray, width, cells, scaleGap, thresh) {
    const delta = thresh === undefined ? 80 : thresh;
    const gap = scaleGap || 24;
    const pad = 12;
    let W = 0; let H = gap;
    cells.forEach((c) => { W = Math.max(W, c.x1 - c.x0 + pad * 2); H += (c.y1 - c.y0) + gap; });
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    const spans = [];
    let oy = gap;
    cells.forEach((c) => {
      const h = c.y1 - c.y0;
      // セルの背景の明るさに合わせて二値化（細い「1」が消えないように）
      const hist = new Uint32Array(256);
      for (let y = c.y0; y < c.y1; y += 1) for (let x = c.x0; x < c.x1; x += 1) hist[gray[y * width + x]] += 1;
      const total = (c.x1 - c.x0) * h;
      let acc = 0; let bg = 255;
      for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= total * 0.5) { bg = v; break; } }
      const th = Math.max(90, bg - delta);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < c.x1 - c.x0; x += 1) {
          const g0 = gray[(c.y0 + y) * width + (c.x0 + x)];
          const v = delta < 0 ? Math.min(255, Math.round(g0 * 255 / Math.max(1, bg))) : (g0 < th ? 0 : 255);
          const p = ((oy + y) * W + (x + pad)) * 4;
          data[p] = data[p + 1] = data[p + 2] = v;
        }
      }
      spans.push({ y0: oy, y1: oy + h, key: c.key });
      oy += h + gap;
    });
    return { image: { width: W, height: H, data }, spans };
  }

  function assignLinesToSpans(lines, spans) {
    const out = {};
    lines.forEach((l) => {
      const cy = (l.y0 + l.y1) / 2;
      const s = spans.find((sp) => cy >= sp.y0 - 6 && cy <= sp.y1 + 6);
      if (!s) return;
      out[s.key] = out[s.key] ? out[s.key] + '\n' + l.text : l.text;
    });
    return out;
  }

  // ---------- 表形式PDFの読み取り ----------
  // ocr(image, opts) -> Promise<{text, lines:[{text,x0,y0,x1,y1}], words:[...]}>
  async function readTablePage(img, ocr, log, options) {
    const say = log || function () {};
    const modes = (options && options.modes) || [{ thresh: -1 }, { thresh: 80 }];
    const items = (options && options.textItems) || [];
    const useText = items.length > 20;
    const { width, height } = img;
    let gray = toGray(img);
    let grid = detectGrid(gray, width, height);
    if (!grid && !useText) {
      const skew = estimateSkew(gray, width, height);
      if (skew !== 0) {
        say('傾きを補正しました（' + skew.toFixed(2) + '度）');
        gray = rotateGray(gray, width, height, skew);
        grid = detectGrid(gray, width, height);
      }
    }
    if (!grid) return null;
    const { hLines, vLines } = grid;
    say('表の罫線: 横' + hLines.length + '本 / 縦' + vLines.length + '本');

    // 文字の割り当ては「書き始めの位置」で判定する（長い注記は右の列へはみ出すため、中心では判定しない）
    const rightOf = (it) => (it.w != null ? it.x + it.w : 2 * it.cx - it.x);
    const inRow = (it, b) => it.cy >= b.y0 - 2 && it.cy <= b.y1 + 2;
    const inBox = (b) => items.filter((it) => it.x >= b.x0 - 3 && it.x <= b.x1 + 2 && inRow(it, b));
    // 左の列から下校時刻の列へはみ出してきた文字（どちらの列の内容か判断できない）
    const spillInto = (b) => items.filter((it) => it.x < b.x0 - 3 && rightOf(it) > b.x0 + 4 && inRow(it, b));
    const joinItems = (arr) => {
      const sorted = arr.slice().sort((a, b) => (Math.abs(a.cy - b.cy) > a.h * 0.5 ? a.cy - b.cy : a.x - b.x));
      let out = ''; let lastY = null;
      sorted.forEach((it) => {
        if (lastY !== null && Math.abs(it.cy - lastY) > it.h * 0.5) out += '\n'; else if (out) out += ' ';
        out += it.str; lastY = it.cy;
      });
      return out;
    };

    // 見出し（表の上の「令和8年度 6月行事予定表」）と表の見出し行
    const titleTop = Math.max(0, hLines[0] - Math.round(height * 0.06));
    const titleBox = { key: 'title', x0: vLines[0], x1: vLines[vLines.length - 1], y0: titleTop, y1: hLines[0] - 3 };
    const headerBoxes = [];
    for (let c = 0; c < vLines.length - 1; c += 1) {
      headerBoxes.push({ key: 'h' + c, x0: vLines[c] + 3, x1: vLines[c + 1] - 3, y0: hLines[0] + 3, y1: hLines[1] - 3 });
    }
    const headText = {};
    if (useText) {
      headText.title = joinItems(items.filter((it) => it.cy < hLines[0]));
      headerBoxes.forEach((b) => { headText[b.key] = joinItems(inBox(b)); });
    } else {
      const headStack = stackCells(gray, width, [titleBox].concat(headerBoxes), 30, -1);
      const headOcr = await ocr(headStack.image, { psm: '6' });
      Object.assign(headText, assignLinesToSpans(headOcr.lines, headStack.spans));
    }
    const header = parseHeader(headText.title || '');

    let dismissCol = -1;
    for (let c = 0; c < vLines.length - 1; c += 1) {
      const t = (headText['h' + c] || '').replace(/\s/g, '');
      if (/下校|校時|時刻/.test(t)) { dismissCol = c; break; }
    }
    if (dismissCol < 0) {
      // 予備: 最も広い列より右にある、2番目に広い列
      const widths = [];
      for (let c = 0; c < vLines.length - 1; c += 1) widths.push(vLines[c + 1] - vLines[c]);
      const widest = widths.indexOf(Math.max.apply(null, widths));
      let best = -1;
      for (let c = widest + 1; c < widths.length; c += 1) if (best < 0 || widths[c] > widths[best]) best = c;
      dismissCol = best;
      say('見出しから下校時刻の列を特定できず、列幅から推定しました');
    }
    if (dismissCol < 0) return null;

    // データ行
    const rows = [];
    for (let r = 1; r < hLines.length - 1; r += 1) {
      const y0 = hLines[r] + 3;
      const y1 = hLines[r + 1] - 3;
      if (y1 - y0 < 8) continue;
      const dayCell = { x0: vLines[0] + 3, x1: vLines[1] - 3, y0, y1 };
      const dCell = { x0: vLines[dismissCol] + 4, x1: vLines[dismissCol + 1] - 4, y0, y1 };
      const st = cellStats(gray, width, dCell.x0, dCell.y0, dCell.x1, dCell.y1);
      const dayStats = cellStats(gray, width, dayCell.x0, y0, dayCell.x1, y1);
      rows.push({ index: rows.length, dayCell, dCell, hasText: st.inkCount > 25, shaded: dayStats.mean < 220 });
    }

    if (useText) {
      say('PDFの文字データを使用しました（OCRなし）');
      return {
        header,
        source: 'text',
        rows: rows.map((r) => {
          const row = {
            index: r.index,
            shaded: r.shaded,
            dayText: normalizeText(joinItems(inBox(r.dayCell))).replace(/[^0-9]/g, ''),
            texts: [joinItems(inBox(r.dCell))]
          };
          if (spillInto(r.dCell).length) row.review = '隣の列の文字が下校時刻の欄にはみ出している';
          return row;
        })
      };
    }

    // 画像の作り方を変えて複数回OCRし、結果を突き合わせる
    const textRows = rows.filter((r) => r.hasText);
    const passTexts = [];
    for (const mode of modes) {
      const stack = stackCells(gray, width, textRows.map((r) => Object.assign({ key: String(r.index) }, r.dCell)), 24, mode.thresh);
      const res = textRows.length ? await ocr(stack.image, { psm: '6', whitelist: mode.whitelist ? DISMISSAL_CHARS : '' }) : { lines: [] };
      passTexts.push(assignLinesToSpans(res.lines, stack.spans));
    }

    // 日付列（行数が月の日数と一致しないときの照合用）
    const dayStack = stackCells(gray, width, rows.map((r) => Object.assign({ key: String(r.index) }, r.dayCell)), 24, -1);
    const dayRes = await ocr(dayStack.image, { psm: '6', digits: true });
    const dayText = assignLinesToSpans(dayRes.lines, dayStack.spans);

    return {
      header,
      source: 'ocr',
      rows: rows.map((r) => ({
        index: r.index,
        shaded: r.shaded,
        dayText: normalizeText(dayText[String(r.index)] || '').replace(/[^0-9]/g, ''),
        texts: r.hasText ? passTexts.map((pt) => pt[String(r.index)] || '') : []
      }))
    };
  }

  // 解像度を変えて読んだ複数の表を行ごとに統合
  function mergeTables(tables) {
    const ok = tables.filter(Boolean);
    if (ok.length === 0) return null;
    const base = ok[0];
    const same = ok.filter((t) => t.rows.length === base.rows.length);
    const header = { fiscalYear: null, month: null };
    ok.forEach((t) => {
      if (!header.fiscalYear && t.header.fiscalYear) header.fiscalYear = t.header.fiscalYear;
      if (!header.month && t.header.month) header.month = t.header.month;
    });
    return {
      header,
      rows: base.rows.map((r, i) => ({
        index: r.index,
        shaded: r.shaded,
        dayText: same.map((t) => t.rows[i].dayText).find((d) => d) || '',
        texts: [].concat.apply([], same.map((t) => t.rows[i].texts)),
        review: same.map((t) => t.rows[i].review).find((v) => v)
      }))
    };
  }

  // 表の行を日付に対応付け、学年ごとの候補を作る
  function buildFromTable(table, opts) {
    const fiscalYear = opts.fiscalYear;
    const month = opts.month;
    const year = calendarYear(fiscalYear, month);
    const dim = daysInMonth(year, month);
    const warnings = [];
    const rows = table.rows;

    let dayOf;
    if (rows.length === dim) {
      dayOf = (r) => r.index + 1;
      // OCRの日付と行番号の一致度
      const ok = rows.filter((r) => r.dayText && Number(r.dayText) === r.index + 1).length;
      if (ok < rows.length * 0.5) warnings.push('日付列の読取りと行番号の一致が少ないため、日付を必ず確認してください。');
    } else {
      warnings.push('表の行数（' + rows.length + '）が' + month + '月の日数（' + dim + '）と一致しません。日付列の文字を使います。');
      dayOf = (r) => {
        const d = Number(r.dayText);
        return d >= 1 && d <= dim ? d : null;
      };
    }

    // 土日の行が網掛けになっているか（年度・月の取り違え検出）
    if (rows.length === dim) {
      let weekendRows = 0; let shadedWeekend = 0;
      rows.forEach((r) => {
        const wd = weekdayOf(year, month, r.index + 1);
        if (wd === 0 || wd === 6) { weekendRows += 1; if (r.shaded) shadedWeekend += 1; }
      });
      const anyShaded = rows.some((r) => r.shaded);
      if (anyShaded && weekendRows && shadedWeekend < weekendRows * 0.6) {
        warnings.push('土日の位置が表と一致しません。年度・月の設定を確認してください。');
      }
    }

    const perDay = rows.map((r) => ({ day: dayOf(r), texts: r.texts, review: r.review })).filter((x) => x.texts.some((t) => t.trim()));
    return { year, month, warnings, perDay };
  }

  // ---------- 貼り付けテキストの解析 ----------
  // 行頭が日付（「5」「5日」「5 月」「10/5」「10月5日」など）の行で区切る
  function splitPastedText(raw, month) {
    const lines = normalizeText(raw).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
    const out = [];
    let cur = null;
    const dayHead = /^(?:(1[0-2]|[1-9])\s*[月/]\s*)?([12]?\d|3[01])\s*日?\s*(?:[(（]?\s*[日月火水木金土]\s*[)）]?)?(?=\s|$|[^\d:年~・])/;
    lines.forEach((line) => {
      const m = dayHead.exec(line);
      const rest = m ? line.slice(m[0].length) : '';
      // 「1年14:10」のように学年で始まる行は日付行ではない
      if (m && !/^\s*年/.test(rest) && !/^\s*[・~]/.test(rest) && !/^\s*:/.test(rest)) {
        const mon = m[1] ? Number(m[1]) : month;
        cur = { month: mon, day: Number(m[2]), text: rest };
        out.push(cur);
      } else if (cur) {
        cur.text += ' ' + line;
      }
    });
    return out;
  }

  // ---------- 候補の生成 ----------
  function makeCandidates(perDay, selectedGrades, year, defaultMonth, sourceLabel) {
    const candidates = [];
    perDay.forEach((row) => {
      const month = row.month || defaultMonth;
      const parsed = row.texts ? parseMulti(row.texts) : parseDismissalText(row.text);
      const hasAny = Object.keys(parsed.times).length > 0;
      if (!hasAny && !parsed.unpaired) return;
      const dateOk = row.day && month && row.day <= daysInMonth(year, month);
      const date = dateOk ? isoDate(year, month, row.day) : '';

      // 同じ時刻の学年をまとめる
      const groups = {};
      const problems = [];
      selectedGrades.forEach((g) => {
        const ts = parsed.times[g];
        if (!ts || ts.length === 0) {
          if (hasAny) problems.push({ grades: [g], reason: g + '年の記載が見つからない' });
          return;
        }
        if (ts.length > 1) { problems.push({ grades: [g], reason: g + '年に複数の時刻' }); return; }
        const t = ts[0];
        const flag = parsed.flags[g];
        const key = t + '|' + (flag || '');
        groups[key] = groups[key] || { time: t, grades: [], flag };
        groups[key].grades.push(g);
      });

      Object.keys(groups).forEach((k) => {
        const gr = groups[k];
        let status = '登録可';
        let eligible = true;
        if (!date) { status = '要確認（日付不明）'; eligible = false; }
        else if (row.review) { status = '要確認（' + row.review + '）'; eligible = false; }
        else if (!isPlausibleTime(gr.time)) { status = '要確認（時刻が不自然）'; eligible = false; }
        else if (gr.flag && gr.flag !== 'NOTE') { status = '要確認（' + gr.flag + '）'; eligible = false; }
        else if (parsed.unpaired) { status = '要確認（読み取れない時刻あり）'; eligible = false; }
        else if (gr.flag === 'NOTE') { status = '登録可（注記あり）'; }
        else if (parsed.corrected) { status = '登録可（学年の区切りを補正）'; }
        candidates.push({
          id: date + '-' + gr.time + '-' + gr.grades.join(''),
          date, time: gr.time, grades: gr.grades.slice().sort(),
          evidence: parsed.text, status, eligible, source: sourceLabel
        });
      });
      problems.forEach((p) => {
        candidates.push({
          id: date + '-x-' + p.grades.join(''), date, time: '', grades: p.grades,
          evidence: parsed.text, status: '要確認（' + p.reason + '）', eligible: false, source: sourceLabel
        });
      });
      if (!hasAny && parsed.unpaired) {
        candidates.push({
          id: date + '-u', date, time: '', grades: selectedGrades.slice(),
          evidence: parsed.text, status: '要確認（学年と時刻を対応付けられない）', eligible: false, source: sourceLabel
        });
      }
    });
    candidates.sort((a, b) => (a.date || '9').localeCompare(b.date || '9') || (a.time || '99').localeCompare(b.time || '99'));
    return candidates;
  }

  // ---------- カレンダー出力 ----------
  function gradeLabel(grades) {
    if (grades.length === 6) return '全学年';
    return grades.join('・') + '年';
  }

  function eventTitle(c) {
    return '下校 ' + c.time + '（' + gradeLabel(c.grades) + '）';
  }

  function icsEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }

  function addMinutes(date, time, mins) {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    const v = new Date(Date.UTC(y, mo - 1, d, h, mi + mins));
    return { date: v.toISOString().slice(0, 10), time: v.toISOString().slice(11, 16) };
  }

  function compact(date, time) {
    return date.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
  }

  function buildIcs(cands, opts) {
    const o = opts || {};
    const dur = o.durationMinutes || 15;
    const alarm = o.alarmMinutes;
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//geko-calendar//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VTIMEZONE', 'TZID:Asia/Tokyo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:JST', 'END:STANDARD', 'END:VTIMEZONE'
    ];
    cands.forEach((c) => {
      const end = addMinutes(c.date, c.time, dur);
      lines.push('BEGIN:VEVENT');
      lines.push('UID:geko-' + c.date.replace(/-/g, '') + '-' + c.time.replace(':', '') + '-g' + c.grades.join('') + '@geko-calendar');
      lines.push('DTSTAMP:' + now);
      lines.push('DTSTART;TZID=Asia/Tokyo:' + compact(c.date, c.time));
      lines.push('DTEND;TZID=Asia/Tokyo:' + compact(end.date, end.time));
      lines.push('SUMMARY:' + icsEscape(eventTitle(c)));
      if (alarm) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape(eventTitle(c)), 'TRIGGER:-PT' + alarm + 'M', 'END:VALARM');
      }
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  function googleCalendarUrl(c, durationMinutes) {
    const end = addMinutes(c.date, c.time, durationMinutes || 15);
    const params = [
      'action=TEMPLATE',
      'text=' + encodeURIComponent(eventTitle(c)),
      'dates=' + compact(c.date, c.time) + '/' + compact(end.date, end.time),
      'ctz=Asia%2FTokyo'
    ];
    return 'https://calendar.google.com/calendar/render?' + params.join('&');
  }

  const api = {
    normalizeText, parseDismissalText, parseMulti, parseGradeSpec, parseHeader, calendarYear, daysInMonth,
    weekdayOf, isoDate, detectGrid, toGray, estimateSkew, rotateGray, readTablePage, mergeTables, buildFromTable, splitPastedText,
    makeCandidates, buildIcs, googleCalendarUrl, eventTitle, gradeLabel, WEEKDAYS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GekoCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
