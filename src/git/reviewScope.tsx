import * as React from 'react';

import type { TranslationBundle } from '@jupyterlab/translation';
import { HTMLSelect } from '@jupyterlab/ui-components';

import type { ReviewScope } from './reviewModel';

const UNCOMMITTED_VALUE = 'uncommitted';

const BRANCH_PREFIX = 'branch:';

/**
 * The props of {@link ReviewScopeSelect}.
 */
export interface IReviewScopeSelectProps {
  /**
   * The selected scope.
   */
  scope: ReviewScope;
  /**
   * The base branch of the branch scope; `null` when it is not known.
   */
  base: string | null;
  /**
   * The base branch used when none is chosen, listed first.
   */
  defaultBase: string | null;
  /**
   * The other branches.
   */
  candidates: readonly string[];
  /**
   * Called with the chosen scope and base branch.
   */
  onChange: (scope: ReviewScope, base: string | null) => void;
  /**
   * Called when the select gets the focus, to update the branches.
   */
  onFocus?: () => void;
  /**
   * The application translation bundle.
   */
  trans: TranslationBundle;
}

/**
 * One select for the changes to review: the uncommitted changes, or the
 * changes of the branch compared with a base branch.
 */
export function ReviewScopeSelect(
  props: IReviewScopeSelectProps
): React.ReactElement {
  const { scope, base, defaultBase, candidates, onChange, onFocus, trans } =
    props;
  const branches: string[] = [];
  for (const name of [defaultBase, base, ...candidates]) {
    if (name !== null && name !== '' && !branches.includes(name)) {
      branches.push(name);
    }
  }
  const options = [
    { label: trans.__('Uncommitted changes'), value: UNCOMMITTED_VALUE },
    ...branches.map(name => ({
      label: trans.__('Changes vs %1', name),
      value: `${BRANCH_PREFIX}${name}`
    }))
  ];
  let value = UNCOMMITTED_VALUE;
  if (scope === 'branch') {
    value = `${BRANCH_PREFIX}${base ?? ''}`;
    if (base === null) {
      // Without a base the select needs an option that names no branch.
      options.push({ label: trans.__('Choose a base branch'), value });
    }
  }
  return (
    <HTMLSelect
      className="jp-xtralab-ReviewScope"
      aria-label={trans.__('Changes to review')}
      title={trans.__(
        'The uncommitted changes, or all the changes of the branch since it left the base branch'
      )}
      value={value}
      options={options}
      onFocus={onFocus}
      onChange={event => {
        const next = event.currentTarget.value;
        if (next === UNCOMMITTED_VALUE) {
          onChange('uncommitted', null);
        } else if (next.length > BRANCH_PREFIX.length) {
          onChange('branch', next.slice(BRANCH_PREFIX.length));
        }
      }}
    />
  );
}
