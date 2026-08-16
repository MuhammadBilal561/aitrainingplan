(function () {
  'use strict';

  window.addEventListener('error', function () {
    if (document.body) document.body.setAttribute('data-runtime-error', '1');
  });

  // --- Build-time guard: bail quietly if the core module failed to load. ---
  if (!window.ATPPlan) {
    if (document.body) document.body.setAttribute('data-runtime-error', '1');
    return;
  }

  var PL = window.ATPPlan;

  var els = {
    week: document.getElementById('plan-week'),
    stats: document.getElementById('week-stats'),
    summaryPanel: document.querySelector('.panel--coach'),
    summaryTitle: document.getElementById('adapt-title'),
    summaryList: document.getElementById('adapt-list'),
    summaryStats: document.getElementById('adapt-stats'),
    reset: document.getElementById('btn-reset'),
    hint: document.getElementById('plan-hint')
  };

  var baseWeek = PL.buildWeek();
  var baseById = {};
  baseWeek.forEach(function (d) { baseById[d.id] = d; });
  function isOriginallyWorkout(id) {
    return !!baseById[id] && baseById[id].type !== 'rest';
  }

  var missedId = null;
  var state = { missedId: missedId, week: baseWeek, result: null };

  var FLAG_CHIPS = {
    missed: { text: 'Missed', cls: 'chip--coral' },
    rescheduled: { text: 'Rescheduled', cls: 'chip--coral' },
    'became-rest': { text: 'Now rest', cls: 'chip--grey' },
    dropped: { text: 'Easy run dropped', cls: 'chip--grey' },
    'replaced-easy': { text: 'Replaced easy run', cls: 'chip--blue' },
    'rolls-to-next-week': { text: 'Carries to next week', cls: 'chip--blue' }
  };
  var MOVED_TO_RE = /^moved-to-(.+)$/;
  var MOVED_FROM_RE = /^moved-from-(.+)$/;

  function labelFor(dow) {
    return dow.charAt(0) + dow.slice(1);
  }

  function renderWeek() {
    var html = '';
    state.week.forEach(function (day, idx) {
      var chips = day.flags.map(function (f) {
        var m = f.match(MOVED_TO_RE);
        if (m) {
          return '<span class="chip chip--blue">Moved to ' + labelFor(baseById[m[1]].dow) + '</span>';
        }
        m = f.match(MOVED_FROM_RE);
        if (m) return '';
        var def = FLAG_CHIPS[f];
        return def ? '<span class="chip ' + def.cls + '">' + def.text + '</span>' : '';
      }).join('');

      var isMissed = missedId === day.id;
      var canMark = isOriginallyWorkout(day.id);
      var isRestType = day.type === 'rest';

      var toggle = '';
      if (isMissed) {
        toggle = '<button type="button" class="day__toggle" data-action="restore" aria-label="Restore ' + day.dow + ' to the original plan">Restore original plan</button>';
      } else if (canMark && !isRestType) {
        toggle = '<button type="button" class="day__toggle" data-action="miss" aria-label="Mark ' + day.dow + ' as missed">Mark as missed</button>';
      } else if (isRestType) {
        toggle = '<span class="day__restnote">Rest \u2014 nothing to miss</span>';
      } else {
        toggle = '<span class="day__restnote">Reshuffled in automatically</span>';
      }

      var cls = 'day day--' + day.type;
      if (isMissed) cls += ' day--missed';
      if (day.flags.indexOf('rescheduled') !== -1) cls += ' day--rescheduled';

      html += '' +
        '<article class="' + cls + '" data-day="' + day.id + '" data-index="' + idx + '" style="--di:' + idx + '">' +
          '<div class="day__top">' +
            '<span class="day__dow">' + day.dow + '</span>' +
            '<span class="day__badge day__badge--' + day.type + '">' + badgeText(day.type) + '</span>' +
          '</div>' +
          '<h3 class="day__title">' + day.title + '</h3>' +
          '<p class="day__meta">' + (day.type === 'rest' ? 'Recovery slot' : minuteLabel(day.durationMin)) + '</p>' +
          '<p class="day__desc">' + day.desc + '</p>' +
          (day.steps ? '<div class="day__steps" aria-hidden="true">' + day.steps.map(stripBar).join('') + '</div>' : '') +
          (chips ? '<div class="day__chips">' + chips + '</div>' : '') +
          '<div class="day__foot">' + toggle + '</div>' +
        '</article>';
    });
    els.week.innerHTML = html;
  }

  function badgeText(type) {
    if (type === 'key') return 'Key session';
    if (type === 'easy') return 'Easy run';
    return 'Rest';
  }

  function stripBar(v) {
    var cls = v >= 0.9 ? 'on' : (v >= 0.5 ? 'mid' : '');
    return '<i class="' + cls + '"></i>';
  }

  function minuteLabel(min) {
    return min + ' min';
  }

  function renderStats() {
    if (!state.result) {
      var s = PL.weeklyStats(baseWeek);
      els.stats.innerHTML =
        '<div class="stat"><span class="stat__value">' + s.minutes + '</span><span class="stat__label">planned volume</span></div>' +
        '<div class="stat"><span class="stat__value">' + s.sessions + '</span><span class="stat__label">planned sessions</span></div>';
      return;
    }
    var before = state.result.stats.before;
    var after = state.result.stats.after;
    var minDelta = after.minutes - before.minutes;
    var sesDelta = after.sessions - before.sessions;
    els.stats.innerHTML =
      '<div class="stat">' +
        '<span class="stat__value stat__value--flash">' + after.minutes + ' <em class="stat__delta' + deltaCls(minDelta) + '">' + signed(minDelta) + '</em></span>' +
        '<span class="stat__label">weekly volume (min)</span>' +
      '</div>' +
      '<div class="stat">' +
        '<span class="stat__value stat__value--flash">' + after.sessions + ' <em class="stat__delta' + deltaCls(sesDelta) + '">' + signed(sesDelta) + '</em></span>' +
        '<span class="stat__label">sessions</span>' +
      '</div>';
  }

  function deltaCls(n) {
    if (n < 0) return ' stat__delta--neg';
    if (n > 0) return ' stat__delta--pos';
    return ' stat__delta--zero';
  }

  function signed(n) {
    if (n === 0) return '\u00b10';
    return (n > 0 ? '+' : '\u2212') + Math.abs(n);
  }

  function renderSummary() {
    if (!state.result) {
      els.summaryTitle.textContent = 'Try it';
      els.summaryList.innerHTML = '<li>Tap any workout and choose <strong>Mark as missed</strong>. The planner reassigns the week based on the session you skipped and tells you why.</li>';
      els.summaryStats.textContent = '';
      if (els.summaryPanel) els.summaryPanel.classList.remove('is-active');
      return;
    }
    var r = state.result;
    var changed = r.week.filter(function (d) { return d.flags.length > 0; }).length;
    els.summaryTitle.textContent = 'Your plan just adapted';
    els.summaryList.innerHTML = r.notes.map(function (n) {
      return '<li>' + n + '</li>';
    }).join('');
    els.summaryStats.textContent = changed + ' day' + (changed === 1 ? '' : 's') + ' reshuffled to keep the week balanced.';
    if (els.summaryPanel) els.summaryPanel.classList.add('is-active');
  }

  function render() {
    state.missedId = missedId;
    state.result = missedId ? PL.adapt(baseWeek, missedId) : null;
    state.week = state.result ? state.result.week : baseWeek;

    renderWeek();
    renderStats();
    renderSummary();
    renderTrend();
    drawReshuffleArrow();

    localStorage.setItem('atp:missed', missedId || '');
  }

  // --- Performance curve (CTL/ATL/TSB projected forward deterministically). ---
  // Seeds a steady-state athlete, replays the anchored past week, then runs the
  // plan days through the standard Chronic/Acute load model. Pure and
  // deterministic: depends only on the week array handed to it.
  function pmSeries(week) {
    var context = [0, 40, 60, 40, 0, 45, 0];
    var loads = context.concat(week.map(function (d) {
      return d.type === 'rest' ? 0 : d.durationMin;
    }));
    var ctl = 60;
    var atl = 46;
    var tsb = [];
    var ctlArr = [];
    var atlArr = [];
    loads.forEach(function (l) {
      ctl += (l - ctl) / 42;
      atl += (l - atl) / 7;
      ctlArr.push(ctl);
      atlArr.push(atl);
      tsb.push(ctl - atl);
    });
    return { tsb: tsb, ctl: ctlArr, atl: atlArr };
  }

  var TREND_W = 620;
  var TREND_H = 104;
  var TREND_PAD = 8;

  function trendPath(vals, range) {
    var n = vals.length;
    var xStep = (TREND_W - TREND_PAD * 2) / (n - 1);
    var span = range.max - range.min || 1;
    var pts = [];
    for (var i = 0; i < n; i++) {
      var x = TREND_PAD + i * xStep;
      var y = TREND_PAD + (1 - (vals[i] - range.min) / span) * (TREND_H - TREND_PAD * 2);
      pts.push(x.toFixed(1) + ' ' + y.toFixed(1));
    }
    return 'M' + pts.join(' L');
  }

  function fmt1(v) {
    return (v >= 0 ? '+' : '\u2212') + Math.abs(v).toFixed(1);
  }

  function renderTrend() {
    var svg = document.getElementById('trend-svg');
    var readout = document.getElementById('trend-readout');
    var legend = document.getElementById('trend-legend-adapted');
    if (!svg || !readout || !legend) return;

    var planned = pmSeries(baseWeek);
    var adjusted = !!missedId;
    var adapted = adjusted ? pmSeries(state.week) : null;

    var lo = Math.min.apply(null, planned.tsb);
    var hi = Math.max.apply(null, planned.tsb);
    if (adapted) {
      lo = Math.min(lo, Math.min.apply(null, adapted.tsb));
      hi = Math.max(hi, Math.max.apply(null, adapted.tsb));
    }
    var range = { min: lo, max: hi };

    var plannedD = trendPath(planned.tsb, range);
    var adaptedD = adapted ? trendPath(adapted.tsb, range) : '';

    var plannedPath = document.getElementById('trend-planned');
    var adaptedPath = document.getElementById('trend-adapted');
    plannedPath.setAttribute('d', plannedD);
    adaptedPath.setAttribute('d', adaptedD);

    var formNow = fmt1(planned.tsb[6]);
    var fatigueNow = Math.round(planned.atl[6]);
    var avgNext = function (s) {
      var sum = 0;
      for (var j = 7; j < s.length; j++) sum += s[j];
      return sum / (s.length - 7);
    };
    var projected = fmt1(adjusted ? avgNext(adapted.tsb) : avgNext(planned.tsb));

    readout.innerHTML = '<span class="trend__k">Form</span><b>' + formNow + '</b>' +
      '<span class="trend__k">Fatigue</span><b>' + fatigueNow + '</b>' +
      '<span class="trend__k">7d form</span><b>' + projected + '</b>' +
      (adjusted ? '<em class="trend__tag">live-rebalanced</em>' : '');

    legend.textContent = '';
    var lg = document.createElement('i');
    lg.className = 'lg--adapted';
    legend.appendChild(lg);
    legend.appendChild(document.createTextNode(
      adjusted ? ' With ' + baseById[missedId].dow + ' missed' : ' With a session missed'
    ));
    legend.classList.toggle('is-hidden', !adjusted);

    svg.classList.toggle('trend--adapted', adjusted);
  }

  // --- Cursor-tracked glow on the plan panel (interaction signature). ---
  var glowBound = false;
  function bindGlow() {
    if (glowBound) return;
    var panel = document.querySelector('.plan-panel');
    if (!panel) return;
    glowBound = true;
    panel.addEventListener('pointermove', function (ev) {
      var r = panel.getBoundingClientRect();
      panel.style.setProperty('--gx', ((ev.clientX - r.left) / r.width * 100).toFixed(1) + '%');
      panel.style.setProperty('--gy', ((ev.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      panel.classList.add('is-glowing');
    });
    panel.addEventListener('pointerleave', function () {
      panel.classList.remove('is-glowing');
    });
  }

  function drawReshuffleArrow() {
    var svg = document.getElementById('reshuffle-arrow');
    if (!svg) return;

    var src = null;
    var targetId = null;
    Array.prototype.forEach.call(document.querySelectorAll('.day'), function (el) {
      Array.prototype.forEach.call(el.querySelectorAll('.chip'), function (chip) {
        var m = chip.textContent.match(/^Moved to ([A-Z][a-z]+)$/);
        if (m) { src = el; targetId = m[1].toLowerCase(); }
      });
    });

    var tgt = targetId ? document.querySelector('.day[data-day="' + targetId + '"]') : null;
    if (!src || !tgt) {
      svg.classList.remove('is-active');
      return;
    }

    var wrap = document.querySelector('.week-wrap');
    if (!wrap) {
      svg.classList.remove('is-active');
      return;
    }

    // One-off scan sweep across the plan while it reshuffles.
    wrap.classList.remove('is-adapting');
    void wrap.getBoundingClientRect();
    wrap.classList.add('is-adapting');
    clearTimeout(drawReshuffleArrow.scanTimer);
    drawReshuffleArrow.scanTimer = setTimeout(function () {
      wrap.classList.remove('is-adapting');
    }, 1150);

    var wr = wrap.getBoundingClientRect();
    var s = src.getBoundingClientRect();
    var t = tgt.getBoundingClientRect();
    var w = Math.max(wr.width, 1);
    var h = Math.max(wr.height, 1);

    svg.setAttribute('viewBox', '0 0 ' + w.toFixed(0) + ' ' + h.toFixed(0));
    var x1 = s.left - wr.left + s.width / 2;
    var y1 = s.top - wr.top + s.height * 0.85;
    var x2 = t.left - wr.left + t.width / 2;
    var y2 = t.top - wr.top + s.height * 0.2;
    var mx = (x1 + x2) / 2;
    var d = 'M ' + x1.toFixed(0) + ' ' + y1.toFixed(0) +
      ' C ' + mx.toFixed(0) + ' ' + y1.toFixed(0) +
      ', ' + mx.toFixed(0) + ' ' + y2.toFixed(0) +
      ', ' + x2.toFixed(0) + ' ' + y2.toFixed(0);

    svg.innerHTML = '<path d="' + d + '"/>' +
      '<circle class="reshuffle-head" cx="' + x2.toFixed(0) + '" cy="' + y2.toFixed(0) + '" r="4"/>';

    svg.classList.remove('is-active');
    void svg.getBoundingClientRect();
    svg.classList.add('is-active');
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawReshuffleArrow, 150);
  });

  // --- Events ---
  els.week.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-action]');
    var card = ev.target.closest('[data-day]');
    if (btn && card && btn.dataset.action === 'restore') {
      missedId = null;
      render();
      return;
    }
    if (btn && card && btn.dataset.action === 'miss') {
      missedId = card.getAttribute('data-day');
      render();
      return;
    }
  });

  els.reset.addEventListener('click', function () {
    missedId = null;
    render();
  });

  // Restore last interaction so a refresh keeps the demo state (immaterial to
  // the logic, purely cosmetic).
  var saved = null;
  try { saved = localStorage.getItem('atp:missed'); } catch (e) { saved = null; }
  if (saved) {
    var has = baseWeek.some(function (d) { return d.id === saved && d.type !== 'rest'; });
    if (has) missedId = saved;
  }

  render();
  bindGlow();
  document.body.setAttribute('data-app-ready', 'true');
})();