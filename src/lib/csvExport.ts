import { DocumentRow } from '../hooks/useAllDocuments';

export function exportToCSV(documents: DocumentRow[], filename: string = 'documentos.csv') {
  if (documents.length === 0) {
    alert('No hay documentos para exportar');
    return;
  }

  // Definir las columnas que queremos exportar
  const columns = [
    { key: 'fecha', label: 'Fecha Comprobante' },
    { key: 'clients', label: 'Cliente', getValue: (doc: DocumentRow) => doc.clients?.name || '-' },
    { key: 'proveedor', label: 'Proveedor' },
    { key: 'cuit', label: 'CUIT Proveedor' },
    { key: 'receptor_nombre', label: 'Receptor' },
    { key: 'receptor_cuit', label: 'CUIT Receptor' },
    { key: 'numero_comprobante', label: 'Número Comprobante' },
    { key: 'tipo_documento', label: 'Tipo Documento' },
    { key: 'moneda', label: 'Moneda', getValue: (doc: DocumentRow) => {
      if (doc.es_moneda_usd) return 'USD';
      if (doc.es_moneda_ars) return 'ARS';
      return doc.moneda || '-';
    }},
    { key: 'neto_gravado', label: 'Neto Gravado', getValue: (doc: DocumentRow) => formatNumber(doc.neto_gravado) },
    { key: 'iva', label: 'IVA', getValue: (doc: DocumentRow) => formatNumber(doc.iva) },
    { key: 'total', label: 'Total', getValue: (doc: DocumentRow) => formatNumber(doc.total) },
    { key: 'status', label: 'Estado Proceso', getValue: (doc: DocumentRow) => {
      const statusMap: Record<string, string> = {
        pending: 'Pendiente',
        processing: 'Procesando',
        done: 'Completado',
        error: 'Error',
      };
      return doc.pdf_jobs?.status ? statusMap[doc.pdf_jobs.status] || doc.pdf_jobs.status : '-';
    }},
  ];

  // Crear encabezados
  const headers = columns.map(col => col.label);

  // Crear filas de datos
  const rows = documents.map(doc => {
    return columns.map(col => {
      if (col.getValue) {
        return col.getValue(doc);
      }
      const value = doc[col.key as keyof DocumentRow];
      if (value === null || value === undefined) {
        return '';
      }
      // Escapar comillas y envolver en comillas si contiene comas o punto y coma
      const stringValue = String(value);
      if (stringValue.includes(',') || stringValue.includes(';') || stringValue.includes('"')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    });
  });

  // Combinar encabezados y filas
  const csvContent = [
    headers.join(';'),
    ...rows.map(row => row.join(';'))
  ].join('\n');

  // Agregar BOM para Excel (UTF-8)
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function formatNumber(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) {
    return '';
  }
  // Formatear como número con punto decimal (formato internacional)
  return num.toFixed(2).replace('.', ',');
}

