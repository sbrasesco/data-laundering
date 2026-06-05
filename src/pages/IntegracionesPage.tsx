import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { supabase } from '../lib/supabase';
import { useAuthContext } from '../contexts/AuthContext';

// ─── Env ──────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID    = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
const GOOGLE_REDIRECT_URI = import.meta.env.VITE_GOOGLE_REDIRECT_URI
  ?? 'http://localhost:3001/api/auth/google/callback';
const GOOGLE_SCOPE        = 'https://www.googleapis.com/auth/drive';

// Base URL del gateway (deriva de VITE_WORKER_GATEWAY_URL o usa default)
const GATEWAY_BASE_URL = (import.meta.env.VITE_GATEWAY_BASE_URL as string)
  ?? (import.meta.env.VITE_WORKER_GATEWAY_URL as string ?? '').replace('/api/enqueue', '')
  ?? 'http://localhost:3001';
const GATEWAY_API_KEY  = import.meta.env.VITE_WORKER_API_KEY as string ?? '';

// ─── Types ────────────────────────────────────────────────────────────────────
type IntegrationType = 'frontend_only' | 'google_drive' | 'ftp' | 'sftp' | 'remote_folder' | 'firebase_storage';
// Tipos disponibles en el selector (frontend_only no es una "integración" — es el comportamiento base)
const SELECTABLE_TYPES: IntegrationType[] = ['google_drive', 'ftp', 'sftp', 'remote_folder', 'firebase_storage'];

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

interface DriveFolder { id: string; name: string; }
type CredentialFields = Record<string, string>;

// ─── Static config ────────────────────────────────────────────────────────────
const TYPE_LABELS: Record<IntegrationType, string> = {
  frontend_only: 'Subida manual', google_drive: 'Google Drive',
  ftp: 'FTP', sftp: 'SFTP', remote_folder: 'Carpeta de red (SMB)', firebase_storage: 'Firebase Storage',
};
const TYPE_ICONS: Record<IntegrationType, string> = {
  frontend_only: '🖥️', google_drive: '📁', ftp: '🗄️', sftp: '🔒', remote_folder: '🗂️', firebase_storage: '🔥',
};
const WORKER_STATUS: Record<IntegrationType, 'available' | 'coming_soon'> = {
  frontend_only: 'available', google_drive: 'available', ftp: 'available', sftp: 'available',
  remote_folder: 'coming_soon', firebase_storage: 'coming_soon',
};

