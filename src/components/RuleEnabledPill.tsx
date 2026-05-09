interface Props {
  enabled: boolean;
}

/**
 * Read-only pill showing whether a rule is enabled. Lives next to
 * `StatusPill` rather than reusing it because that component is typed
 * against the 3-way scaffolding-status enum and the rule's binary enabled
 * state doesn't fit that shape cleanly. See PR body for the
 * first-consumer-instantiates note from [2C-21].
 */
const RuleEnabledPill: React.FC<Props> = ({ enabled }) => {
  const tone = enabled
    ? 'bg-emerald-100 text-emerald-800 ring-emerald-200'
    : 'bg-neutral-100 text-neutral-700 ring-neutral-300';
  const label = enabled ? 'Enabled' : 'Disabled';
  return (
    <span
      data-testid={`rule-enabled-pill-${enabled ? 'enabled' : 'disabled'}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {label}
    </span>
  );
};

export default RuleEnabledPill;
