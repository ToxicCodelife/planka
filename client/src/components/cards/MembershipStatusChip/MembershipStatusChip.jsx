/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

import React, { useCallback } from 'react';
import PropTypes from 'prop-types';
import { useDispatch, useSelector } from 'react-redux';
import { Label } from 'semantic-ui-react';

import selectors from '../../../selectors';
import entryActions from '../../../entry-actions';

const STATUS_CYCLE = ['want', 'have', 'done'];

const COLOR_BY_STATUS = {
  want: 'red',
  have: 'yellow',
  done: 'green',
};

const MembershipStatusChip = React.memo(({ id, userId, status }) => {
  const currentUserId = useSelector(selectors.selectCurrentUserId);
  const dispatch = useDispatch();

  const isOwn = userId === currentUserId;

  const handleClick = useCallback(
    (event) => {
      event.stopPropagation();

      const currentIndex = STATUS_CYCLE.indexOf(status);
      const nextStatus = STATUS_CYCLE[(currentIndex + 1) % STATUS_CYCLE.length];

      dispatch(entryActions.updateCardMembership(id, { status: nextStatus }));
    },
    [status, id, dispatch],
  );

  // Others' unset status is simply not shown, to avoid cluttering the card
  // with empty pills for members who haven't picked one yet. Your own unset
  // status still renders (as a plain outlined pill) so you have something to
  // click in the first place.
  if (!status && !isOwn) {
    return null;
  }

  return (
    <Label
      size="mini"
      basic={!status}
      color={status ? COLOR_BY_STATUS[status] : undefined}
      as={isOwn ? 'a' : 'span'}
      onClick={isOwn ? handleClick : undefined}
    >
      {status || '?'}
    </Label>
  );
});

MembershipStatusChip.propTypes = {
  id: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  status: PropTypes.oneOf(['want', 'have', 'done']),
};

MembershipStatusChip.defaultProps = {
  status: null,
};

export default MembershipStatusChip;
