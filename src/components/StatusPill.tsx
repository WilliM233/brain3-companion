import type { ScaffoldingStatus } from '../lib/habits';

const PILL_COPY: Record<ScaffoldingStatus, string> = {
  tracking: 'Tracking',
  accountable: 'Accountable',
  graduated: 'Graduated',
};

const PILL_CLASSES: Record<ScaffoldingStatus, string> = {
  tracking: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  accountable: 'bg-amber-100 text-amber-800 ring-amber-200',
  graduated: 'bg-neutral-100 text-neutral-700 ring-neutral-300',
};

interface Props {
  status: ScaffoldingStatus;
}

/**
 * Scaffolding-status pill for habit list/detail rows. Color encoding follows
 * spec [2C-21] §Scope: green Tracking · amber Accountable · gray Graduated.
 *
 * First-consumer-instantiates: introduced by [2C-21] for shared reuse with
 * [2C-22] habit detail and (eventually) [2C-16] rules list. The "[2C-16]
 * pattern" referenced by the spec does not yet exist in the repo at the
 * time of this commit — see PR body.
 */
const StatusPill: React.FC<Props> = ({ status }) => (
  <span
    data-testid={`status-pill-${status}`}
    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${PILL_CLASSES[status]}`}
  >
    {PILL_COPY[status]}
  </span>
);

export default StatusPill;
