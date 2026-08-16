'use strict';

const assert = require('assert');
const PL = require('../lib/plan.js');

let pass = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL  ' + name + '\n        ' + err.message);
  }
}

function ids(week) {
  return week.map(d => d.id + ':' + d.type + ':' + d.title).join(' | ');
}

const base = PL.buildWeek();

t('buildWeek returns a valid 7-day running plan', () => {
  assert.strictEqual(base.length, 7);
  const types = base.map(d => d.type);
  assert.deepStrictEqual(types.sort(), ['easy', 'easy', 'easy', 'key', 'key', 'rest', 'rest']);
  base.forEach((d, i) => {
    assert.ok(d.id && d.dow && d.title, 'day ' + i + ' missing fields');
    assert.ok(Array.isArray(d.flags), 'day ' + i + ' needs flags array');
    assert.ok(Number.isInteger(d.durationMin) && d.durationMin >= 0, 'day ' + i + ' bad duration');
  });
});

t('weeklyStats counts sessions and minutes correctly', () => {
  const s = PL.weeklyStats(base);
  assert.strictEqual(s.sessions, 5);
  assert.strictEqual(s.minutes, 40 + 60 + 35 + 45 + 90);
});

t('missed key session moves to the next rest day (preferred target)', () => {
  const r = PL.adapt(base, 'wed');
  const w = r.week;
  const wed = w.find(d => d.id === 'wed');
  const fri = w.find(d => d.id === 'fri');
  assert.deepStrictEqual(fri.title, 'Tempo Intervals');
  assert.ok(fri.flags.includes('rescheduled'), 'target should be flagged rescheduled');
  assert.ok(wed.type === 'rest' && wed.flags.includes('became-rest'), 'source becomes rest');
  assert.ok(wed.flags.includes('moved-to-fri'), 'source explains where it went');
  assert.strictEqual(r.stats.before.minutes, r.stats.after.minutes, 'volume preserved via swap');
  assert.ok(r.notes.length >= 3, 'short explanation provided');
  assert.ok(r.notes.some(n => n.includes('Fri')), 'notes reference the move target');
});

t('missed key session falls back to an easy day when no rest follows', () => {
  const synth = [
    { id: 'a', dow: 'Mon', type: 'key', title: 'Intervals', durationMin: 60, desc: '', flags: [] },
    { id: 'b', dow: 'Tue', type: 'easy', title: 'Easy', durationMin: 40, desc: '', flags: [] }
  ];
  const r = PL.adapt(synth, 'a');
  const a = r.week.find(d => d.id === 'a');
  assert.strictEqual(r.week[1].id, 'b');
  assert.strictEqual(r.week[1].title, 'Intervals', 'key moved into Tue');
  assert.ok(r.week[1].flags.includes('replaced-easy'), 'easy slot marked as replaced');
  assert.strictEqual(a.type, 'rest');
  assert.strictEqual(r.stats.after.minutes, 60, 'easy run dropped, volume reduced');
  assert.ok(r.notes.some(n => n.includes('replaces')), 'notes explain the trade-off');
});

t('missed key session with no later slot carries into next week', () => {
  const r = PL.adapt(base, 'sun');
  const sun = r.week.find(d => d.id === 'sun');
  assert.strictEqual(sun.type, 'rest');
  assert.ok(sun.flags.includes('rolls-to-next-week'));
  assert.ok(r.notes.some(n => n.includes('next week')));
  assert.strictEqual(r.stats.after.sessions, 4, 'long run leaves this week');
  assert.strictEqual(r.stats.after.minutes, 40 + 60 + 35 + 45);
});

t('missed easy session is dropped and the day becomes rest', () => {
  const r = PL.adapt(base, 'tue');
  const tue = r.week.find(d => d.id === 'tue');
  assert.strictEqual(tue.type, 'rest');
  assert.ok(tue.flags.includes('dropped'));
  assert.strictEqual(r.stats.after.minutes, 35 + 60 + 45 + 90, '40-min easy run removed');
  assert.ok(r.notes.some(n => n.includes('dropped')), 'notes say it was dropped');
});

t('missed rest day is a no-op with a helpful note', () => {
  const before = JSON.stringify(base);
  const r = PL.adapt(base, 'mon');
  assert.strictEqual(JSON.stringify(r.week), before, 'plan unchanged');
  assert.ok(r.notes.some(n => n.includes('Rest')));
});

t('unknown day id returns an error note and unchanged plan', () => {
  const r = PL.adapt(base, 'nope');
  assert.strictEqual(r.week.length, 7);
  assert.ok(r.notes[0].includes("Couldn't find"));
});

t('adapt is deterministic and does not mutate its input', () => {
  const dayIds = base.filter(d => d.type !== 'rest').map(d => d.id);
  const baseSnapshot = JSON.stringify(base);
  for (const id of dayIds) {
    const r1 = PL.adapt(base, id);
    const r2 = PL.adapt(base, id);
    assert.strictEqual(JSON.stringify(r1), JSON.stringify(r2), 'non-deterministic for ' + id);
  }
  assert.strictEqual(JSON.stringify(base), baseSnapshot, 'input week was mutated');
});

t('every adapted view is structurally complete and self-consistent', () => {
  base.forEach(d => {
    if (d.type === 'rest') return;
    const r = PL.adapt(base, d.id);
    const w = r.week;
    assert.strictEqual(w.length, 7);
    w.forEach((day) => {
      assert.ok(day.id && day.dow && day.title && Array.isArray(day.flags));
      if (day.type === 'rest') assert.strictEqual(day.durationMin, 0);
      else assert.ok(day.durationMin > 0, day.id + ' workout must have duration');
    });
    const s = PL.weeklyStats(w);
    assert.strictEqual(s.minutes, r.stats.after.minutes, 'stats consistent for ' + d.id);
    assert.strictEqual(s.sessions, r.stats.after.sessions, 'session count consistent ' + d.id);
  });
});

t('only the missed workout day and its reschedule target change', () => {
  const r = PL.adapt(base, 'wed');
  const end = r.week;
  const changed = end.filter((day, i) => JSON.stringify(day) !== JSON.stringify(base[i]));
  assert.deepStrictEqual(changed.map(c => c.id).sort(), ['fri', 'wed']);
});

t('interval structure is preserved when a key session moves', () => {
  const r = PL.adapt(base, 'wed');
  const fri = r.week.find(d => d.id === 'fri');
  const wed = base.find(d => d.id === 'wed');
  assert.ok(Array.isArray(wed.steps) && wed.steps.length > 0, 'base tempo defines interval strips');
  assert.deepStrictEqual(fri.steps, wed.steps, 'moved session keeps its work/rest structure');
  assert.strictEqual(r.week.find(d => d.id === 'wed').steps, undefined, 'the rest day left behind has no strips');
});

console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);