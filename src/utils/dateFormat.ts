/** Formato de visualización: dd-mm-yyyy */
const SPANISH_MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  jun: 6,
  jul: 7,
  ago: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dic: 12,
};

function normalizeMonthName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function parseDateParts(value: string): { day: number; month: number; year: number } | null {
  const trimmed = value.trim();

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }

  const slash = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slash) {
    return { day: Number(slash[1]), month: Number(slash[2]), year: Number(slash[3]) };
  }

  const spanishLong = trimmed.match(/^(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})$/i);
  if (spanishLong) {
    const month = SPANISH_MONTHS[normalizeMonthName(spanishLong[2])];
    if (month) {
      return { day: Number(spanishLong[1]), month, year: Number(spanishLong[3]) };
    }
  }

  return null;
}

function formatParts(day: number, month: number, year: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(day)}-${pad(month)}-${year}`;
}

export function formatDisplayDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';

  if (typeof value === 'string') {
    const parsed = parseDateParts(value);
    if (parsed) {
      return formatParts(parsed.day, parsed.month, parsed.year);
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) {
    if (typeof value === 'string') return value;
    return '-';
  }

  return formatParts(date.getDate(), date.getMonth() + 1, date.getFullYear());
}
