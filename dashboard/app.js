/* Launch Radar — the desk. A classic script: it reads window.RADAR from ../data.js and renders the
   board, a protocol's detail view and a filtered view into #view. No fetch, no modules, no network. */
(function () {
  'use strict';

  var R = window.RADAR;
  var VIEW = document.getElementById('view');

  var CAT_COLORS = ['#1b3cff', '#bf3b2b', '#1c7a4d', '#a3690f', '#6b4fa8', '#2b7a86', '#8a5a2b', '#4b5a6b'];

  /* ---------------------------------------------------------------- helpers */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    var v = Math.round(Number(n) || 0);
    if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e8 ? 1 : 2) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toLocaleString('en-US');
  }
  function moneyExact(n) {
    return '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  }
  function signed(n, places) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(places == null ? 1 : places) + '%';
  }
  function fixed(n, places) {
    var v = Number(n);
    return isFinite(v) ? v.toFixed(places == null ? 2 : places) : '—';
  }
  function cls(n) {
    return Number(n) < 0 ? 'neg' : Number(n) > 0 ? 'pos' : 'dim';
  }
  function catColor(cat) {
    var i = 0;
    var s = String(cat || '');
    for (var k = 0; k < s.length; k++) i = (i * 31 + s.charCodeAt(k)) % 9973;
    return CAT_COLORS[i % CAT_COLORS.length];
  }

  /* ---------------------------------------------------------------- state */
  var state = { q: '', category: 'all', chain: 'all', view: 'all', sort: 'implied', dir: 'desc' };

  function parseHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return null;
    var out = {};
    h.split('&').forEach(function (pair) {
      var at = pair.indexOf('=');
      if (at < 0) return;
      out[decodeURIComponent(pair.slice(0, at))] = decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
    });
    return out;
  }

  function boardHash(extra) {
    var parts = [];
    if (state.view !== 'all') parts.push('view=' + encodeURIComponent(state.view));
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.category !== 'all') parts.push('category=' + encodeURIComponent(state.category));
    if (state.chain !== 'all') parts.push('chain=' + encodeURIComponent(state.chain));
    if (state.sort !== 'implied' || state.dir !== 'desc') parts.push('sort=' + state.sort + '-' + state.dir);
    if (extra) parts = parts.concat(extra);
    return parts.length ? '#' + parts.join('&') : '#board';
  }

  function syncStateFromHash(h) {
    if (!h) return;
    if (h.view) state.view = h.view;
    if (h.q != null) state.q = h.q;
    if (h.category) state.category = h.category;
    if (h.chain) state.chain = h.chain;
    if (h.sort) {
      var m = /^(implied|tvl|growth|age|multiple)-?(asc|desc)?$/.exec(h.sort);
      if (m) { state.sort = m[1]; state.dir = m[2] || 'desc'; }
    }
  }

  /* ---------------------------------------------------------------- data views */
  var CATEGORIES = (function () {
    var seen = {};
    R.rows.forEach(function (r) { seen[r.category || '—'] = (seen[r.category || '—'] || 0) + 1; });
    return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || (a < b ? -1 : 1); });
  })();
  var CHAINS = (function () {
    var seen = {};
    R.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { seen[c] = (seen[c] || 0) + 1; }); });
    return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || (a < b ? -1 : 1); });
  })();

  function multipleOf(r) { return r.implied_value_usd / r.tvl_usd; }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var rows = R.rows.filter(function (r) {
      if (state.view === 'watchlist' && !r.watchlist) return false;
      if (state.view === 'early' && r.watchlist) return false;
      if (state.category !== 'all' && (r.category || '—') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      return (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + (r.chains || []).join(' ')).toLowerCase().indexOf(q) >= 0;
    });
    var key = state.sort;
    var sign = state.dir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      var av, bv;
      if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d == null ? -1e9 : a.change_7d; bv = b.change_7d == null ? -1e9 : b.change_7d; }
      else if (key === 'age') { av = a.age_days == null ? -1 : a.age_days; bv = b.age_days == null ? -1 : b.age_days; }
      else if (key === 'multiple') { av = multipleOf(a); bv = multipleOf(b); }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av !== bv) return (av - bv) * sign;
      return a.rank - b.rank;
    });
    return rows;
  }

  function rowBySlug(slug) {
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === slug) return R.rows[i];
    return null;
  }

  /* ---------------------------------------------------------------- shared bits */
  function renderTopbar() {
    document.getElementById('as-of').textContent = 'Snapshot ' + R.as_of;
    document.getElementById('count-pill').textContent = R.board_size + ' protocols';
    document.getElementById('version-pill').textContent = 'model ' + R.model_version;
    document.getElementById('foot-repro').textContent = 'node main.ts --input snapshot.json · ' + R.validation.comps_n + ' comps · ' + R.validation.folds + ' folds · seedless';
  }

  function rangeBar(r) {
    var lo = r.model.low_usd || r.implied_value_usd;
    var hi = r.model.high_usd || r.implied_value_usd;
    var min = Math.log10(Math.max(1, lo));
    var max = Math.log10(Math.max(lo * 1.01, hi));
    var at = Math.max(0, Math.min(1, (Math.log10(r.implied_value_usd) - min) / (max - min)));
    return '<div class="rangebar" aria-hidden="true"><i style="left:0;right:0"></i><b style="left:' +
      (at * 100).toFixed(1) + '%"></b></div>';
  }

  function chainsCell(r) {
    var chains = r.chains || [];
    var head = chains.slice(0, 2).join(' · ');
    return head + (chains.length > 2 ? ' +' + (chains.length - 2) : '');
  }

  function boardTable(rows) {
    if (!rows.length) {
      return '<div class="empty">No protocol on the board matches these filters. Clear a chip or widen the search.</div>';
    }
    var head = [
      ['rank', '#'], ['name', 'Protocol'], ['tvl', 'TVL'], ['growth', '7d'],
      ['age', 'Age'], ['implied', 'Implied value'], ['multiple', 'Multiple'], ['farm', 'Farm budget']
    ].map(function (h) {
      var active = state.sort === h[0];
      var aria = active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return '<th scope="col" data-sort="' + h[0] + '" aria-sort="' + aria + '">' + h[1] + '</th>';
    }).join('');
    var body = rows.map(function (r) {
      var f = r.farm;
      var be = f ? f.break_even_pct.toFixed(1) : '—';
      var pos = f ? '$' + f.position_usd : '—';
      return '<tr tabindex="0" data-slug="' + esc(r.slug) + '" data-rank="' + r.rank + '">' +
        '<td class="rk rank num">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span><span class="pmeta">' +
          esc(r.category || 'uncategorised') + ' · ' + esc(chainsCell(r)) +
          (r.watchlist ? ' · <span class="chip wl">watchlist</span>' : '') + '</span></td>' +
        '<td class="r num">' + money(r.tvl_usd) + '</td>' +
        '<td class="r grow ' + cls(r.change_7d) + '">' + (r.change_7d == null ? '—' : signed(r.change_7d)) + '</td>' +
        '<td class="r num">' + (r.age_days == null ? '—' : r.age_days + 'd') + '</td>' +
        '<td class="r"><span class="imp">' + moneyExact(r.implied_value_usd) + '</span>' + rangeBar(r) + '</td>' +
        '<td class="r num">' + fixed(r.implied_value_usd / r.tvl_usd, 2) + '×</td>' +
        '<td class="farmcell"><b>' + pos + '</b> · B/E ' + be + '%</td>' +
        '</tr>';
    }).join('');
    return '<div class="tablewrap"><table class="board"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function controlsHtml(rows) {
    var cats = ['<option value="all">All categories</option>'].concat(CATEGORIES.map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    })).join('');
    var chains = ['<option value="all">All chains</option>'].concat(CHAINS.slice(0, 40).map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    })).join('');
    var sorts = [['implied', 'Implied value'], ['tvl', 'TVL'], ['growth', '7-day growth'], ['age', 'Age'], ['multiple', 'Multiple']].map(function (s) {
      return '<option value="' + s[0] + '"' + (state.sort === s[0] ? ' selected' : '') + '>Sort: ' + s[1] + '</option>';
    }).join('');
    return '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search protocol, category or chain" value="' + esc(state.q) + '" aria-label="Search the board">' +
      '<select id="cat" aria-label="Filter by category">' + cats + '</select>' +
      '<select id="chain" aria-label="Filter by chain">' + chains + '</select>' +
      '<div class="seg" role="group" aria-label="Board scope">' +
        ['all', 'watchlist', 'early'].map(function (v) {
          var label = v === 'all' ? 'All ' + R.board_size : v === 'watchlist' ? 'Watchlist ' + R.universe.watchlist : 'Early ' + R.universe.early;
          return '<button type="button" data-view="' + v + '" aria-pressed="' + (state.view === v) + '">' + label + '</button>';
        }).join('') +
      '</div>' +
      '<select id="sortsel" aria-label="Sort the board">' + sorts + '</select>' +
      '<span class="count-note">' + rows.length + ' of ' + R.board_size + ' rows</span>' +
      '</div>';
  }

  /* ---------------------------------------------------------------- charts */
  function svgScatter(pts, opts) {
    var w = opts.w || 300, h = opts.h || 190, pad = 26;
    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var sx = function (v) { return pad + ((v - x0) / (x1 - x0 || 1)) * (w - pad * 1.4); };
    var sy = function (v) { return h - pad - ((v - y0) / (y1 - y0 || 1)) * (h - pad * 1.4); };
    var out = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(opts.label) + '">';
    out += '<line class="axis" x1="' + pad + '" y1="' + (h - pad) + '" x2="' + (w - 6) + '" y2="' + (h - pad) + '"/>';
    out += '<line class="axis" x1="' + pad + '" y1="6" x2="' + pad + '" y2="' + (h - pad) + '"/>';
    if (opts.diagonal) {
      var lo = Math.min(x0, y0), hi = Math.max(x1, y1);
      out += '<line class="ref" x1="' + (pad + ((lo - x0) / (x1 - x0 || 1)) * (w - pad * 1.4)) + '" y1="' + (h - pad - ((lo - y0) / (y1 - y0 || 1)) * (h - pad * 1.4)) +
        '" x2="' + (pad + ((hi - x0) / (x1 - x0 || 1)) * (w - pad * 1.4)) + '" y2="' + (h - pad - ((hi - y0) / (y1 - y0 || 1)) * (h - pad * 1.4)) + '"/>';
    }
    pts.forEach(function (p) {
      out += '<circle class="pt' + (p.sel ? ' sel' : '') + '" cx="' + sx(p.x).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="' + (p.sel ? 4.2 : 2.4) + '">' +
        (p.label ? '<title>' + esc(p.label) + '</title>' : '') + '</circle>';
    });
    (opts.labels || []).forEach(function (l) {
      out += '<text class="lbl" x="' + (sx(l.x) + 4).toFixed(1) + '" y="' + (sy(l.y) - 3).toFixed(1) + '">' + esc(l.text) + '</text>';
    });
    (opts.ticks || []).forEach(function (t) {
      out += '<text x="' + sx(t.x).toFixed(1) + '" y="' + (h - pad + 10) + '" text-anchor="middle">' + esc(t.text) + '</text>';
    });
    out += '<text x="' + pad + '" y="10">' + esc(opts.ylab || '') + '</text>';
    out += '<text x="' + (w - 6) + '" y="' + (h - pad + 20) + '" text-anchor="end">' + esc(opts.xlab || '') + '</text>';
    out += '</svg>';
    return out;
  }

  function calibrationChart() {
    var pts = R.comps.map(function (c) {
      return { x: Math.log10(Math.max(0.001, c.predicted_multiple)), y: Math.log10(Math.max(0.001, c.multiple)), label: c.name + ': predicted ' + c.predicted_multiple + '×, actual ' + c.multiple + '×' };
    });
    var lo = -2, hi = 2;
    return svgScatter(pts, {
      w: 300, h: 176, label: 'Out-of-fold predicted vs actual mcap/TVL multiple for ' + R.comps.length + ' live comps',
      diagonal: true, xlab: 'predicted log10 multiple', ylab: 'actual',
      ticks: [{ x: lo, text: '0.01×' }, { x: -1, text: '0.1×' }, { x: 0, text: '1×' }, { x: 1, text: '10×' }, { x: hi, text: '100×' }]
    });
  }

  function marketMap(selectedSlug) {
    var pts = R.rows.map(function (r) {
      return { x: Math.log10(Math.max(1, r.tvl_usd)), y: Math.log10(Math.max(1, r.implied_value_usd)), sel: r.slug === selectedSlug, label: r.name + ': TVL ' + money(r.tvl_usd) + ', implied ' + money(r.implied_value_usd) };
    });
    var top = R.rows.slice(0, 8).map(function (r) {
      return { x: Math.log10(Math.max(1, r.tvl_usd)), y: Math.log10(Math.max(1, r.implied_value_usd)), text: r.name.length > 18 ? r.name.slice(0, 17) + '…' : r.name };
    });
    return svgScatter(pts, { w: 300, h: 190, label: 'TVL against implied value for the board', labels: top, xlab: 'log10 TVL', ylab: 'implied' });
  }

  function categoryBars() {
    var cats = R.categories.slice(0, 8);
    var maxAdj = Math.max.apply(null, cats.map(function (c) { return Math.abs(c.adjustment); }).concat([0.01]));
    return '<div class="bars">' + cats.map(function (c) {
      var pct = Math.min(100, (Math.abs(c.adjustment) / maxAdj) * 100);
      return '<div class="bar-row"><span class="nm">' + esc(c.category) + ' <span class="dim">(' + c.n + ')</span></span>' +
        '<span class="vl num">' + fixed(c.median_multiple, 2) + '×</span>' +
        '<span class="track"><i class="' + (c.adjustment < 0 ? 'neg' : '') + '" style="width:' + pct.toFixed(1) + '%"></i></span></div>';
    }).join('') + '</div>' +
      '<div class="legend"><span><i style="background:#1b3cff"></i>positive category adj</span><span><i style="background:#bf3b2b"></i>negative adj</span><span class="dim">bar = |adj|, n = board rows</span></div>';
  }

  /* ---------------------------------------------------------------- board view */
  function heroHtml() {
    var v = R.validation;
    return '<section class="hero">' +
      '<div><p class="kicker">' + R.board_size + ' protocols · ' + R.universe.watchlist + ' watchlist · ' + R.universe.early + ' early · snapshot ' + R.as_of + '</p>' +
      '<h1>Where the next token launch is worth the most</h1>' +
      '<p class="thesis">A comps model fitted on the snapshot\'s own ' + R.live_size + ' live-token protocols prices every tokenless protocol by what its TVL has been worth once a token trades — then hands you the costed plan to farm it before the launch.</p></div>' +
      '<div class="kpis">' +
        '<div class="kpi"><div class="label">Watchlist coverage</div><div class="value mono">' + R.universe.watchlist + '/' + R.universe.watchlist + '</div><div class="sub">every slug on the snapshot\'s watchlist is ranked</div></div>' +
        '<div class="kpi"><div class="label">Board</div><div class="value mono">' + R.board_size + '</div><div class="sub">' + R.universe.early + ' early protocols, ' + R.universe.below_floor + ' below the $' + Math.round(R.floor_usd / 1e6) + 'M floor</div></div>' +
        '<div class="kpi"><div class="label">Median implied value</div><div class="value mono">' + money(R.median_implied_usd) + '</div><div class="sub">across all ' + R.board_size + ' rows at today\'s TVL</div></div>' +
        '<div class="kpi"><div class="label">Model CV error</div><div class="value mono">' + v.mae_log10.toFixed(2) + ' <span class="dim" style="font-size:13px">log10</span></div><div class="sub">out-of-fold MAE · R² ' + v.r2_log.toFixed(2) + ' · ' + v.folds + ' folds</div></div>' +
      '</div></section>';
  }

  function modelCard() {
    var v = R.validation, f = R.fit;
    return '<article class="card"><header><h2>Model <span class="tag">comps fit</span></h2><span class="dim num" style="font-size:10px">' + R.model_version + '</span></header>' +
      '<div class="body">' +
      '<div class="formula">implied = TVL × 10^<em>(fit + category adj)</em><br>fit = ' + f.intercept.toFixed(2) +
        f.coef.map(function (c, i) { return (c >= 0 ? ' + ' : ' − ') + Math.abs(c).toFixed(2) + '·x' + (i + 1); }).join('') + '</div>' +
      '<div class="statgrid">' +
        '<div class="stat"><div class="k">Fit sample</div><div class="v">' + f.sample_n + ' comps</div></div>' +
        '<div class="stat"><div class="k">CV MAE</div><div class="v">' + v.mae_log10.toFixed(3) + '</div></div>' +
        '<div class="stat"><div class="k">R² (log)</div><div class="v">' + v.r2_log.toFixed(3) + '</div></div>' +
        '<div class="stat"><div class="k">80% coverage</div><div class="v">' + (v.coverage_80 * 100).toFixed(0) + '%</div></div>' +
        '<div class="stat"><div class="k">Rank IC</div><div class="v">' + v.spearman.toFixed(2) + '</div></div>' +
        '<div class="stat"><div class="k">Cal. slope</div><div class="v">' + v.calibration_slope.toFixed(2) + '</div></div>' +
      '</div>' +
      '<p class="note">' + v.folds + '-fold out-of-fold predictions; each fold refits on the other four, category effects included. Dotted line is 45°.</p>' +
      calibrationChart() +
      '<p class="note">Every point is one live-token protocol: predicted multiple from the model, actual from its own market cap. TVL and market cap both ≥ $1M, no CEX.</p>' +
      '</div></article>';
  }

  function methodHtml() {
    var v = R.validation;
    return '<section class="method" id="method">' +
      '<div><h2>Method, in one screen</h2>' +
      '<h3>The universe</h3><div class="rule">pre-token: mcap_usd, gecko_id and symbol all null<br>' +
      'not a version marker /\s(V\d+|v\d+|\d+\.\d+)$/<br>' +
      'category not Bridge, Canonical Bridge, Liquid Staking,<br>Liquid Restaking, Restaked BTC, CEX<br>' +
      'no whole word wrapped / staked / staking<br>not beginning with an exchange name</div>' +
      '<p style="margin-top:8px">That yields ' + R.universe.watchlist + ' watchlist rows at or above $' + Math.round(R.floor_usd / 1e6) + 'M, ' + R.universe.above_floor_extra +
      ' more at or above the floor the watchlist\'s parent rule left off it, and ' + R.universe.below_floor + ' below the floor — ' + R.board_size + ' rows in all. The watchlist is the floor, never the ceiling.</p>' +
      '<h3 style="margin-top:14px">The farm economics</h3>' +
      '<p>Position $50 / $100 / $250 / $500 by TVL band; hold 60 / 45 / 30 days by age. Gas $8 Ethereum, $3 Base·Arbitrum·Optimism·Polygon, $1 Solana, $4 otherwise; bridge $2 when the protocol spans chains; opportunity cost 5% a year for the hold. Break-even airdrop % = total cost ÷ position. All costs are estimates for one position, not quotes.</p></div>' +
      '<div><h3>Validation, computed at build time</h3>' +
      '<table class="mini"><tbody>' +
        '<tr><td>Live comps in the fit</td><td class="n">' + v.comps_n + '</td></tr>' +
        '<tr><td>Folds (fnv1a(slug) mod ' + v.folds + ')</td><td class="n">' + v.folds + '</td></tr>' +
        '<tr><td>Out-of-fold MAE, log10</td><td class="n">' + v.mae_log10.toFixed(3) + '</td></tr>' +
        '<tr><td>R² in log space</td><td class="n">' + v.r2_log.toFixed(3) + '</td></tr>' +
        '<tr><td>80% interval coverage</td><td class="n">' + (v.coverage_80 * 100).toFixed(1) + '%</td></tr>' +
        '<tr><td>Spearman rank IC</td><td class="n">' + v.spearman.toFixed(3) + '</td></tr>' +
        '<tr><td>Calibration slope</td><td class="n">' + v.calibration_slope.toFixed(3) + '</td></tr>' +
      '</tbody></table>' +
      '<h3 style="margin-top:14px">Limitations</h3>' +
      '<ul><li>Comps say what a record has been worth, not whether or when a token launches.</li>' +
      '<li>Market multiples are noisy (MAE ≈ ' + v.mae_log10.toFixed(2) + ' dex ≈ ' + (10 ** v.mae_log10).toFixed(1) + '× either way); ranges are wide on purpose.</li>' +
      '<li>TVL is DefiLlama\'s, can be recursive or incentive-inflated; 7-day growth is temporary; age only proxies maturity.</li>' +
      '<li>Live protocols are the fit sample and are never ranked; no row\'s value uses its own market cap.</li></ul>' +
      '<div class="repro">mkdir -p out &amp;&amp; MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json</div></div>' +
      '</section>';
  }

  function renderBoard() {
    var rows = filtered();
    document.title = 'Launch Radar — ' + rows.length + ' tokenless protocols by implied value';
    VIEW.innerHTML = heroHtml() +
      '<div class="desk"><section class="card" id="board"><header><h2>Board <span class="tag">ranked by implied value</span></h2><span class="dim" style="font-size:11px">' + R.as_of + '</span></header>' +
      controlsHtml(rows) + '<div id="table">' + boardTable(rows) + '</div></section>' +
      '<aside class="side">' + modelCard() +
      '<article class="card"><header><h2>Category multiples</h2><span class="dim" style="font-size:10px">top 8 by rows</span></header><div class="body">' + categoryBars() + '</div></article>' +
      '<article class="card"><header><h2>Market map</h2><span class="dim" style="font-size:10px">' + R.board_size + ' rows</span></header><div class="body">' + marketMap() + '</div></article>' +
      '</aside></div>' + methodHtml();
    wireBoard();
  }

  /* ---------------------------------------------------------------- wiring */
  function go(hash) {
    if (location.hash === hash) { route(); return; }
    location.hash = hash;
  }

  function applyState(patch) {
    Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
    var h = boardHash();
    if (h === '#board') h = '#board';
    if (location.hash === h) renderBoard();
    else location.hash = h;
  }

  function wireBoard() {
    var q = document.getElementById('q');
    var timer = null;
    if (q) {
      q.addEventListener('input', function () {
        state.q = q.value;
        clearTimeout(timer);
        timer = setTimeout(function () { applyState({ q: state.q }); }, 220);
      });
    }
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function () { applyState({ category: cat.value }); });
    var chain = document.getElementById('chain');
    if (chain) chain.addEventListener('change', function () { applyState({ chain: chain.value }); });
    var sortsel = document.getElementById('sortsel');
    if (sortsel) sortsel.addEventListener('change', function () { applyState({ sort: sortsel.value, dir: 'desc' }); });
    Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
      b.addEventListener('click', function () { applyState({ view: b.getAttribute('data-view') }); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('th[data-sort]'), function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (key === 'name' || key === 'farm' || key === 'rank') key = 'implied';
        var dir = state.sort === key && state.dir === 'desc' ? 'asc' : 'desc';
        applyState({ sort: key, dir: dir });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-slug]'), function (tr) {
      var slug = tr.getAttribute('data-slug');
      tr.addEventListener('click', function () { go('#p=' + encodeURIComponent(slug)); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('#p=' + encodeURIComponent(slug)); }
      });
    });
  }

  /* ---------------------------------------------------------------- filtered view */
  function chipsHtml() {
    var chips = [];
    if (state.view !== 'all') {
      chips.push('<span class="fchip">view: ' + esc(state.view) + ' <button type="button" data-clear="view" aria-label="Clear the view filter">×</button></span>');
    }
    if (state.q) chips.push('<span class="fchip">search: “' + esc(state.q) + '” <button type="button" data-clear="q" aria-label="Clear the search">×</button></span>');
    if (state.category !== 'all') chips.push('<span class="fchip">category: ' + esc(state.category) + ' <button type="button" data-clear="category" aria-label="Clear the category filter">×</button></span>');
    if (state.chain !== 'all') chips.push('<span class="fchip">chain: ' + esc(state.chain) + ' <button type="button" data-clear="chain" aria-label="Clear the chain filter">×</button></span>');
    if (!chips.length) chips.push('<span class="fchip dim">no filter — showing the whole board</span>');
    return '<div class="chips">' + chips.join('') + '<a href="#board" class="dim" style="margin-left:auto;font:500 10.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase">clear all →</a></div>';
  }

  function distribution(rows) {
    var counts = {};
    rows.forEach(function (r) { var c = r.category || '—'; counts[c] = (counts[c] || 0) + 1; });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
    var total = rows.length || 1;
    return '<div class="dist"><div class="track">' + keys.map(function (c, i) {
      return '<i title="' + esc(c) + ': ' + counts[c] + '" style="width:' + ((counts[c] / total) * 100).toFixed(2) + '%;background:' + CAT_COLORS[i % CAT_COLORS.length] + '"></i>';
    }).join('') + '</div><div class="cap">' + keys.slice(0, 10).map(function (c, i) {
      return '<span><i style="display:inline-block;width:7px;height:7px;background:' + CAT_COLORS[i % CAT_COLORS.length] + ';margin-right:4px"></i>' + esc(c) + ' ' + counts[c] + '</span>';
    }).join('') + (keys.length > 10 ? '<span>+' + (keys.length - 10) + ' more</span>' : '') + '</div></div>';
  }

  function renderFiltered() {
    var rows = filtered();
    var total = rows.reduce(function (a, r) { return a + r.implied_value_usd; }, 0);
    var med = rows.length ? rows.map(function (r) { return r.implied_value_usd; }).sort(function (a, b) { return a - b; })[Math.floor(rows.length / 2)] : 0;
    document.title = 'Launch Radar — filtered view';
    VIEW.innerHTML = '<section class="hero" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)"><div>' +
      '<p class="kicker">Filtered view</p><h1 style="font-size:32px">' + rows.length + ' protocols, ' + money(total) + ' of implied value</h1>' +
      '<p class="thesis">A slice of the ' + R.board_size + '-row board. Click any row for its model inputs and its costed farm plan; the chips carry the filter back to a shareable URL.</p>' +
      '<div style="margin-top:14px">' + chipsHtml() + '</div></div>' +
      '<div class="kpis" style="grid-template-columns:repeat(3,1fr)">' +
        '<div class="kpi"><div class="label">Rows</div><div class="value mono">' + rows.length + '</div><div class="sub">of ' + R.board_size + '</div></div>' +
        '<div class="kpi"><div class="label">Median implied</div><div class="value mono" style="font-size:18px">' + money(med) + '</div><div class="sub">this slice</div></div>' +
        '<div class="kpi"><div class="label">Total implied</div><div class="value mono" style="font-size:18px">' + money(total) + '</div><div class="sub">sum of rows</div></div>' +
      '</div></section>' +
      '<section class="card" style="margin-top:20px"><header><h2>Category distribution <span class="tag">' + rows.length + ' rows</span></h2></header><div class="body">' + distribution(rows) + '</div></section>' +
      '<section class="card" style="margin-top:16px"><header><h2>Board <span class="tag">filtered</span></h2><span class="dim" style="font-size:11px">' + R.as_of + '</span></header>' +
      controlsHtml(rows) + '<div id="table">' + boardTable(rows) + '</div></section>';
    wireBoard();
    Array.prototype.forEach.call(document.querySelectorAll('[data-clear]'), function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-clear');
        var patch = {};
        patch[k] = k === 'view' ? 'all' : k === 'category' || k === 'chain' ? 'all' : '';
        applyState(patch);
      });
    });
  }
  /* ---------------------------------------------------------------- detail view */
  function statCell(k, v, note) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' +
      (note ? '<div class="sub" style="font:400 9.5px/1.25 var(--sans);color:var(--muted);margin-top:4px">' + esc(note) + '</div>' : '') + '</div>';
  }

  function detailSteps(r) {
    return '<ol class="timeline">' + r.farm_steps.map(function (s, i) {
      var m = /Cost:\s*(.*?)\.?\s*Time:\s*(.*)$/.exec(s);
      var body = m ? s.slice(0, m.index).trim() : s;
      var cost = m ? 'Cost: ' + m[1].trim() + ' · Time: ' + m[2].trim() : '';
      return '<li' + (i === r.farm_steps.length - 1 ? ' class="last"' : '') + '><span class="step">' + (i + 1) + '</span><div><p>' +
        esc(body) + (cost ? '<span class="cost">' + esc(cost) + '</span>' : '') + '</p></div></li>';
    }).join('') + '</ol>';
  }

  function whyHtml(r) {
    var m = r.model;
    var flags = [];
    flags.push(r.watchlist
      ? ['ok', 'Watchlist', 'On the snapshot\'s 40-slug watchlist, so the board covers the floor.']
      : ['', 'Early row', 'Outside the watchlist but tokenless and admitted by the full rule; ' +
          (r.tvl_usd >= R.floor_usd ? 'above the floor as an extra.' : 'below the $' + Math.round(R.floor_usd / 1e6) + 'M floor.')]);
    flags.push(m.comps_n >= 5
      ? ['ok', 'Comps', m.comps_n + ' live ' + (r.category || '') + ' protocols price this category; the effect is shrunk ' + m.comps_n + '/(' + m.comps_n + '+8).']
      : ['', 'Thin comps', m.comps_n + ' live ' + (r.category || '') + ' protocols price this category; the effect is shrunk hard toward zero.']);
    flags.push(r.change_7d == null
      ? ['', 'No 7-day print', 'The snapshot carries no seven-day TVL change; the growth term is held at zero.']
      : [r.change_7d >= 0 ? 'ok' : '', '7-day growth', (r.change_7d >= 0 ? 'TVL grew ' : 'TVL fell ') + Math.abs(r.change_7d).toFixed(1) + '% in seven days; the model ' + (r.change_7d >= 0 ? 'raises' : 'lowers') + ' the multiple ' + fixed(Math.abs(m.growth_multiplier - 1) * 100, 1) + '%.']);
    flags.push((r.age_days || 0) <= 180
      ? ['', 'Young record', (r.age_days == null ? 'No listing date' : r.age_days + ' days') + ' tokenless; the maturity term discounts the multiple to ' + fixed(m.maturity_multiplier, 2) + '×.']
      : ['ok', 'Long record', r.age_days + ' days tokenless; the maturity term lifts the multiple to ' + fixed(m.maturity_multiplier, 2) + '×.']);
    return '<div class="why">' + flags.map(function (f) {
      return '<div class="flag ' + f[0] + '"><b>' + esc(f[1]) + '</b><span>' + esc(f[2]) + '</span></div>';
    }).join('') + '</div>';
  }

  function compsTable(r) {
    var list = R.comps.filter(function (c) { return (c.category || '—') === (r.category || '—'); })
      .sort(function (a, b) { return b.tvl_usd - a.tvl_usd; }).slice(0, 5);
    if (!list.length) return '<p class="note">No live protocol in this category is a comp; the category effect is zero.</p>';
    return '<table class="mini"><thead><tr><th>Live comp</th><th>TVL</th><th>Mcap/TVL</th></tr></thead><tbody>' +
      list.map(function (c) {
        return '<tr><td>' + esc(c.name) + '</td><td class="n">' + money(c.tvl_usd) + '</td><td class="n">' + fixed(c.multiple, 2) + '×</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="note">The five largest live ' + esc(r.category || '') + ' protocols, shown as context. The model learns one pooled category effect from all ' + r.model.comps_n + ' comps, not from any single row.</p>';
  }

  function renderDetail(slug) {
    var r = rowBySlug(slug);
    if (!r) { renderBoard(); return; }
    var m = r.model, f = r.farm;
    document.title = 'Launch Radar — ' + r.name;
    VIEW.innerHTML =
      '<section class="detail-head"><div>' +
        '<a class="backlink" href="#board">← The board</a>' +
        '<h1>' + esc(r.name) + '</h1>' +
        '<div class="tags"><span class="chip">#' + r.rank + ' of ' + R.board_size + '</span>' +
          '<span class="chip">' + esc(r.category || 'uncategorised') + '</span>' +
          (r.chains || []).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') +
          (r.watchlist ? '<span class="chip wl">watchlist</span>' : '<span class="chip">early</span>') + '</div>' +
        '<p class="thesis" style="margin-top:12px">A tokenless protocol with ' + money(r.tvl_usd) + ' of TVL, ' +
          (r.change_7d == null ? 'no seven-day print' : signed(r.change_7d) + ' in seven days') + ' and ' +
          (r.age_days == null ? 'no listing date' : r.age_days + ' days') + ' on record. The comps fit prices it at ' +
          fixed(multipleOf(r), 2) + '× TVL, with a range of ' + money(m.low_usd) + ' to ' + money(m.high_usd) + '.</p>' +
      '</div><div class="bignum"><div class="v">' + moneyExact(r.implied_value_usd) + '</div>' +
        '<div class="r">implied value · ' + fixed(multipleOf(r), 2) + '× TVL</div>' +
        '<div class="r">' + money(m.low_usd) + ' – ' + money(m.high_usd) + ' range</div></div></section>' +
      '<div class="detail-grid"><div class="side">' +
        '<article class="card"><header><h2>Farm plan</h2><span class="tag">one position · ' + f.hold_days + ' days</span></header><div class="body">' +
          '<div class="kv">' +
            '<div><div class="k">Position</div><div class="v">$' + f.position_usd + '</div></div>' +
            '<div><div class="k">Total cost</div><div class="v">$' + f.total_cost_usd.toFixed(2) + '</div></div>' +
            '<div><div class="k">Break-even</div><div class="v">' + f.break_even_pct.toFixed(2) + '%</div></div>' +
            '<div><div class="k">Hold</div><div class="v">' + f.hold_days + ' d</div></div>' +
          '</div>' +
          '<div class="kv" style="grid-template-columns:repeat(3,1fr);margin-top:10px">' +
            '<div><div class="k">Net at 10%</div><div class="v">$' + f.net_10_usd.toFixed(2) + '</div></div>' +
            '<div><div class="k">Net at 25%</div><div class="v">$' + f.net_25_usd.toFixed(2) + '</div></div>' +
            '<div><div class="k">Net at 50%</div><div class="v">$' + f.net_50_usd.toFixed(2) + '</div></div>' +
          '</div>' +
          detailSteps(r) +
          '<p class="note">Costs are estimates for one position, not quotes: gas is $' + f.gas_usd.toFixed(2) + ', bridge $' + f.bridge_usd.toFixed(2) +
            ', opportunity cost $' + f.opportunity_usd.toFixed(2) + ' at 5% a year for ' + f.hold_days + ' days. Break-even is the airdrop as a share of the position. Taxes and slippage are excluded.</p>' +
        '</div></article>' +
        '<article class="card"><header><h2>Why this rank</h2><span class="tag">inputs, not names</span></header><div class="body">' + whyHtml(r) + '</div></article>' +
      '</div><aside class="side">' +
        '<article class="card"><header><h2>Model inputs</h2><span class="tag">comps fit</span></header><div class="body">' +
          '<div class="formula">base ' + fixed(m.base_multiple, 4) + ' × growth ' + fixed(m.growth_multiplier, 4) + ' × maturity ' + fixed(m.maturity_multiplier, 4) + ' = <em>' + fixed(multipleOf(r), 2) + '×</em></div>' +
          '<div class="statgrid">' +
            statCell('TVL', money(r.tvl_usd)) +
            statCell('7-day growth', (m.growth_pct >= 0 ? '+' : '') + m.growth_pct.toFixed(2) + '%') +
            statCell('Age', m.age_days + ' d') +
            statCell('Comps', String(m.comps_n)) +
            statCell('Category adj', (m.category_adj >= 0 ? '+' : '') + m.category_adj.toFixed(3)) +
            statCell('80% range', money(m.low_usd) + '–' + money(m.high_usd)) +
          '</div>' +
          '<p class="note">base_multiple folds in the category adjustment; the three factors multiply to the implied multiple. The range is the out-of-fold 10th–90th percentile residual, widened when the category has few comps.</p>' +
          '<p class="note">The fit has ' + R.fit.sample_n + ' live comps, ' + R.validation.folds + '-fold CV, MAE ' + R.validation.mae_log10.toFixed(3) + ' log10, R² ' + R.validation.r2_log.toFixed(3) + ', 80% coverage ' + (R.validation.coverage_80 * 100).toFixed(0) + '% and rank IC ' + R.validation.spearman.toFixed(2) + '.</p>' +
        '</div></article>' +
        '<article class="card"><header><h2>Category comps</h2><span class="tag">' + esc(r.category || '—') + '</span></header><div class="body">' + compsTable(r) + '</div></article>' +
      '</aside></div>';
  }

  /* ---------------------------------------------------------------- route */
  function route() {
    var h = parseHash();
    if (h && h.p) { renderDetail(h.p); return; }
    if (h && (h.view || h.q || h.category || h.chain)) {
      syncStateFromHash(h);
      renderFiltered();
      return;
    }
    if (h && h.sort) syncStateFromHash(h);
    else if (!h) {
      state.q = ''; state.category = 'all'; state.chain = 'all'; state.view = 'all'; state.sort = 'implied'; state.dir = 'desc';
    }
    renderBoard();
  }

  renderTopbar();
  window.addEventListener('hashchange', route);
  route();

})();
