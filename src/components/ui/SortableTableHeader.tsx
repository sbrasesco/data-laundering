import { SortDirection } from '../../utils/tableSort';

interface SortableTableHeaderProps {
  label: string;
  sortable?: boolean;
  isActive?: boolean;
  direction?: SortDirection;
  className?: string;
  onSort?: () => void;
}

export function SortableTableHeader({
  label,
  sortable = true,
  isActive = false,
  direction = 'asc',
  className,
  onSort,
}: SortableTableHeaderProps) {
  const renderIcon = () => {
    if (!sortable) return null;

    if (!isActive) {
      return (
        <span className="sortable-th__icon sortable-th__icon--muted" aria-hidden="true">
          ⇅
        </span>
      );
    }

    return (
      <span className="sortable-th__icon" aria-hidden="true">
        {direction === 'asc' ? '▲' : '▼'}
      </span>
    );
  };

  if (!sortable) {
    return (
      <th className={className}>
        <span className="sortable-th__content">
          <span className="sortable-th__label">{label}</span>
        </span>
      </th>
    );
  }

  return (
    <th className={className} onClick={onSort}>
      <span className="sortable-th__content">
        {renderIcon()}
        <span className="sortable-th__label">{label}</span>
      </span>
    </th>
  );
}
