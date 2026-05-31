import { DocumentRow } from '../hooks/useAllDocuments';
import { formatDisplayDate } from '../utils/dateFormat';

export interface DocumentDetailSection {
  title: string;
  fields: DocumentDetailField[];
}

export interface DocumentDetailField {
  label: string;
  getValue: (doc: DocumentRow) => unknown;
  format?: 'text' | 'date' | 'currency' | 'moneda' | 'doc_status' | 'oc_list';
}

function formatCurrency(value: unknown): string {
  if (value === null || value === undefined) return '-';
  const num = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (isNaN(num)) return String(value);
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(num);
}

function getIvaTotal(doc: DocumentRow): number | null {
  const discriminado =
    (doc.iva_27 ?? 0) + (doc.iva_21 ?? 0) + (doc.iva_105 ?? 0) + (doc.iva_5 ?? 0) + (doc.iva_25 ?? 0);
  if (discriminado > 0) return discriminado;
  return doc.iva ?? null;
}

function formatMoneda(doc: DocumentRow): string {
  if (doc.es_moneda_usd) return 'USD';
  if (doc.es_moneda_ars) return 'ARS';
  return doc.moneda || '-';
}

function formatDocStatus(doc: DocumentRow): string {
  const map: Record<string, string> = {
    ok: 'Correcto',
    warning: 'Con advertencias',
    failed: 'Con error',
  };
  return map[doc.doc_status ?? ''] ?? doc.doc_status ?? '-';
}

function formatOcList(doc: DocumentRow): string {
  const list = doc.pdf_job_row_oc;
  if (!Array.isArray(list) || list.length === 0) return '-';
  return list.map((oc: { numero_oc?: string }) => oc?.numero_oc).filter(Boolean).join(', ') || '-';
}

export function formatDocumentDetailValue(
  value: unknown,
  format: DocumentDetailField['format'] = 'text',
  doc?: DocumentRow
): string {
  if (format === 'currency') return formatCurrency(value);
  if (format === 'date') return formatDisplayDate(value as string | null);
  if (format === 'moneda' && doc) return formatMoneda(doc);
  if (format === 'doc_status' && doc) return formatDocStatus(doc);
  if (format === 'oc_list' && doc) return formatOcList(doc);
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

export const DOCUMENT_DETAIL_SECTIONS: DocumentDetailSection[] = [
  {
    title: 'Comprobante',
    fields: [
      { label: 'Cliente', getValue: (d) => d.clients?.name, format: 'text' },
      { label: 'Tipo comprobante', getValue: (d) => d.tipo_documento },
      { label: 'Nro. comprobante', getValue: (d) => d.numero_comprobante },
      { label: 'Cód. AFIP', getValue: (d) => d.codigo_afip },
      { label: 'Fecha emisión', getValue: (d) => d.fecha, format: 'date' },
      { label: 'Moneda', getValue: (d) => d, format: 'moneda' },
      { label: 'Estado del documento', getValue: (d) => d, format: 'doc_status' },
    ],
  },
  {
    title: 'Emisor',
    fields: [
      { label: 'Proveedor', getValue: (d) => d.proveedor },
      { label: 'CUIT', getValue: (d) => d.cuit },
      { label: 'Cond. IVA', getValue: (d) => d.condicion_iva_emisor },
    ],
  },
  {
    title: 'Receptor',
    fields: [
      { label: 'Nombre', getValue: (d) => d.receptor_nombre },
      { label: 'CUIT', getValue: (d) => d.receptor_cuit },
    ],
  },
  {
    title: 'CAE',
    fields: [
      { label: 'Nro. CAE', getValue: (d) => d.nro_cae ?? d.cae },
      { label: 'Vto. CAE', getValue: (d) => d.fecha_vto_cae, format: 'date' },
    ],
  },
  {
    title: 'Importes',
    fields: [
      { label: 'Neto gravado', getValue: (d) => d.neto_gravado, format: 'currency' },
      { label: 'Monto exento', getValue: (d) => d.monto_exento, format: 'currency' },
      { label: 'IVA 27%', getValue: (d) => d.iva_27, format: 'currency' },
      { label: 'IVA 21%', getValue: (d) => d.iva_21, format: 'currency' },
      { label: 'IVA 10,5%', getValue: (d) => d.iva_105, format: 'currency' },
      { label: 'IVA 5%', getValue: (d) => d.iva_5, format: 'currency' },
      { label: 'IVA total', getValue: (d) => getIvaTotal(d), format: 'currency' },
      { label: 'Perc. IIBB', getValue: (d) => d.percepcion_ingresos_brutos, format: 'currency' },
      { label: 'Perc. IVA', getValue: (d) => d.percepcion_iva, format: 'currency' },
      { label: 'Imp. internos', getValue: (d) => d.impuestos_internos, format: 'currency' },
      { label: 'Total', getValue: (d) => d.total, format: 'currency' },
    ],
  },
  {
    title: 'Proceso',
    fields: [
      { label: 'ID proceso', getValue: (d) => d.job_id?.substring(0, 8) },
      {
        label: 'Fecha del proceso',
        getValue: (d) => d.pdf_jobs?.created_at,
        format: 'date',
      },
      {
        label: 'Período',
        getValue: (d) => {
          const m = d.pdf_jobs?.period_month;
          const y = d.pdf_jobs?.period_year;
          if (!m || !y) return null;
          const months = [
            'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
          ];
          return `${months[m - 1]} ${y}`;
        },
      },
    ],
  },
  {
    title: 'Otros',
    fields: [
      { label: 'Archivo origen', getValue: (d) => d.source_file },
      { label: 'Órdenes de compra', getValue: (d) => d, format: 'oc_list' },
    ],
  },
];
