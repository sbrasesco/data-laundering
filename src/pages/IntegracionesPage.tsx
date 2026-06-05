import { useState, useEffect, useCallback } from 'react';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { supabase } from '../lib/supabase';

type IntegrationType = 'frontend_only' | 'google_drive' | 'ftp' | 'sftp' | 'remote_folder' | 'firebase_storage';

interface TenantIntegration {
  id: string;
  integration_type: IntegrationType;
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  folder_path: string | null;
  is_active: boolean;
  polling_interval_minutes: number;
  last_polled_at: string | null;
  updated_at: string;
  output_enabled: boolean;
  output_folder_path: string | null;
  output_format: 'csv' | 'json';
}

type CredentialFields = Record<string, string>;

const TYPE_LABELS: Record<IntegrationType, string> = {
  frontend_only: 'Subida manual', google_drive: 'Google Drive', ftp: 'FTP', sftp: 'SFTP', remote_folder: 'Carpeta de red (SMB)', firebase_storage: 'Firebase Storage',
};
const TYPE_ICONS: Record<IntegrationType, string> = {
  frontend_only: '🖥️', google_drive: '📁', ftp: '🗄️', sftp: '🔒', remote_folder: '🗂️', firebase_storage: '🔥',
};
const WORKER_STATUS: Record<IntegrationType, 'available' | 'coming_soon'> = {
  frontend_only: 'available', google_drive: 'available', ftp: 'available', sftp: 'available', remote_folder: 'coming_soon', firebase_storage: 'coming_soon',
};
const CRED_FIELDS: Record<IntegrationType, Array<{ key: string; label: string; type?: string; placeholder?: string; required?: boolean; }>> = {
  frontend_only: [],
  google_drive: [{ key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', placeholder: '{ "type": "service_account", ... }', required: true }, { key: 'folder_id', label: 'Folder ID de Google Drive', placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms', required: true }],
  ftp:          [{ key: 'host', label: 'Host', placeholder: 'ftp.servidor.com', required: true }, { key: 'port', label: 'Puerto', placeholder: '21' }, { key: 'username', label: 'Usuario', required: true }, { key: 'password', label: 'Contraseña', type: 'password', required: true }],
  sftp:         [{ key: 'host', label: 'Host', placeholder: 'sftp.servidor.com', required: true }, { key: 'port', label: 'Puerto', placeholder: '22' }, { key: 'username', label: 'Usuario', required: true }, { key: 'password', label: 'Contraseña', type: 'password' }, { key: 'private_key', label: 'Clave privada (SSH)', type: 'textarea', placeholder: '-----BEGIN RSA PRIVATE KEY-----\n...' }],
  remote_folder:[{ key: 'server_path', label: 'Ruta del servidor', placeholder: '\\\\servidor\\compartido\\facturas', required: true }, { key: 'domain', label: 'Dominio (opcional)', placeholder: 'WORKGROUP' }, { key: 'username', label: 'Usuario', required: true }, { key: 'password', label: 'Contraseña', type: 'password', required: true }],
  firebase_storage:[{ key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', placeholder: '{ "type": "service_account", ... }', required: true }, { key: 'bucket_name', label: 'Nombre del bucket', placeholder: 'mi-proyecto.appspot.com', required: true }],
};
const EMPTY_CREDS: Record<IntegrationType, CredentialFields> = {
  frontend_only: {}, google_drive: { service_account_json: '', folder_id: '' }, ftp: { host: '', port: '21', username: '', password: '' },
  sftp: { host: '', port: '22', username: '', password: '', private_key: '' }, remote_folder: { server_path: '', domain: '', username: '', password: '' }, firebase_storage: { service_account_json: '', bucket_name: '' },
};

export function IntegracionesPage() {
  const [integrations, setIntegrations] = useState<TenantIntegration[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<IntegrationType>('frontend_only');
  const [credentials, setCredentials]   = useState<CredentialFields>({});
  const [folderPath, setFolderPath]         = useState('');
  const [pollingInterval, setPollingInterval] = useState(15);
  const [outputEnabled, setOutputEnabled]   = useState(false);
  const [outputFolder, setOutputFolder]     = useState('output');
  const [outputFormat, setOutputFormat]     = useState<'csv' | 'json'>('csv');

  const loadIntegrations = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_my_integrations');
      if (rpcError) throw rpcError;
      setIntegrations((data as TenantIntegration[]) ?? []);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error al cargar integraciones'); } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadIntegrations(); }, [loadIntegrations]);

  const openAddForm = () => { setEditingId(null); setSelectedType('frontend_only'); setCredentials({}); setFolderPath(''); setPollingInterval(15); setOutputEnabled(false); setOutputFolder('output'); setOutputFormat('csv'); setSaveError(null); setShowForm(true); };
  const openEditForm = (i: TenantIntegration) => { setEditingId(i.id); setSelectedType(i.integration_type); setCredentials({ ...i.credentials }); setFolderPath(i.folder_path ?? ''); setPollingInterval(i.polling_interval_minutes); setOutputEnabled(i.output_enabled ?? false); setOutputFolder(i.output_folder_path ?? 'output'); setOutputFormat(i.output_format ?? 'csv'); setSaveError(null); setShowForm(true); };

  const handleSave = async () => {
    setSaving(true); setSaveError(null);
    try {
      const { error: rpcError } = await supabase.rpc('upsert_tenant_integration', { p_type: selectedType, p_config: {}, p_credentials: credentials, p_folder_path: folderPath || null, p_interval: pollingInterval, p_output_enabled: outputEnabled, p_output_folder: outputEnabled ? (outputFolder || 'output') : null, p_output_format: outputFormat });
      if (rpcError) throw rpcError;
      setShowForm(false); await loadIntegrations();
    } catch (e: unknown) { setSaveError(e instanceof Error ? e.message : 'Error al guardar'); } finally { setSaving(false); }
  };

  const handleToggle = async (id: string, current: boolean) => {
    try { const { error: rpcError } = await supabase.rpc('toggle_tenant_integration', { p_integration_id: id, p_active: !current }); if (rpcError) throw rpcError; await loadIntegrations(); } catch (e: unknown) { console.error(e); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar esta integración?')) return;
    try { const { error: rpcError } = await supabase.rpc('delete_tenant_integration', { p_integration_id: id }); if (rpcError) throw rpcError; await loadIntegrations(); } catch (e: unknown) { console.error(e); }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="max-w-2xl mx-auto space-y-6">

        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Integraciones</h1>
            <p className="text-sm text-muted-foreground">Configurá desde dónde el sistema busca archivos para procesar automáticamente.</p>
          </div>
          {!showForm && <Button onClick={openAddForm}>+ Nueva integración</Button>}
        </div>

        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

        {showForm && (
          <Card>
            <CardHeader><CardTitle className="text-base">{editingId ? 'Editar integración' : 'Nueva integración'}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="mb-2 block">Tipo de fuente</Label>
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
                  {(Object.keys(TYPE_LABELS) as IntegrationType[]).map((type) => (
                    <button key={type} type="button" onClick={() => { setSelectedType(type); setCredentials({ ...EMPTY_CREDS[type] }); }}
                      className={`rounded-lg border-2 p-3 text-left cursor-pointer transition-colors ${selectedType === type ? 'border-foreground bg-muted' : 'border-border bg-background hover:bg-muted/50'}`}>
                      <div className="text-xl mb-1">{TYPE_ICONS[type]}</div>
                      <div className="text-xs font-semibold leading-tight">{TYPE_LABELS[type]}</div>
                      {WORKER_STATUS[type] === 'coming_soon' && <div className="text-xs text-muted-foreground mt-0.5">🔜 Próximamente</div>}
                    </button>
                  ))}
                </div>
              </div>

              {CRED_FIELDS[selectedType].length > 0 && (
                <div className="space-y-3">
                  <Label className="text-sm font-medium">Credenciales</Label>
                  {CRED_FIELDS[selectedType].map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <Label htmlFor={`cred-${field.key}`} className="text-sm">{field.label}{field.required && <span className="text-destructive ml-1">*</span>}</Label>
                      {field.type === 'textarea'
                        ? <textarea id={`cred-${field.key}`} value={credentials[field.key] ?? ''} onChange={(e) => setCredentials((c) => ({ ...c, [field.key]: e.target.value }))} placeholder={field.placeholder} rows={4} className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y" />
                        : <Input id={`cred-${field.key}`} type={field.type ?? 'text'} value={credentials[field.key] ?? ''} onChange={(e) => setCredentials((c) => ({ ...c, [field.key]: e.target.value }))} placeholder={field.placeholder} />
                      }
                    </div>
                  ))}
                </div>
              )}

              {selectedType !== 'frontend_only' && (
                <div className="grid grid-cols-[2fr_1fr] gap-3">
                  <div className="space-y-1.5">
                    <Label>Carpeta a monitorear</Label>
                    <Input type="text" value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="/facturas/entrantes" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Intervalo (min)</Label>
                    <Input type="number" value={pollingInterval} onChange={(e) => setPollingInterval(Number(e.target.value))} min={5} max={1440} />
                  </div>
                </div>
              )}

              {selectedType !== 'frontend_only' && (
                <div className="space-y-3 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-sm font-medium">Salida automática</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">Depositar el CSV de resultados automáticamente al terminar el procesamiento.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setOutputEnabled((v) => !v)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${outputEnabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${outputEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                  {outputEnabled && (
                    <div className="grid grid-cols-[2fr_1fr] gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-sm">Carpeta de salida</Label>
                        <Input value={outputFolder} onChange={(e) => setOutputFolder(e.target.value)} placeholder="output" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-sm">Formato</Label>
                        <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value as 'csv' | 'json')}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                          <option value="csv">CSV</option>
                          <option value="json">JSON (próximamente)</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {saveError && <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert>}

              <div className="flex gap-3">
                <Button onClick={handleSave} disabled={saving}>{saving ? 'Guardando...' : 'Guardar'}</Button>
                <Button variant="outline" onClick={() => setShowForm(false)} disabled={saving}>Cancelar</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {integrations.length === 0 && !showForm ? (
          <Card>
            <CardContent className="py-12 text-center">
              <div className="text-4xl mb-3">🔌</div>
              <p className="font-semibold mb-1">Sin integraciones configuradas</p>
              <p className="text-sm text-muted-foreground mb-4">Configurá cómo quiere que el sistema busque archivos para procesar automáticamente.</p>
              <Button onClick={openAddForm}>+ Agregar integración</Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {integrations.map((integration) => (
              <Card key={integration.id}>
                <CardContent className="py-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{TYPE_ICONS[integration.integration_type]}</span>
                      <div>
                        <div className="font-medium text-sm">{TYPE_LABELS[integration.integration_type]}</div>
                        {integration.folder_path && <div className="text-xs text-muted-foreground font-mono mt-0.5">{integration.folder_path}</div>}
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          <Badge variant={integration.is_active ? 'success' : 'secondary'}>{integration.is_active ? '● Activa' : '○ Inactiva'}</Badge>
                          <Badge variant={WORKER_STATUS[integration.integration_type] === 'available' ? 'default' : 'secondary'}>{WORKER_STATUS[integration.integration_type] === 'available' ? '🟢 Disponible' : '🔜 Próximamente'}</Badge>
                          {integration.integration_type !== 'frontend_only' && <span className="text-xs text-muted-foreground self-center">Cada {integration.polling_interval_minutes} min</span>}
                          {integration.output_enabled && <Badge variant="secondary">📤 Salida automática</Badge>}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleToggle(integration.id, integration.is_active)}>{integration.is_active ? 'Desactivar' : 'Activar'}</Button>
                      <Button variant="outline" size="sm" onClick={() => openEditForm(integration)}>Editar</Button>
                      <Button variant="destructive" size="sm" onClick={() => handleDelete(integration.id)}>Eliminar</Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
