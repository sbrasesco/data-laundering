interface JobRowsTableProps {
  rows: any[];
}

type ColumnType = 'text' | 'currency' | 'date';

interface ColumnDef {
  header: string;
  getValue: (row: any) => any;
  type: ColumnType;
}

const COLUMNS: ColumnDef[] = [
  {
    header: 'Tipo de Comprobante',
    getValue: (row) => row.tipo_documento,
    type: 'text',
  },
  {
    header: 'Punto de Venta',
    getValue: (row) => {
      if (row.punto_venta != null) return row.punto_venta;
      // Derivar del numero_comprobante si tiene formato XXXX-XXXXXXXX
      const match = String(row.numero_comprobante || '').match(/^(\d{4})-/);
      return match ? match[1] : null;
    },
    type: 'text',
  },
  {
    header: 'Numero de Comprobante',
    getValue: (row) => row.numero_comprobante,
    type: 'text',
  },
  {
    header: 'Fecha de Emision',
    getValue: (row) => row.fecha,
    type: 'date',
  },
  {
    header: 'CUIT Emisor',
    getValue: (row) => row.cuit,
    type: 'text',
  },
  {
    header: 'Nro. CAE',
    getValue: (row) => row.nro_cae ?? row.cae,
    type: 'text',
  },
  {
    header: 'Fecha Vto. CAE',
    getValue: (row) => row.fecha_vto_cae,
    type: 'date',
  },
  {
    header: 'Monto Gravado',
    getValue: (row) => row.importe_neto,
    type: 'currency',
  },
  {
    header: 'Monto Exento',
    getValue: (row) => row.monto_exento,
    type: 'currency',
  },
  {
    header: 'IVA 21%',
    getValue: (row) => row.iva_21 ?? row.iva,
    type: 'currency',
  },
  {
    header: 'IVA 10.5%',
    getValue: (row) => row.iva_105,
    type: 'currency',
  },
  {
    header: 'IVA 27%',
    getValue: (row) => row.iva_27,
    type: 'currency',
  },
  {
    header: 'IVA 5%',
    getValue: (row) => row.iva_5,
    type: 'currency',
  },
  {
    header: 'Perc. IIBB Bs As',
    getValue: (row) => row.percepcion_ingresos_brutos,
    type: 'currency',
  },
  {
    header: 'Distintas Percepciones',
    getValue: (row) => row.percepcion_iva,
    type: 'currency',
  },
  {
    header: 'Impuestos Internos',
    getValue: (row) => row.impuestos_internos,
    type: 'currency',
  },
];

export function JobRowsTable({ rows }: JobRowsTableProps) {
  const formatCurrency = (value: any): string => {
    if (value === null || value === undefined) return '-';
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) return String(value);
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
    }).format(num);
  };

  const formatDate = (value: any): string => {
    if (value === null || value === undefined) return '-';
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return String(value);
      return date.toLocaleDateString('es-AR', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return String(value);
    }
  };

  const formatCell = (col: ColumnDef, row: any): string => {
    const value = col.getValue(row);
    if (value === null || value === undefined) return '-';
    if (col.type === 'currency') return formatCurrency(value);
    if (col.type === 'date') return formatDate(value);
    return String(value);
  };

  if (rows.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
        <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>
          Este proceso aún no tiene filas procesadas.
        </p>
      </div>
    );
  }

  return (
    <div className="table-wrapper" style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th key={col.header}>{col.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {COLUMNS.map((col) => (
                <td key={col.header} style={{ fontSize: '0.9rem' }}>
                  {formatCell(col, row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

