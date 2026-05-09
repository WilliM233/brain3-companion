/**
 * Canned-response → CheckinCreate field mapping for [2C-19].
 *
 * The parser derives numeric check-in fields (`energy_level`, `focus_level`,
 * `mood`) from canned-response strings produced by `notification_defaults.py`
 * on the server. The contract is forward-compatible: rules that override the
 * defaults with named formats like `"Energy 5"` / `"Focus 3"` / `"Mood 1"`
 * land in the corresponding field, and any string the parser doesn't
 * recognise (including the server's plain `"1"`–`"5"` defaults for
 * `checkin_prompt`) falls back to the unparsed shape — note + checkin_type
 * only, no numeric fields.
 *
 * The parser lives on the client; the server's CANNED_RESPONSES list is the
 * source of truth for what gets sent. Keep the named mapping in lockstep
 * with future server changes — see [2C-19] Technical notes for the future
 * shared-format candidacy.
 */

import type { CheckinType } from './checkins';

export interface ParsedCheckinFields {
  energy_level: number | null;
  mood: number | null;
  focus_level: number | null;
}

const NAMED_PATTERN = /^(Energy|Focus|Mood)\s+([1-5])$/;

/**
 * Parse a canned-response string into a partial CheckinCreate. Unknown
 * strings (including the server's plain `"1"`–`"5"` defaults that don't
 * carry a dimension) yield an all-null result so the caller can compose a
 * note-only check-in.
 */
export function parseCannedResponse(response: string): ParsedCheckinFields {
  const empty: ParsedCheckinFields = {
    energy_level: null,
    mood: null,
    focus_level: null,
  };
  const match = NAMED_PATTERN.exec(response.trim());
  if (match === null) return empty;

  const dimension = match[1];
  const value = Number.parseInt(match[2]!, 10);
  switch (dimension) {
    case 'Energy':
      return { ...empty, energy_level: value };
    case 'Focus':
      return { ...empty, focus_level: value };
    case 'Mood':
      return { ...empty, mood: value };
    default:
      return empty;
  }
}

export interface ComposeCheckinArgs {
  cannedResponse: string | null;
  freeformNote: string | null;
  checkinType?: CheckinType;
}

export interface ComposedCheckin {
  checkin_type: CheckinType;
  energy_level: number | null;
  mood: number | null;
  focus_level: number | null;
  freeform_note: string | null;
}

/**
 * Compose a CheckinCreate-shaped payload from a canned response + optional
 * note. `checkin_type` defaults to `"freeform"` per the [2C-19] spec — the
 * Phase 2 fallback when the notification doesn't carry a type hint.
 */
export function composeCheckinFromCanned(args: ComposeCheckinArgs): ComposedCheckin {
  const { cannedResponse, freeformNote, checkinType = 'freeform' } = args;
  const parsed =
    cannedResponse === null
      ? { energy_level: null, mood: null, focus_level: null }
      : parseCannedResponse(cannedResponse);
  return {
    checkin_type: checkinType,
    energy_level: parsed.energy_level,
    mood: parsed.mood,
    focus_level: parsed.focus_level,
    freeform_note: freeformNote && freeformNote.length > 0 ? freeformNote : null,
  };
}
