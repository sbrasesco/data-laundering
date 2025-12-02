interface JobRowsTableProps {
  rows: any[];
}

export function JobRowsTable({ rows }: JobRowsTableProps) {
  const formatValue = (value: any): string => {
    if (value === null || value === undefined) {
      return '-';
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    if (typeof value === 'object') {
      const json = JSON.stringify(value);
      return json.length > 100 ? json.substring(0, 100) + '...' : json;
    }
    return String(value);
  };

  const formatCurrency = (value: any): string => {
    if (value === null || value === undefined) {
      return '-';
    }
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) return String(value);
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
    }).format(num);
  };

  const formatDate = (value: any): string => {
    if (value === null || value === undefined) {
      return '-';
    }
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

  if (rows.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
        <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>
          Este proceso aún no tiene filas procesadas.
        </p>
      </div>
    );
  }

  // Intentar identificar columnas importantes por nombre común
  // Ajustá estos nombres según los campos reales de tu tabla pdf_job_rows
  const getColumnDisplay = (colName: string, value: any): string => {
    const lowerName = colName.toLowerCase();
    
    // Si es un campo de importe/monto/precio
    if (lowerName.includes('importe') || lowerName.includes('amount') || 
        lowerName.includes('monto') || lowerName.includes('precio') || 
        lowerName.includes('total') || lowerName.includes('valor')) {
      return formatCurrency(value);
    }
    
    // Si es un campo de fecha
    if (lowerName.includes('fecha') || lowerName.includes('date') || 
        lowerName.includes('created_at') || lowerName.includes('updated_at')) {
      return formatDate(value);
    }
    
    // Por defecto, formato normal
    return formatValue(value);
  };

  const columns = Object.keys(rows[0] || {});
  
  // Filtrar columnas internas que no queremos mostrar
  const visibleColumns = columns.filter(col => 
    !['id', 'job_id', 'organization_id'].includes(col)
  );

  return (
    <div className="table-wrapper" style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            {visibleColumns.map((col) => (
              <th key={col}>
                {col.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {visibleColumns.map((col) => (
                <td key={col} style={{ fontSize: '0.9rem' }}>
                  {getColumnDisplay(col, row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

