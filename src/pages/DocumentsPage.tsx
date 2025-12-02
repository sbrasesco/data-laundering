import { useState, useMemo } from 'react';
import { useAllDocuments, DocumentFilters } from '../hooks/useAllDocuments';
import { useClients } from '../hooks/useClients';
import { DocumentsTable } from '../components/documents/DocumentsTable';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { exportToCSV } from '../lib/csvExport';
import { exportDocumentsToXlsx } from '../utils/excelExport';

const PAGE_SIZE = 50;

export function DocumentsPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<DocumentFilters>({});
  const [searchText, setSearchText] = useState('');
  
  const { clients, loading: clientsLoading } = useClients();
  const { documents, loading, error, totalCount } = useAllDocuments(filters, page, PAGE_SIZE);

  // Aplicar filtro de búsqueda de texto (client-side)
  const filteredDocuments = useMemo(() => {
    if (!searchText.trim()) {
      return documents;
    }
    const searchLower = searchText.toLowerCase();
    return documents.filter((doc) => {
      return (
        doc.proveedor?.toLowerCase().includes(searchLower) ||
        doc.receptor_nombre?.toLowerCase().includes(searchLower) ||
        doc.numero_comprobante?.toLowerCase().includes(searchLower) ||
        doc.cuit?.toLowerCase().includes(searchLower) ||
        doc.receptor_cuit?.toLowerCase().includes(searchLower)
      );
    });
  }, [documents, searchText]);

  const handleFechaDesdeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters(prev => ({ ...prev, fechaDesde: e.target.value || undefined }));
    setPage(1); // Resetear a primera página
  };

  const handleFechaHastaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters(prev => ({ ...prev, fechaHasta: e.target.value || undefined }));
    setPage(1);
  };

  const handleClientChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilters(prev => ({ ...prev, clientId: e.target.value || undefined }));
    setPage(1);
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchText(e.target.value);
  };

  const handleClearFilters = () => {
    setFilters({});
    setSearchText('');
    setPage(1);
  };

  const handleExportToExcel = () => {
    if (filteredDocuments.length === 0) {
      alert('No hay documentos para exportar');
      return;
    }
    const dateStr = new Date().toISOString().split('T')[0];
    exportDocumentsToXlsx(filteredDocuments, `documentos_${dateStr}.xlsx`);
  };

  const handleExportToCSV = () => {
    if (filteredDocuments.length === 0) {
      alert('No hay documentos para exportar');
      return;
    }
    const dateStr = new Date().toISOString().split('T')[0];
    exportToCSV(filteredDocuments, `documentos_${dateStr}.csv`);
  };

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem' }}>
        <div>
          <h1>Todos los documentos</h1>
          <p style={{ color: 'var(--color-text-secondary)', marginTop: '0.5rem' }}>
            Listado consolidado de todos los comprobantes procesados.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handleExportToExcel}
              className="btn btn-success"
              disabled={filteredDocuments.length === 0}
            >
              Exportar a Excel
            </button>
            <button
              onClick={handleExportToCSV}
              className="btn btn-secondary"
              disabled={filteredDocuments.length === 0}
              style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
            >
              Exportar CSV
            </button>
          </div>
          <p style={{ 
            color: 'var(--color-text-secondary)', 
            fontSize: '0.875rem', 
            margin: 0,
            textAlign: 'right'
          }}>
            Exporta los documentos filtrados a Excel
          </p>
        </div>
      </div>

      {/* Filtros */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h3 style={{ marginBottom: '1.5rem', fontSize: '1.25rem' }}>Filtros</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1rem' }}>
          <div className="form-group">
            <label className="form-label">Fecha desde</label>
            <input
              type="date"
              className="form-control"
              value={filters.fechaDesde || ''}
              onChange={handleFechaDesdeChange}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Fecha hasta</label>
            <input
              type="date"
              className="form-control"
              value={filters.fechaHasta || ''}
              onChange={handleFechaHastaChange}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Cliente</label>
            <select
              className="form-control"
              value={filters.clientId || ''}
              onChange={handleClientChange}
              disabled={clientsLoading}
            >
              <option value="">Todos los clientes</option>
              {clients.map(client => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Buscador</label>
            <input
              type="text"
              className="form-control"
              placeholder="Buscar por proveedor, receptor, número, CUIT..."
              value={searchText}
              onChange={handleSearchChange}
            />
          </div>
        </div>
        <div style={{ marginTop: '1rem' }}>
          <button
            onClick={handleClearFilters}
            className="btn btn-secondary"
            style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
          >
            Limpiar filtros
          </button>
        </div>
      </div>

      {loading && <LoadingSpinner />}
      {error && <ErrorMessage message={error} />}
      
      {!loading && !error && (
        <>
          <DocumentsTable documents={filteredDocuments} />
          
          {/* Paginación */}
          {totalPages > 1 && (
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              marginTop: '2rem',
              padding: '1rem',
              backgroundColor: 'var(--color-bg-white)',
              borderRadius: '30px 30px 30px 0',
            }}>
              <div style={{ color: 'var(--color-text-secondary)' }}>
                Mostrando {((page - 1) * PAGE_SIZE) + 1} - {Math.min(page * PAGE_SIZE, totalCount)} de {totalCount} documentos
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  className="btn btn-secondary"
                  disabled={page === 1}
                  style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
                >
                  Anterior
                </button>
                <span style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  padding: '0 1rem',
                  color: 'var(--color-text-secondary)'
                }}>
                  Página {page} de {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  className="btn btn-secondary"
                  disabled={page === totalPages}
                  style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

