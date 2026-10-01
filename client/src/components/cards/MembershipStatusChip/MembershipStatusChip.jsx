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
import { UserRoles } from '../../../constants/Enums';

const STATUS_CYCLE = ['want', 'have', 'done'];

const COLOR_BY_STATUS = {
  want: 'red',
  have: 'yellow',
  done: 'green',
};

const MembershipStatusChip = React.memo(({ id, userId, status }) => {
  const currentUser = useSelector(selectors.selectCurrentUser);
  const dispatch = useDispatch();

  const isOwn = userId === currentUser.id;
  const isAdmin = currentUser.role === UserRoles.ADMIN;
  const canEdit = isOwn || isAdmin;

  const handleClick = useCallback(
    (event) => {
      event.stopPropagation();

      if (!canEdit) {
        return;
      }

      const currentIndex = STATUS_CYCLE.indexOf(status);
      const nextStatus = STATUS_CYCLE[(currentIndex + 1) % STATUS_CYCLE.length];

      dispatch(entryActions.updateCardMembership(id, { status: nextStatus }));
    },
    [canEdit, status, id, dispatch],
  );

  // Others' unset status is simply not shown, to avoid cluttering the card
  // with empty pills for members who haven't picked one yet. Your own unset
  // status (or any member's, if you're an admin) still renders as a plain
  // outlined pill so there's something to click in the first place.
  if (!status && !canEdit) {
    return null;
  }

  return (
    <Label
      size="small"
      basic={!status}
      color={status ? COLOR_BY_STATUS[status] : undefined}
      as={canEdit ? 'a' : 'span'}
      onClick={canEdit ? handleClick : undefined}
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