// Google Drive: sin credenciales manuales — todo se configura via OAuth + folder picker
const CRED_FIELDS: Record<IntegrationType, Array<{ key: string; label: string; type?: string; placeholder?: string; required?: boolean; }>> = {
  frontend_only:    [],
  google_drive:     [],  // OAuth: no hay campos manuales
  ftp:              [{ key: 'host', label: 'Host', placeholder: 'ftp.servidor.com', required: true }, { key: 'port', label: 'Puerto', placeholder: '21' }, { key: 'username', label: 'Usuario', required: true }, { key: 'password', label: 'Contraseña', type: 'password', required: true }],
  sftp:             [{ key: 'host', label: 'Host', placeholder: 'sftp.servidor.com', required: true }, { key: 'port', label: 'Puerto', placeholder: '22' }, { key: 'username', label: 'Usuario', required: true }, { key: 'password', label: 'Contraseña', type: 'password' }, { key: 'private_key', label: 'Clave privada (SSH)', type: 'textarea', placeholder: '-----BEGIN RSA PRIVATE KEY-----\n...' }],
  remote_folder:    [{ key: 'server_path', label: 'Ruta del servidor', placeholder: '\\\\servidor\\compartido\\facturas', required: true }, { key: 'domain', label: 'Dominio (opcional)', placeholder: 'WORKGROUP' }, { key: 'username', label: 'Usuario', required: true }, { key: 'password', label: 'Contraseña', type: 'password', required: true }],
  firebase_storage: [{ key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', placeholder: '{ "type": "service_account", ... }', required: true }, { key: 'bucket_name', label: 'Nombre del bucket', placeholder: 'mi-proyecto.appspot.com', required: true }],
};
const EMPTY_CREDS: Record<IntegrationType, CredentialFields> = {
  frontend_only: {}, google_drive: {},
  ftp: { host: '', port: '21', username: '', password: '' },
  sftp: { host: '', port: '22', username: '', password: '', private_key: '' },
  remote_folder: { server_path: '', domain: '', username: '', password: '' },
  firebase_storage: { service_account_json: '', bucket_name: '' },
};

// ─── OAuth helpers ─────────────────────────────────────────────────────────────
function buildGoogleOAuthUrl(orgId: string, integrationId: string): string {
  const state = btoa(JSON.stringify({ orgId, integrationId }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         GOOGLE_SCOPE,
    access_type:   'offline',
    prompt:        'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function hasDriveOAuth(integration: TenantIntegration): boolean {
  return !!integration.credentials?.oauth_refresh_token;
}
function hasDriveFolder(integration: TenantIntegration): boolean {
  return !!integration.credentials?.folder_id;
}

// ─── Componente ───────────────────────────────────────────────────────────────
export function IntegracionesPage() {
  const { organizationId } = useAuthContext();
  const [searchParams, setSearchParams] = useSearchParams();

  const [integrations, setIntegrations] = useState<TenantIntegration[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showForm, setShowForm]     = useState(false);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);

  const [selectedType, setSelectedType]       = useState<IntegrationType>('google_drive');
  const [credentials, setCredentials]         = useState<CredentialFields>({});
  const [folderPath, setFolderPath]           = useState('');
  const [pollingInterval, setPollingInterval] = useState(15);
  const [outputEnabled, setOutputEnabled]     = useState(false);
  const [outputFolder, setOutputFolder]       = useState('output');
  const [outputFormat, setOutputFormat]       = useState<'csv' | 'json'>('csv');

  // Folder picker state (por integration.id)
  const [driveFolders, setDriveFolders]           = useState<Record<string, DriveFolder[]>>({});
  const [loadingFolders, setLoadingFolders]       = useState<Record<string, boolean>>({});
  const [folderError, setFolderError]             = useState<Record<string, string>>({});
  const [selectedFolder, setSelectedFolder]       = useState<Record<string, string>>({});
  const [savingFolder, setSavingFolder]           = useState<Record<string, boolean>>({});

  // ── Detectar retorno de OAuth ────────────────────────────────────────────────
  useEffect(() => {
    const connected = searchParams.get('google_connected');
    const oauthErr  = searchParams.get('google_error');
    if (connected === 'true') {
      setSuccessMsg('✅ Google Drive conectado. Ahora seleccioná la carpeta a monitorear.');
      setSearchParams({}, { replace: true });
    } else if (oauthErr) {
      setError(`Error al conectar con Google Drive: ${oauthErr}`);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const loadIntegrations = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_my_integrations');
      if (rpcError) throw rpcError;
      setIntegrations((data as TenantIntegration[]) ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al cargar integraciones');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadIntegrations(); }, [loadIntegrations]);

  // Auto-cargar carpetas para integraciones con OAuth pero sin folder
  useEffect(() => {
    if (!organizationId) return;
    integrations.forEach((i) => {
      if (i.integration_type === 'google_drive' && hasDriveOAuth(i) && !hasDriveFolder(i)) {
        if (!driveFolders[i.id] && !loadingFolders[i.id]) {
          fetchDriveFolders(i.id);
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integrations, organizationId]);

  // ── Folder picker ─────────────────────────────────────────────────────────────
  const fetchDriveFolders = async (integrationId: string) => {
    if (!organizationId) return;
    setLoadingFolders(prev => ({ ...prev, [integrationId]: true }));
    setFolderError(prev => ({ ...prev, [integrationId]: '' }));
    try {
      const res = await fetch(
        `${GATEWAY_BASE_URL}/api/drive/folders?integration_id=${integrationId}&org_id=${organizationId}`,
        { headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` } }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error listando carpetas');
      setDriveFolders(prev => ({ ...prev, [integrationId]: data.folders ?? [] }));
    } catch (e: unknown) {
      setFolderError(prev => ({ ...prev, [integrationId]: e instanceof Error ? e.message : 'Error' }));
    } finally {
      setLoadingFolders(prev => ({ ...prev, [integrationId]: false }));
    }
  };

  const handleSetFolder = async (integration: TenantIntegration) => {
    const folderId = selectedFolder[integration.id];
    if (!folderId || !organizationId) return;
    const folder = driveFolders[integration.id]?.find(f => f.id === folderId);
    setSavingFolder(prev => ({ ...prev, [integration.id]: true }));
    try {
      const res = await fetch(`${GATEWAY_BASE_URL}/api/drive/set-folder`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${GATEWAY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_id: integration.id,
          org_id:         organizationId,
          folder_id:      folderId,
          folder_name:    folder?.name ?? folderId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error guardando carpeta');
      setSuccessMsg(`✅ Carpeta "${folder?.name}" configurada. La integración está lista.`);
      await loadIntegrations();
    } catch (e: unknown) {
      setFolderError(prev => ({ ...prev, [integration.id]: e instanceof Error ? e.message : 'Error' }));
    } finally {
      setSavingFolder(prev => ({ ...prev, [integration.id]: false }));
    }
  };

  // ── Formulario ────────────────────────────────────────────────────────────────
  const resetForm = () => {
    setEditingId(null); setSelectedType('google_drive'); setCredentials({});
    setFolderPath(''); setPollingInterval(15); setOutputEnabled(false);
    setOutputFolder('output'); setOutputFormat('csv'); setSaveError(null);
  };

  const openAddForm = () => { resetForm(); setSuccessMsg(null); setShowForm(true); };

  const openEditForm = (i: TenantIntegration) => {
    setEditingId(i.id); setSelectedType(i.integration_type);
    const editCreds = i.integration_type === 'google_drive' ? {} : { ...i.credentials };
    setCredentials(editCreds);
    setFolderPath(i.folder_path ?? ''); setPollingInterval(i.polling_interval_minutes);
    setOutputEnabled(i.output_enabled ?? false); setOutputFolder(i.output_folder_path ?? 'output');
    setOutputFormat(i.output_format ?? 'csv'); setSaveError(null); setShowForm(true);
  };

  // Guardar integración normal (FTP, SFTP, etc.)
  const handleSave = async () => {
    setSaving(true); setSaveError(null);
    try {
      const { error: rpcError } = await supabase.rpc('upsert_tenant_integration', {
        p_type: selectedType, p_config: {}, p_credentials: credentials,
        p_folder_path: folderPath || null, p_interval: pollingInterval,
        p_output_enabled: outputEnabled,
        p_output_folder: outputEnabled ? (outputFolder || 'output') : null,
        p_output_format: outputFormat,
      });
      if (rpcError) throw rpcError;
      setShowForm(false); await loadIntegrations();
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  // Google Drive: guardar config + iniciar OAuth en un solo click
  const handleConnectGoogleDrive = async () => {
    if (!organizationId) { setSaveError('No se pudo obtener el ID de organización.'); return; }
    if (!GOOGLE_CLIENT_ID) { setSaveError('VITE_GOOGLE_CLIENT_ID no está configurado.'); return; }
    setSaving(true); setSaveError(null);
    try {
      const { data: integrationId, error: rpcError } = await supabase.rpc('upsert_tenant_integration', {
        p_type: 'google_drive', p_config: {}, p_credentials: {},
        p_folder_path: null, p_interval: pollingInterval,
        p_output_enabled: outputEnabled,
        p_output_folder: outputEnabled ? (outputFolder || 'output') : null,
        p_output_format: outputFormat,
      });
      if (rpcError) throw rpcError;
      window.location.href = buildGoogleOAuthUrl(organizationId, integrationId as string);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Error al iniciar conexión');
      setSaving(false);
    }
  };

  // Reconectar Google Drive desde la tarjeta
  const handleReconnectGoogle = (integration: TenantIntegration) => {
    if (!organizationId || !GOOGLE_CLIENT_ID) return;
    window.location.href = buildGoogleOAuthUrl(organizationId, integration.id);
  };

  const handleToggle = async (id: string, current: boolean) => {
    try {
      const { error: rpcError } = await supabase.rpc('toggle_tenant_integration', { p_integration_id: id, p_active: !current });
      if (rpcError) throw rpcError;
      await loadIntegrations();
    } catch (e: unknown) { console.error(e); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar esta integración?')) return;
    try {
      const { error: rpcError } = await supabase.rpc('delete_tenant_integration', { p_integration_id: id });
      if (rpcError) throw rpcError;
      await loadIntegrations();
    } catch (e: unknown) { console.error(e); }
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

        {error      && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {successMsg && <Alert><AlertDescription>{successMsg}</AlertDescription></Alert>}

        {/* ── Formulario ─────────────────────────────────────────────────── */}
        {showForm && (
          <Card>
            <CardHeader><CardTitle className="text-base">{editingId ? 'Editar integración' : 'Nueva integración'}</CardTitle></CardHeader>
            <CardContent className="space-y-4">

              {/* Selector de tipo */}
              <div>
                <Label className="mb-2 block">Tipo de fuente</Label>
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
                  {SELECTABLE_TYPES.map((type) => (
                    <button key={type} type="button"
                      onClick={() => { setSelectedType(type); setCredentials({ ...EMPTY_CREDS[type] }); }}
                      className={`rounded-lg border-2 p-3 text-left cursor-pointer transition-colors ${selectedType === type ? 'border-foreground bg-muted' : 'border-border bg-background hover:bg-muted/50'}`}>
                      <div className="text-xl mb-1">{TYPE_ICONS[type]}</div>
                      <div className="text-xs font-semibold leading-tight">{TYPE_LABELS[type]}</div>
                      {WORKER_STATUS[type] === 'coming_soon' && <div className="text-xs text-muted-foreground mt-0.5">🔜 Próximamente</div>}
                    </button>
                  ))}
                </div>
              </div>

              {/* Aviso Google Drive */}
              {selectedType === 'google_drive' && (
                <Alert>
                  <AlertDescription className="text-sm">
                    Configurá el intervalo y luego hacé click en <strong>"Conectar con Google Drive"</strong>. Después de autorizar, podrás seleccionar la carpeta a monitorear directamente desde tu Drive.
                  </AlertDescription>
                </Alert>
              )}

              {/* Credenciales (no Google Drive) */}
              {CRED_FIELDS[selectedType].length > 0 && (
                <div className="space-y-3">
                  <Label className="text-sm font-medium">Credenciales</Label>
                  {CRED_FIELDS[selectedType].map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <Label htmlFor={`cred-${field.key}`} className="text-sm">
                        {field.label}{field.required && <span className="text-destructive ml-1">*</span>}
                      </Label>
                      {field.type === 'textarea'
                        ? <textarea id={`cred-${field.key}`} value={credentials[field.key] ?? ''}
                            onChange={(e) => setCredentials(c => ({ ...c, [field.key]: e.target.value }))}
                            placeholder={field.placeholder} rows={4}
                            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y" />
                        : <Input id={`cred-${field.key}`} type={field.type ?? 'text'}
                            value={credentials[field.key] ?? ''}
                            onChange={(e) => setCredentials(c => ({ ...c, [field.key]: e.target.value }))}
                            placeholder={field.placeholder} />
                      }
                    </div>
                  ))}
                </div>
              )}

              {/* Intervalo + carpeta */}
              {(
                <div className="grid grid-cols-[2fr_1fr] gap-3">
                  {selectedType !== 'google_drive' && (
                    <div className="space-y-1.5">
                      <Label>Carpeta a monitorear</Label>
                      <Input type="text" value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="/facturas/entrantes" />
                    </div>
                  )}
                  <div className={`space-y-1.5 ${selectedType === 'google_drive' ? 'col-span-2 max-w-[200px]' : ''}`}>
                    <Label>Intervalo (min)</Label>
                    <Input type="number" value={pollingInterval} onChange={(e) => setPollingInterval(Number(e.target.value))} min={5} max={1440} />
                  </div>
                </div>
              )}

              {/* Salida automática */}
              {(
                <div className="space-y-3 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-sm font-medium">Salida automática</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">Depositar el CSV al terminar el procesamiento.</p>
                    </div>
                    <button type="button" onClick={() => setOutputEnabled(v => !v)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${outputEnabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
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

              {/* Botones */}
              <div className="flex gap-3">
                {selectedType === 'google_drive' ? (
                  <Button onClick={handleConnectGoogleDrive} disabled={saving}>
                    {saving ? 'Conectando...' : '🔗 Conectar con Google Drive'}
                  </Button>
                ) : (
                  <Button onClick={handleSave} disabled={saving}>{saving ? 'Guardando...' : 'Guardar'}</Button>
                )}
                <Button variant="outline" onClick={() => { setShowForm(false); resetForm(); }} disabled={saving}>Cancelar</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Lista de integraciones ──────────────────────────────────────── */}
        {integrations.length === 0 && !showForm ? (
          <Card>
            <CardContent className="py-12 text-center">
              <div className="text-4xl mb-3">🔌</div>
              <p className="font-semibold mb-1">Sin integraciones configuradas</p>
              <p className="text-sm text-muted-foreground mb-4">Configurá cómo el sistema busca archivos para procesar automáticamente.</p>
              <Button onClick={openAddForm}>+ Agregar integración</Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {integrations.map((integration) => (
              <Card key={integration.id}>
                <CardContent className="py-4 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{TYPE_ICONS[integration.integration_type]}</span>
                      <div>
                        <div className="font-medium text-sm">{TYPE_LABELS[integration.integration_type]}</div>
                        {integration.folder_path && (
                          <div className="text-xs text-muted-foreground font-mono mt-0.5">📁 {integration.folder_path}</div>
                        )}
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          <Badge variant={integration.is_active ? 'success' : 'secondary'}>
                            {integration.is_active ? '● Activa' : '○ Inactiva'}
                          </Badge>
                          {integration.integration_type !== 'frontend_only' && (
                            <span className="text-xs text-muted-foreground self-center">Cada {integration.polling_interval_minutes} min</span>
                          )}
                          {integration.output_enabled && <Badge variant="secondary">📤 Salida automática</Badge>}

                          {/* Estado OAuth Google Drive */}
                          {integration.integration_type === 'google_drive' && (
                            hasDriveOAuth(integration)
                              ? <Badge variant="success">🔑 OAuth conectado</Badge>
                              : <Badge variant="outline" className="text-orange-600 border-orange-300">⚠️ Sin conectar</Badge>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {integration.integration_type === 'google_drive' && !hasDriveOAuth(integration) && (
                        <Button variant="default" size="sm" onClick={() => handleReconnectGoogle(integration)}>
                          🔗 Conectar con Google Drive
                        </Button>
                      )}
                      {integration.integration_type === 'google_drive' && hasDriveOAuth(integration) && (
                        <Button variant="ghost" size="sm" onClick={() => handleReconnectGoogle(integration)}>
                          🔄 Reconectar
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => handleToggle(integration.id, integration.is_active)}>
                        {integration.is_active ? 'Desactivar' : 'Activar'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => openEditForm(integration)}>Editar</Button>
                      <Button variant="destructive" size="sm" onClick={() => handleDelete(integration.id)}>Eliminar</Button>
                    </div>
                  </div>

                  {/* Folder picker: solo si OAuth OK pero sin carpeta */}
                  {integration.integration_type === 'google_drive' && hasDriveOAuth(integration) && !hasDriveFolder(integration) && (
                    <div className="border-t pt-3 space-y-2">
                      <Label className="text-sm font-medium">Seleccionar carpeta de Drive</Label>

                      {loadingFolders[integration.id] && (
                        <p className="text-xs text-muted-foreground">Cargando carpetas...</p>
                      )}

                      {folderError[integration.id] && (
                        <p className="text-xs text-destructive">{folderError[integration.id]}</p>
                      )}

                      {!loadingFolders[integration.id] && driveFolders[integration.id] && (
                        <div className="flex gap-2 items-end">
                          <div className="flex-1 space-y-1">
                            <select
                              value={selectedFolder[integration.id] ?? ''}
                              onChange={(e) => setSelectedFolder(prev => ({ ...prev, [integration.id]: e.target.value }))}
                              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              <option value="">— Elegí una carpeta —</option>
                              {driveFolders[integration.id].map(f => (
                                <option key={f.id} value={f.id}>{f.name}</option>
                              ))}
                            </select>
                          </div>
                          <Button
                            size="sm"
                            disabled={!selectedFolder[integration.id] || savingFolder[integration.id]}
                            onClick={() => handleSetFolder(integration)}
                          >
                            {savingFolder[integration.id] ? 'Guardando...' : 'Confirmar'}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => fetchDriveFolders(integration.id)}>
                            ↺
                          </Button>
                        </div>
                      )}

                      {!loadingFolders[integration.id] && !driveFolders[integration.id] && !folderError[integration.id] && (
                        <Button size="sm" variant="outline" onClick={() => fetchDriveFolders(integration.id)}>
                          Cargar carpetas
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Carpeta configurada */}
                  {integration.integration_type === 'google_drive' && hasDriveOAuth(integration) && hasDriveFolder(integration) && (
                    <div className="border-t pt-2 flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Carpeta:</span>
                      <span className="text-xs font-mono">{integration.folder_path ?? integration.credentials?.folder_id}</span>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs ml-auto"
                        onClick={() => {
                          setDriveFolders(prev => { const n = {...prev}; delete n[integration.id]; return n; });
                          fetchDriveFolders(integration.id);
                        }}>
                        Cambiar carpeta
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
