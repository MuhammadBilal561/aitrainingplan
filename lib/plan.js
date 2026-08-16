(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ATPPlan = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var REST_DESC = 'Active recovery, mobility, or complete rest';

  function restDay(day) {
    return {
      id: day.id,
      dow: day.dow,
      type: 'rest',
      title: 'Rest',
      durationMin: 0,
      desc: REST_DESC,
      flags: []
    };
  }

  function cloneDay(day) {
    return {
      id: day.id,
      dow: day.dow,
      type: day.type,
      title: day.title,
      durationMin: day.durationMin,
      desc: day.desc,
      flags: day.flags ? day.flags.slice() : [],
      steps: day.steps ? day.steps.slice() : undefined
    };
  }

  function buildWeek() {
    return [
      { id: 'mon', dow: 'Mon', type: 'rest', title: 'Rest', durationMin: 0, desc: 'Active recovery, mobility, or complete rest', flags: [] },
      { id: 'tue', dow: 'Tue', type: 'easy', title: 'Easy Run', durationMin: 40, desc: 'Conversational pace, aerobic base', flags: [], steps: [0.55, 0.6, 0.65] },
      { id: 'wed', dow: 'Wed', type: 'key', title: 'Tempo Intervals', durationMin: 60, desc: '4 × 6 min at threshold, 3 min easy between', flags: [], steps: [1, 0.25, 1, 0.25, 1, 0.25, 1] },
      { id: 'thu', dow: 'Thu', type: 'easy', title: 'Easy Run', durationMin: 35, desc: 'Recovery jog, relaxed effort', flags: [], steps: [0.6, 0.6] },
      { id: 'fri', dow: 'Fri', type: 'rest', title: 'Rest', durationMin: 0, desc: 'Full rest', flags: [] },
      { id: 'sat', dow: 'Sat', type: 'easy', title: 'Easy Run', durationMin: 45, desc: 'Steady, comfortable', flags: [], steps: [0.7, 0.7] },
      { id: 'sun', dow: 'Sun', type: 'key', title: 'Long Run', durationMin: 90, desc: 'Zone 2, easy conversational', flags: [], steps: [0.7, 0.75, 0.8, 0.85] }
    ];
  }

  function weeklyStats(week) {
    var sessions = 0;
    var minutes = 0;
    for (var i = 0; i < week.length; i++) {
      if (week[i].type !== 'rest') {
        sessions += 1;
        minutes += week[i].durationMin;
      }
    }
    return { sessions: sessions, minutes: minutes };
  }

  function minuteLabel(min) {
    return min + ' min';
  }

  //
  // Deterministic adaptation. Given a base week and the id of a missed day,
  // returns { week, notes, stats } where stats = { before, after }.
  //
  // Rules (simple, no randomness, no ML):
  //  - Rest days are never reschedulable.
  //  - Key sessions (quality + long run) are preserved: shifted to the first
  //    later Rest day (preferred) or Easy day; if no later slot exists, the
  //    session rolls into the following week instead of being dropped.
  //  - Easy sessions are flexible: dropped, and their day becomes Rest.
  //
  function adapt(week, missedId) {
    var result = [];
    for (var k = 0; k < week.length; k++) result.push(cloneDay(week[k]));

    var statsBefore = weeklyStats(result);
    var i = -1;
    for (var m = 0; m < result.length; m++) {
      if (result[m].id === missedId) { i = m; break; }
    }

    if (i === -1) {
      return {
        week: result,
        notes: ["Couldn't find that day in the plan."],
        stats: { before: statsBefore, after: statsBefore }
      };
    }

    var missed = result[i];
    if (missed.type === 'rest') {
      return {
        week: result,
        notes: ['Rest days are flexible — nothing to reschedule. Pick a workout day instead.'],
        stats: { before: statsBefore, after: statsBefore }
      };
    }

    if (missed.type === 'key') {
      var moved = cloneDay(missed);
      moved.flags.push('rescheduled');
      missed.flags.push('missed');

      // Preferred target: first later Rest day; fallback: first later Easy day.
      var targetJ = -1;
      for (var t = i + 1; t < result.length; t++) {
        if (result[t].type === 'rest') { targetJ = t; break; }
      }
      var usedEasy = false;
      if (targetJ === -1) {
        for (var e = i + 1; e < result.length; e++) {
          if (result[e].type === 'easy') { targetJ = e; usedEasy = true; break; }
        }
      }

      if (targetJ !== -1) {
        var target = result[targetJ];
        var targetWasRest = target.type === 'rest';

        result[i] = restDay(missed);
        result[i].flags.push('missed');
        result[i].flags.push('became-rest');
        result[i].flags.push('moved-to-' + target.id);
        // The target slot keeps its own identity; only its content is swapped.
        result[targetJ] = {
          id: target.id,
          dow: target.dow,
          type: moved.type,
          title: moved.title,
          durationMin: moved.durationMin,
          desc: moved.desc,
          flags: ['rescheduled', 'moved-from-' + missed.id],
          steps: moved.steps ? moved.steps.slice() : undefined
        };
        if (!targetWasRest) result[targetJ].flags.push('replaced-easy');

        var notes = [];
        notes.push(missed.dow + "'s " + missed.title + ' was missed.');
        if (targetWasRest) {
          notes.push('It moved to ' + target.dow + ' (a rest day), so the key session is preserved.');
          notes.push(missed.dow + ' is now Rest — ' + target.dow + "'s recovery moved there instead.");
        } else {
          notes.push('It moved to ' + target.dow + ", which replaces that day's easy run to keep the week balanced.");
          notes.push(target.dow + ' becomes ' + moved.title + '; the easy run is dropped.');
        }
        return {
          week: result,
          notes: notes,
          stats: { before: statsBefore, after: weeklyStats(result) }
        };
      }

      // No slot later this week -> rolls into next week's build.
      result[i] = restDay(missed);
      result[i].flags.push('missed');
      result[i].flags.push('became-rest');
      result[i].flags.push('rolls-to-next-week');
      return {
        week: result,
        notes: [
          missed.dow + "'s " + missed.title + ' was missed.',
          'No recovery slot is left later this week, so it carries into next week\u2019s build instead.',
          missed.dow + ' becomes Rest so load stays manageable going into the next block.'
        ],
        stats: { before: statsBefore, after: weeklyStats(result) }
      };
    }

    // Easy session: drop it, turn the day into rest (extra recovery).
    result[i] = restDay(missed);
    result[i].flags.push('missed');
    result[i].flags.push('became-rest');
    result[i].flags.push('dropped');
    var statsAfter = weeklyStats(result);
    return {
      week: result,
      notes: [
        missed.dow + "'s " + missed.title + ' was missed.',
        'Easy runs are flexible, so it was dropped rather than pushed around.',
        missed.dow + ' becomes Rest — a little extra recovery before the next session.',
        'Weekly volume: ' + minuteLabel(statsBefore.minutes) + ' \u2192 ' + minuteLabel(statsAfter.minutes) + '.'
      ],
      stats: { before: statsBefore, after: statsAfter }
    };
  }

  return {
    buildWeek: buildWeek,
    adapt: adapt,
    weeklyStats: weeklyStats
  };
});