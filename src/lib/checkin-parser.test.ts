import { describe, expect, it } from 'vitest';
import {
  composeCheckinFromCanned,
  parseCannedResponse,
} from './checkin-parser';

describe('parseCannedResponse', () => {
  it('maps "Energy 5" to energy_level: 5', () => {
    expect(parseCannedResponse('Energy 5')).toEqual({
      energy_level: 5,
      mood: null,
      focus_level: null,
    });
  });

  it('maps "Focus 3" to focus_level: 3', () => {
    expect(parseCannedResponse('Focus 3')).toEqual({
      energy_level: null,
      mood: null,
      focus_level: 3,
    });
  });

  it('maps "Mood 1" to mood: 1', () => {
    expect(parseCannedResponse('Mood 1')).toEqual({
      energy_level: null,
      mood: 1,
      focus_level: null,
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseCannedResponse('  Energy 4  ')).toEqual({
      energy_level: 4,
      mood: null,
      focus_level: null,
    });
  });

  it('returns all-null on the server default plain-numeric form ("3")', () => {
    expect(parseCannedResponse('3')).toEqual({
      energy_level: null,
      mood: null,
      focus_level: null,
    });
  });

  it('returns all-null on an unrecognised string', () => {
    expect(parseCannedResponse('Already done')).toEqual({
      energy_level: null,
      mood: null,
      focus_level: null,
    });
  });

  it('rejects out-of-range named values', () => {
    expect(parseCannedResponse('Energy 6')).toEqual({
      energy_level: null,
      mood: null,
      focus_level: null,
    });
    expect(parseCannedResponse('Mood 0')).toEqual({
      energy_level: null,
      mood: null,
      focus_level: null,
    });
  });

  it('is case-sensitive on the dimension prefix (server emits TitleCase)', () => {
    expect(parseCannedResponse('energy 5')).toEqual({
      energy_level: null,
      mood: null,
      focus_level: null,
    });
  });
});

describe('composeCheckinFromCanned', () => {
  it('combines a parsed canned response with a freeform note', () => {
    expect(
      composeCheckinFromCanned({
        cannedResponse: 'Energy 4',
        freeformNote: 'Big push, dragging now.',
      }),
    ).toEqual({
      checkin_type: 'freeform',
      energy_level: 4,
      mood: null,
      focus_level: null,
      freeform_note: 'Big push, dragging now.',
    });
  });

  it('omits numerics for an unrecognised canned response and keeps the note', () => {
    expect(
      composeCheckinFromCanned({
        cannedResponse: '3',
        freeformNote: 'Just numbers from the prompt.',
      }),
    ).toEqual({
      checkin_type: 'freeform',
      energy_level: null,
      mood: null,
      focus_level: null,
      freeform_note: 'Just numbers from the prompt.',
    });
  });

  it('treats null canned-response as note-only', () => {
    expect(
      composeCheckinFromCanned({
        cannedResponse: null,
        freeformNote: 'Started without a canned tap.',
      }),
    ).toEqual({
      checkin_type: 'freeform',
      energy_level: null,
      mood: null,
      focus_level: null,
      freeform_note: 'Started without a canned tap.',
    });
  });

  it('coerces empty-string note to null', () => {
    expect(
      composeCheckinFromCanned({
        cannedResponse: 'Mood 2',
        freeformNote: '',
      }),
    ).toEqual({
      checkin_type: 'freeform',
      energy_level: null,
      mood: 2,
      focus_level: null,
      freeform_note: null,
    });
  });

  it('honours an explicit checkin_type override', () => {
    expect(
      composeCheckinFromCanned({
        cannedResponse: 'Energy 5',
        freeformNote: null,
        checkinType: 'morning',
      }),
    ).toEqual({
      checkin_type: 'morning',
      energy_level: 5,
      mood: null,
      focus_level: null,
      freeform_note: null,
    });
  });
});
