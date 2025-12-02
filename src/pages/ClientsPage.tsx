import { useState, FormEvent } from 'react';
import { useClients, Client } from '../hooks/useClients';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Switch } from '../components/ui/Switch';

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

export function ClientsPage() {
  const { clients, loading, error, createClient, updateClient, toggleClientActive } = useClients();
  
  const [newName, setNewName] = useState('');
  const [newTaxId, setNewTaxId] = useState('');
  const [newExternalCode, setNewExternalCode] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [editForm, setEditForm] = useState({
    name: '',
    tax_id: '',
    external_code: '',
    email: '',
  });

  const [submitting, setSubmitting] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    
    if (!newName.trim()) {
      setSubmitError('El nombre es obligatorio');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(false);

    const { error: createError } = await createClient({
      name: newName.trim(),
      tax_id: newTaxId.trim() || undefined,
      external_code: newExternalCode.trim() || undefined,
      email: newEmail.trim() || undefined,
    });

    if (createError) {
      setSubmitError(createError);
    } else {
      setSubmitSuccess(true);
      setNewName('');
      setNewTaxId('');
      setNewExternalCode('');
      setNewEmail('');
      setShowForm(false);
      setTimeout(() => setSubmitSuccess(false), 3000);
    }

    setSubmitting(false);
  };

  const handleEditClick = (client: Client) => {
    setEditingClient(client);
    setEditForm({
      name: client.name,
      tax_id: client.tax_id || '',
      external_code: client.external_code || '',
      email: client.email || '',
    });
  };

  const handleEditSubmit = async (e: FormEvent) => {
    e.preventDefault();
    
    if (!editingClient) return;
    
    if (!editForm.name.trim()) {
      return;
    }

    setEditSubmitting(true);

    try {
      await updateClient(editingClient.id, {
        name: editForm.name.trim(),
        tax_id: editForm.tax_id.trim() || null,
        external_code: editForm.external_code.trim() || null,
        email: editForm.email.trim() || null,
      });
      setEditingClient(null);
    } catch (err) {
      console.error(err);
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleToggleActive = async (client: Client) => {
    setTogglingId(client.id);
    await toggleClientActive(client.id, client.is_active);
    setTogglingId(null);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Clientes</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className={`btn ${showForm ? 'btn-secondary' : 'btn-success'}`}
        >
          {showForm ? 'Cancelar' : 'Nuevo cliente'}
        </button>
      </div>

      {submitSuccess && (
        <div className="alert alert-success">
          Cliente creado exitosamente
        </div>
      )}

      {showForm && (
        <div className="card">
          <h2 style={{ marginTop: 0, marginBottom: '1.5rem' }}>Nuevo Cliente</h2>
          <form onSubmit={handleCreateSubmit}>
            <div className="form-group">
              <label htmlFor="name" className="form-label">
                Nombre <span style={{ color: 'var(--color-primary)' }}>*</span>
              </label>
              <input
                id="name"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                disabled={submitting}
                className="form-control"
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div className="form-group">
                <label htmlFor="tax_id" className="form-label">
                  CUIT / Tax ID
                </label>
                <input
                  id="tax_id"
                  type="text"
                  value={newTaxId}
                  onChange={(e) => setNewTaxId(e.target.value)}
                  disabled={submitting}
                  className="form-control"
                />
              </div>

              <div className="form-group">
                <label htmlFor="external_code" className="form-label">
                  Código Externo
                </label>
                <input
                  id="external_code"
                  type="text"
                  value={newExternalCode}
                  onChange={(e) => setNewExternalCode(e.target.value)}
                  disabled={submitting}
                  className="form-control"
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="email" className="form-label">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                disabled={submitting}
                className="form-control"
              />
            </div>

            {submitError && <ErrorMessage message={submitError} />}

            <div style={{ display: 'flex', gap: '1rem' }}>
              <button type="submit" disabled={submitting} className="btn btn-success">
                {submitting ? 'Creando...' : 'Crear cliente'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setNewName('');
                  setNewTaxId('');
                  setNewExternalCode('');
                  setNewEmail('');
                  setSubmitError(null);
                }}
                disabled={submitting}
                className="btn btn-secondary"
              >
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}

      {loading && <LoadingSpinner />}
      {error && <ErrorMessage message={error} />}

      {!loading && !error && (
        <div>
          <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center' }}>
            <Switch
              checked={showInactive}
              onChange={(v) => setShowInactive(v)}
              label="Mostrar clientes inactivos"
            />
          </div>

          {(() => {
            const visibleClients = showInactive
              ? clients
              : clients.filter(c => c.is_active);

            return visibleClients.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
                <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
                  {showInactive
                    ? 'No hay clientes (activos ni inactivos) registrados. Creá tu primer cliente.'
                    : 'No hay clientes activos registrados. Creá tu primer cliente.'}
                </p>
              </div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>CUIT</th>
                      <th>Código Externo</th>
                      <th>Email</th>
                      <th>Estado</th>
                      <th>Fecha Creación</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleClients.map((client) => (
                      <tr key={client.id}>
                        <td>{client.name}</td>
                        <td>{client.tax_id || '-'}</td>
                        <td>{client.external_code || '-'}</td>
                        <td>{client.email || '-'}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Switch
                              checked={client.is_active}
                              onChange={() => handleToggleActive(client)}
                              disabled={togglingId === client.id}
                            />
                            <span style={{ fontSize: '0.9rem' }}>
                              {client.is_active ? 'Activo' : 'Inactivo'}
                            </span>
                          </div>
                        </td>
                        <td>{formatDate(client.created_at)}</td>
                        <td>
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => handleEditClick(client)}
                            disabled={submitting || editSubmitting || togglingId !== null}
                          >
                            Editar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </div>
      )}

      {/* Modal de Edición */}
      {editingClient && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setEditingClient(null)}
        >
          <div
            className="card"
            style={{
              width: '90%',
              maxWidth: '600px',
              maxHeight: '90vh',
              overflow: 'auto',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginTop: 0, marginBottom: '1.5rem' }}>Editar Cliente</h2>
            <form onSubmit={handleEditSubmit}>
              <div className="form-group">
                <label htmlFor="edit-name" className="form-label">
                  Nombre <span style={{ color: 'var(--color-primary)' }}>*</span>
                </label>
                <input
                  id="edit-name"
                  type="text"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  required
                  disabled={editSubmitting}
                  className="form-control"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div className="form-group">
                  <label htmlFor="edit-tax_id" className="form-label">
                    CUIT / Tax ID
                  </label>
                  <input
                    id="edit-tax_id"
                    type="text"
                    value={editForm.tax_id}
                    onChange={(e) => setEditForm({ ...editForm, tax_id: e.target.value })}
                    disabled={editSubmitting}
                    className="form-control"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="edit-external_code" className="form-label">
                    Código Externo
                  </label>
                  <input
                    id="edit-external_code"
                    type="text"
                    value={editForm.external_code}
                    onChange={(e) => setEditForm({ ...editForm, external_code: e.target.value })}
                    disabled={editSubmitting}
                    className="form-control"
                  />
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="edit-email" className="form-label">
                  Email
                </label>
                <input
                  id="edit-email"
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  disabled={editSubmitting}
                  className="form-control"
                />
              </div>

              <div style={{ display: 'flex', gap: '1rem' }}>
                <button type="submit" disabled={editSubmitting} className="btn btn-success">
                  {editSubmitting ? 'Guardando...' : 'Guardar cambios'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingClient(null)}
                  disabled={editSubmitting}
                  className="btn btn-secondary"
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
