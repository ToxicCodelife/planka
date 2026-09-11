/*!
 * Shared logic for matching a card's label/member ids against the current
 * board filter selection, according to the active filter mode.
 */

import { FilterModes } from '../constants/Enums';

// itemIds: ids actually present on the card (e.g. its label ids)
// filterIds: ids currently selected in the filter popup
// mode: FilterModes.ANY | FilterModes.AND | FilterModes.ONLY
const matchesIdsByMode = (itemIds, filterIds, mode) => {
  if (filterIds.length === 0) {
    return true;
  }

  switch (mode) {
    case FilterModes.AND:
      // Card must have every selected id (it may also have others)
      return filterIds.every((filterId) => itemIds.includes(filterId));
    case FilterModes.ONLY:
      // Card's id set must exactly equal the selected set
      return (
        itemIds.length === filterIds.length &&
        filterIds.every((filterId) => itemIds.includes(filterId))
      );
    case FilterModes.ANY:
    default:
      // Card must have at least one selected id (native/original behavior)
      return itemIds.some((itemId) => filterIds.includes(itemId));
  }
};

export default matchesIdsByMode;
