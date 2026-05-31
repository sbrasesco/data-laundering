export type SortDirection = 'asc' | 'desc';

export type SortValueType = 'text' | 'number' | 'date';

export function getSortComparable(
  raw: unknown,
  type: SortValueType
): string | number | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (type === 'number') {
    const num = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    return isNaN(num) ? null : num;
  }

  if (type === 'date') {
    const d = new Date(raw as string | Date);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  return String(raw).toLocaleLowerCase('es');
}

export function compareSortValues(
  a: string | number | null,
  b: string | number | null,
  direction: SortDirection
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  if (typeof a === 'number' && typeof b === 'number') {
    return direction === 'asc' ? a - b : b - a;
  }

  const cmp = String(a).localeCompare(String(b), 'es', {
    sensitivity: 'base',
    numeric: true,
  });
  return direction === 'asc' ? cmp : -cmp;
}

export function sortRows<T>(
  rows: T[],
  getValue: (row: T) => unknown,
  valueType: SortValueType,
  direction: SortDirection
): T[] {
  const copy = [...rows];
  copy.sort((rowA, rowB) => {
    const a = getSortComparable(getValue(rowA), valueType);
    const b = getSortComparable(getValue(rowB), valueType);
    return compareSortValues(a, b, direction);
  });
  return copy;
}
