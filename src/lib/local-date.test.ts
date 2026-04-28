import { describe, expect, it } from 'vitest';
import {
  eightDaysAgoLocalMidnightUtc,
  sevenDaysAgoLocalDate,
  todayLocalDate,
} from './local-date';

describe('todayLocalDate', () => {
  it('formats the local calendar date as YYYY-MM-DD', () => {
    const now = new Date(2026, 3, 28, 14, 30); // 2026-04-28 14:30 local
    expect(todayLocalDate(now)).toBe('2026-04-28');
  });

  it('uses local time, not UTC, when the local date differs from UTC', () => {
    // Jan 1 00:30 local in any negative-offset zone is still Jan 1 locally
    // even when UTC has rolled to Jan 1 ~ Jan 2. The test checks we don't
    // accidentally call `toISOString().slice(0, 10)`-style logic.
    const now = new Date(2026, 0, 1, 0, 30);
    expect(todayLocalDate(now)).toBe('2026-01-01');
  });
});

describe('sevenDaysAgoLocalDate', () => {
  it('subtracts exactly 7 calendar days', () => {
    const now = new Date(2026, 3, 28, 9, 0); // 2026-04-28
    expect(sevenDaysAgoLocalDate(now)).toBe('2026-04-21');
  });

  it('crosses month boundaries cleanly', () => {
    const now = new Date(2026, 4, 3, 9, 0); // 2026-05-03
    expect(sevenDaysAgoLocalDate(now)).toBe('2026-04-26');
  });

  it('crosses year boundaries cleanly', () => {
    const now = new Date(2026, 0, 5, 9, 0); // 2026-01-05
    expect(sevenDaysAgoLocalDate(now)).toBe('2025-12-29');
  });
});

describe('eightDaysAgoLocalMidnightUtc', () => {
  it('returns a parseable ISO timestamp', () => {
    const result = eightDaysAgoLocalMidnightUtc(new Date(2026, 3, 28, 9, 0));
    expect(() => new Date(result)).not.toThrow();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('lands on local-midnight 8 days back (rendered as UTC)', () => {
    const now = new Date(2026, 3, 28, 14, 30);
    const iso = eightDaysAgoLocalMidnightUtc(now);
    const parsed = new Date(iso);
    // 8 days back from 2026-04-28 → 2026-04-20
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(3);
    expect(parsed.getDate()).toBe(20);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
  });
});
