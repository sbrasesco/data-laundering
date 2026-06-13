import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { supabase } from '../lib/supabase';
import { useAuthContext } from '../contexts/AuthContext';

// ─── Env ──────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID    = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
const GOOGLE_REDIRECT_URI = import.meta.env.VITE_GOOGLE_REDIRECT_URI
  ?? 'http://localhost:3001/api/auth/google/callback';
const GOOGLE_SCOPE        = 'https://www.googleapis.com/auth/drive';

const GATEWAY_BASE_URL = (import.meta.env.VITE_GATEWAY_BASE_URL as string)
  ?? (import.meta.env.VITE_WORKER_GATEWAY_URL as string ?? '').replace('/api/enqueue', '')
  ?? 'http://localhost:3001';
const GATEWAY_API_KEY  = import.meta.env.VITE_WORKER_API_KEY as string ?? '';

// ─── Types ────────────────────────────────────────────────────────────────────
type IntegrationType = 'frontend_only' | 'google_drive' | 'ftp' | 'sftp' | 'remote_folder' | 'firebase_storage';
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
  output_format: 'csv' | 'xlsx' | 'json';
}

interface DriveFolder { id: string; name: string; }
type CredentialFields = Record<string, string>;

// ─── Static config ────────────────────────────────────────────────────────────
const TYPE_LABELS: Record<IntegrationType, string> = {
  frontend_only: 'Subida manual', google_drive: 'Google Drive',
  ftp: 'FTP', sftp: 'SFTP', remote_folder: 'Carpeta de red (SMB)', firebase_storage: 'Firebase Storage',
};
const TYPE_ACCENTS: Record<IntegrationType, string> = {
  frontend_only: '#000000', google_drive: '#22C365', ftp: '#000000',
  sftp: '#A347D1', remote_folder: '#FED210', firebase_storage: '#e11d48',
};
const TYPE_ICON_FG: Record<IntegrationType, string> = {
  frontend_only: '#fff', google_drive: '#fff', ftp: '#fff',
  sftp: '#fff', remote_folder: '#000', firebase_storage: '#fff',
};
const WORKER_STATUS: Record<IntegrationType, 'available' | 'coming_soon'> = {
  frontend_only: 'available', google_drive: 'available', ftp: 'available', sftp: 'available',
  remote_folder: 'coming_soon', firebase_storage: 'coming_soon',
};
const CRED_FIELDS: Record<IntegrationType, Array<{ key: string; label: string; type?: string; placeholder?: string; required?: boolean; }>> = {
  frontend_only:    [],
  google_drive:     [],
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

// ─── SVG Icons ────────────────────────────────────────────────────────────────
function IntegTypeIcon({ type, size = 18 }: { type: IntegrationType; size?: number }) {
  const p = { width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, viewBox: '0 0 24 24', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (type) {
    case 'google_drive':
      return <svg {...p}><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>;
    case 'ftp':
      return <svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
    case 'sftp':
      return <svg {...p}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><circle cx="12" cy="16" r="1" fill="currentColor"/></svg>;
    case 'remote_folder':
      return <svg {...p}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="13" x2="12" y2="17"/><polyline points="9 15 12 12 15 15"/></svg>;
    case 'firebase_storage':
      return <svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
    default:
      return <svg {...p}><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>;
  }
}

function IconFolder({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
}
function IconRefresh({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>;
}
function IconLink({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>;
}
function IconLock({ size = 14, open = false }: { size?: number; open?: boolean }) {
  if (open) return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 019.9-1"/></svg>;
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>;
}
function IconUpload({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>;
}
function IconPlug({ size = 36 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/></svg>;
}

// ─── OAuth helpers ─────────────────────────────────────────────────────────────
function buildGoogleOAuthUrl(orgId: string, integrationId: string): string {
  const state = btoa(JSON.stringify({ orgId, integrationId }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code', scope: GOOGLE_SCOPE,
    access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
function hasDriveOAuth(i: TenantIntegration): boolean { return !!i.credentials?.oauth_refresh_token; }
function hasDriveFolder(i: TenantIntegration): boolean { return !!i.credentials?.folder_id; }

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
  const [outputEnabled, setOutputEnabled]         = useState(false);
  const [outputFolder, setOutputFolder]           = useState('extracciones');
  const [outputFolderLocked, setOutputFolderLocked] = useState(true);
  const [outputFolderOptions, setOutputFolderOptions] = useState<DriveFolder[]>([]);
  const [loadingOutputFolders, setLoadingOutputFolders] = useState(false);
  const [outputFolderError, setOutputFolderError] = useState<string | null>(null);
  const [outputFormat, setOutputFormat]           = useState<'csv' | 'xlsx' | 'json'>('csv');
  const [showXlsxDisclosure, setShowXlsxDisclosure] = useState(false);

  const [driveFolders, setDriveFolders]     = useState<Record<string, DriveFolder[]>>({});
  const [loadingFolders, setLoadingFolders] = useState<Record<string, boolean>>({});
  const [folderError, setFolderError]       = useState<Record<string, string>>({});
  const [selectedFolder, setSelectedFolder] = useState<Record<string, string>>({});
  const [savingFolder, setSavingFolder]     = useState<Record<string, boolean>>({});

  const loadIntegrations = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_my_integrations');
      if (rpcError) throw rpcError;
      setIntegrations((data as TenantIntegration[]) ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al cargar integraciones');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadIntegrations(); }, [loadIntegrations]);

  useEffect(() => {
    const connected     = searchParams.get('google_connected');
    const integrationId = searchParams.get('integration_id');
    const oauthErr      = searchParams.get('google_error');
    if (connected === 'true') {
      setSearchParams({}, { replace: true });
      if (integrationId) {
        supabase.rpc('toggle_tenant_integration', { p_integration_id: integrationId, p_active: true })
          .then(() => loadIntegrations());
      }
      setSuccessMsg('Google Drive conectado. Ahora seleccioná la carpeta a monitorear.');
    } else if (oauthErr) {
      setError(`Error al conectar con Google Drive: ${oauthErr}`);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, loadIntegrations]);

  useEffect(() => {
    if (!organizationId) return;
    integrations.forEach((i) => {
      if (i.integration_type === 'google_drive' && hasDriveOAuth(i) && !hasDriveFolder(i)) {
        if (!driveFolders[i.id] && !loadingFolders[i.id]) fetchDriveFolders(i.id);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integrations, organizationId]);

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
        method: 'POST',
        headers: { Authorization: `Bearer ${GATEWAY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ integration_id: integration.id, org_id: organizationId, folder_id: folderId, folder_name: folder?.name ?? folderId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error guardando carpeta');
      setSuccessMsg(`Carpeta "${folder?.name}" configurada. La integración está lista.`);
      await loadIntegrations();
    } catch (e: unknown) {
      setFolderError(prev => ({ ...prev, [integration.id]: e instanceof Error ? e.message : 'Error' }));
    } finally {
      setSavingFolder(prev => ({ ...prev, [integration.id]: false }));
    }
  };

  const resetForm = () => {
    setEditingId(null); setSelectedType('google_drive'); setCredentials({});
    setFolderPath(''); setPollingInterval(15); setOutputEnabled(false);
    setOutputFolder('extracciones'); setOutputFolderLocked(true); setOutputFormat('csv'); setSaveError(null);
  };

  const openConfigureForm = (type: IntegrationType) => {
    resetForm(); setSelectedType(type); setCredentials({ ...EMPTY_CREDS[type] }); setSuccessMsg(null); setShowForm(true);
  };

  const openEditForm = (i: TenantIntegration) => {
    setEditingId(i.id); setSelectedType(i.integration_type);
    setCredentials(i.integration_type === 'google_drive' ? {} : { ...i.credentials });
    setFolderPath(i.folder_path ?? ''); setPollingInterval(i.polling_interval_minutes);
    setOutputEnabled(i.output_enabled ?? false);
    const savedFolder = i.output_folder_path ?? 'extracciones';
    setOutputFolder(savedFolder); setOutputFolderLocked(savedFolder === 'extracciones');
    setOutputFormat((i.output_format ?? 'csv') as 'csv' | 'xlsx' | 'json');
    setSaveError(null); setShowForm(true);
  };

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
    } finally { setSaving(false); }
  };

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

  const handleReconnectGoogle = (integration: TenantIntegration) => {
    if (!organizationId || !GOOGLE_CLIENT_ID) return;
    window.location.href = buildGoogleOAuthUrl(organizationId, integration.id);
  };

  const fetchOutputFolderOptions = async (integrationId: string) => {
    if (!organizationId) return;
    setLoadingOutputFolders(true); setOutputFolderOptions([]); setOutputFolderError(null);
    try {
      const res = await fetch(
        `${GATEWAY_BASE_URL}/api/drive/folders?integration_id=${integrationId}&org_id=${organizationId}`,
        { headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` } }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setOutputFolderOptions(data.folders ?? []);
    } catch (e: unknown) {
      setOutputFolderError(e instanceof Error ? e.message : 'Error cargando carpetas');
    } finally { setLoadingOutputFolders(false); }
  };

  const [confirmActivate, setConfirmActivate] = useState<{ id: string; newType: string; currentType: string } | null>(null);

  const handleToggle = async (id: string, current: boolean, integrationType: string) => {
    if (!current) {
      const activeIntegration = integrations.find(i => i.is_active && i.id !== id);
      if (activeIntegration) {
        setConfirmActivate({
          id,
          newType: TYPE_LABELS[integrationType as IntegrationType] ?? integrationType,
          currentType: TYPE_LABELS[activeIntegration.integration_type] ?? activeIntegration.integration_type,
        });
        return;
      }
    }
    await doToggle(id, current);
  };

  const doToggle = async (id: string, current: boolean) => {
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

  const selectCls = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  if (loading) return <LoadingSpinner />;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="inline-block px-2 py-0.5 rounded-lg" style={{ background: '#A347D1', color: '#ffffff' }}>Integraciones</span>
          </h1>
          <p className="text-sm text-muted-foreground">Configurá desde dónde el sistema busca archivos para procesar automáticamente.</p>
        </div>
        {/* sin botón global — cada tarjeta tiene su propio CTA */}
      </div>

      {error      && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {successMsg && <Alert><AlertDescription>{successMsg}</AlertDescription></Alert>}

      {/* ── Lista ───────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          {SELECTABLE_TYPES.map((type) => {
            const integration = integrations.find(i => i.integration_type === type) ?? null;
            return (
            <Card key={type} className="overflow-hidden">
              <CardContent className="p-0">

                {/* ── Card header ──────────────────────────────────────────── */}
                {/* ── Header: siempre visible ──────────────────────────────── */}
                <div className="flex items-center gap-3 px-5 py-4">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: TYPE_ACCENTS[type], color: TYPE_ICON_FG[type] }}
                  >
                    <IntegTypeIcon type={type} size={20} />
                  </div>
                  <div>
                    <p className="font-semibold text-sm leading-tight">{TYPE_LABELS[type]}</p>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {integration ? (
                        <Badge variant={integration.is_active ? 'success' : 'secondary'}>
                          {integration.is_active ? 'Activa' : 'Inactiva'}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">No configurada</Badge>
                      )}
                      {integration?.integration_type === 'google_drive' && (
                        hasDriveOAuth(integration)
                          ? <Badge variant="info">OAuth conectado</Badge>
                          : <Badge variant="outline" className="text-orange-600 border-orange-300">Sin conectar</Badge>
                      )}
                      {WORKER_STATUS[type] === 'coming_soon' && (
                        <Badge variant="secondary">Próximamente</Badge>
                      )}
                    </div>
                  </div>
                </div>

                {integration ? (<>
                  {/* ── Info: Entrada / Salida ─────────────────────────────── */}
                  <div className="border-t border-border divide-y divide-border">
                    <div className="px-5 py-3 space-y-1">
                      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Entrada</p>
                      {integration.folder_path ? (
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="text-muted-foreground flex-shrink-0"><IconFolder /></span>
                          <span className="font-mono break-all">{integration.folder_path}</span>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">Sin carpeta configurada</p>
                      )}
                      <p className="text-xs text-muted-foreground">Cada {integration.polling_interval_minutes} min</p>
                    </div>
                    <div className="px-5 py-3 space-y-1">
                      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Salida</p>
                      {integration.output_enabled ? (
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="text-muted-foreground flex-shrink-0"><IconUpload /></span>
                          <span>{integration.output_format?.toUpperCase()}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-mono break-all">{integration.output_folder_path ?? 'extracciones'}</span>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">Deshabilitada</p>
                      )}
                    </div>
                  </div>

                  {/* ── Drive folder picker ────────────────────────────────── */}
                  {integration.integration_type === 'google_drive' && hasDriveOAuth(integration) && !hasDriveFolder(integration) && (
                    <div className="border-t border-border px-5 py-3 space-y-2 bg-muted/20">
                      <p className="text-xs font-medium text-muted-foreground">Seleccioná la carpeta de Drive a monitorear</p>
                      {loadingFolders[integration.id] && <p className="text-xs text-muted-foreground">Cargando carpetas...</p>}
                      {folderError[integration.id] && <p className="text-xs text-destructive">{folderError[integration.id]}</p>}
                      {!loadingFolders[integration.id] && driveFolders[integration.id] && (
                        <div className="flex gap-2 items-center">
                          <select value={selectedFolder[integration.id] ?? ''} onChange={(e) => setSelectedFolder(prev => ({ ...prev, [integration.id]: e.target.value }))} className={`${selectCls} flex-1`}>
                            <option value="">— Elegí una carpeta —</option>
                            {driveFolders[integration.id].map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                          </select>
                          <Button size="sm" disabled={!selectedFolder[integration.id] || savingFolder[integration.id]} onClick={() => handleSetFolder(integration)}>
                            {savingFolder[integration.id] ? 'Guardando...' : 'Confirmar'}
                          </Button>
                          <button type="button" onClick={() => fetchDriveFolders(integration.id)} className="h-9 w-9 flex items-center justify-center rounded-md border border-input bg-background hover:bg-muted transition-colors text-muted-foreground">
                            <IconRefresh />
                          </button>
                        </div>
                      )}
                      {!loadingFolders[integration.id] && !driveFolders[integration.id] && !folderError[integration.id] && (
                        <Button size="sm" variant="outline" onClick={() => fetchDriveFolders(integration.id)}>Cargar carpetas</Button>
                      )}
                    </div>
                  )}

                  {/* ── Carpeta Drive configurada ──────────────────────────── */}
                  {integration.integration_type === 'google_drive' && hasDriveOAuth(integration) && hasDriveFolder(integration) && (
                    <div className="border-t border-border px-5 py-2 flex items-center gap-2 bg-muted/10">
                      <span className="text-xs text-muted-foreground flex items-center gap-1"><IconFolder /> Carpeta:</span>
                      <span className="text-xs font-mono">{integration.folder_path ?? integration.credentials?.folder_id}</span>
                      <button type="button" onClick={() => { setDriveFolders(prev => { const n = {...prev}; delete n[integration.id]; return n; }); fetchDriveFolders(integration.id); }} className="ml-auto text-xs text-muted-foreground hover:text-foreground underline">
                        Cambiar
                      </button>
                    </div>
                  )}

                  {/* ── Acciones: configurada ──────────────────────────────── */}
                  <div className="border-t border-border px-5 py-3 flex items-center gap-3 bg-muted/20">
                    <button type="button" onClick={() => handleToggle(integration.id, integration.is_active, integration.integration_type)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${integration.is_active ? 'bg-[#22C365]' : 'bg-slate-300'}`}>
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${integration.is_active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                    <span className="text-xs text-muted-foreground">{integration.is_active ? 'Activa' : 'Inactiva'}</span>
                    <div className="ml-auto flex items-center gap-2">
                      {integration.integration_type === 'google_drive' && !hasDriveOAuth(integration) && (
                        <Button size="sm" onClick={() => handleReconnectGoogle(integration)} className="gap-1.5">
                          <IconLink size={13} /> Conectar
                        </Button>
                      )}
                      {integration.integration_type === 'google_drive' && hasDriveOAuth(integration) && (
                        <button type="button" onClick={() => handleReconnectGoogle(integration)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                          <IconRefresh size={12} /> Reconectar
                        </button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => openEditForm(integration)}>Editar</Button>
                    </div>
                  </div>
                </>) : (
                  /* ── Estado: no configurada ───────────────────────────────── */
                  <div className="border-t border-border px-5 py-4 flex items-center justify-between bg-muted/10">
                    <p className="text-xs text-muted-foreground">Sin configuración</p>
                    {WORKER_STATUS[type] === 'coming_soon' ? (
                      <span className="text-xs text-muted-foreground">Próximamente</span>
                    ) : type === 'google_drive' ? (
                      <Button size="sm" onClick={() => openConfigureForm(type)} className="gap-1.5">
                        <IconLink size={13} /> Configurar
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => openConfigureForm(type)}>Configurar</Button>
                    )}
                  </div>
                )}

              </CardContent>
            </Card>
            );
          })}
        </div>

      {/* ── Modal: formulario nueva/editar integración ──────────────────────── */}
      <Dialog open={showForm} onOpenChange={(open) => { if (!open) { setShowForm(false); resetForm(); } }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-1">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: TYPE_ACCENTS[selectedType], color: TYPE_ICON_FG[selectedType] }}>
                <IntegTypeIcon type={selectedType} size={18} />
              </div>
              <div>
                <DialogTitle>{editingId ? `Editar — ${TYPE_LABELS[selectedType]}` : `Configurar — ${TYPE_LABELS[selectedType]}`}</DialogTitle>
                <DialogDescription>
                  {editingId ? 'Modificá la configuración de esta integración.' : 'Configurá los accesos para esta fuente.'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-5 pt-1">

            {/* Aviso Google Drive */}
            {selectedType === 'google_drive' && (
              <Alert>
                <AlertDescription className="text-sm">
                  Configurá el intervalo y luego hacé click en <strong>"Conectar con Google Drive"</strong>. Después de autorizar, podrás seleccionar la carpeta a monitorear.
                </AlertDescription>
              </Alert>
            )}

            {/* Credenciales */}
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

            {/* Carpeta + intervalo */}
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

            {/* Salida automática */}
            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium flex items-center gap-1.5">
                    <IconUpload size={13} /> Salida automática
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Depositar el resultado al terminar el procesamiento.</p>
                </div>
                <button type="button" onClick={() => setOutputEnabled(v => !v)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${outputEnabled ? 'bg-primary' : 'bg-slate-300'}`}>
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${outputEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {outputEnabled && (
                <div className="grid grid-cols-[2fr_1fr] gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-sm">Carpeta de salida</Label>
                    <div className="flex gap-1.5 items-center">
                      {outputFolderLocked ? (
                        <div className="flex flex-1 items-center gap-2 h-9 px-3 rounded-md border border-input bg-muted text-sm text-muted-foreground">
                          <IconFolder size={13} />
                          <span className="font-mono flex-1">{outputFolder}</span>
                        </div>
                      ) : selectedType === 'google_drive' && editingId ? (
                        loadingOutputFolders
                          ? <div className="flex flex-1 items-center h-9 px-3 text-sm text-muted-foreground">Cargando carpetas...</div>
                          : outputFolderError
                            ? <div className="flex flex-1 items-center gap-2 h-9 px-3 text-sm text-destructive">
                                <span>{outputFolderError}</span>
                                <button type="button" onClick={() => fetchOutputFolderOptions(editingId)} className="underline text-xs">Reintentar</button>
                              </div>
                            : (
                              <select className={`${selectCls} flex-1`} value={outputFolder} onChange={(e) => setOutputFolder(e.target.value)}>
                                <option value="extracciones">extracciones (default)</option>
                                {outputFolderOptions.filter(f => f.name !== 'extracciones').map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
                              </select>
                            )
                      ) : (
                        <Input className="flex-1" value={outputFolder} onChange={(e) => setOutputFolder(e.target.value)} placeholder="extracciones" autoFocus />
                      )}
                      <button
                        type="button"
                        title={outputFolderLocked ? 'Cambiar carpeta de salida' : 'Volver al default'}
                        onClick={() => {
                          if (outputFolderLocked) {
                            setOutputFolderLocked(false);
                            if (selectedType === 'google_drive' && editingId) fetchOutputFolderOptions(editingId);
                          } else {
                            setOutputFolder('extracciones');
                            setOutputFolderLocked(true);
                          }
                        }}
                        className="h-9 w-9 flex items-center justify-center rounded-md border border-input bg-background hover:bg-muted transition-colors text-muted-foreground"
                      >
                        <IconLock size={14} open={!outputFolderLocked} />
                      </button>
                    </div>
                    {!outputFolderLocked && (
                      <p className="text-xs text-muted-foreground">
                        {selectedType === 'google_drive' ? 'Seleccioná la carpeta destino en tu Drive.' : 'Ingresá el nombre de la carpeta de salida.'}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Formato</Label>
                    <select
                      value={outputFormat}
                      onChange={(e) => {
                        const val = e.target.value as 'csv' | 'xlsx' | 'json';
                        if (val === 'xlsx' && !localStorage.getItem('dl_xlsx_disclosure_seen')) {
                          setShowXlsxDisclosure(true);
                        } else {
                          setOutputFormat(val);
                        }
                      }}
                      className={selectCls}
                    >
                      <option value="csv">CSV</option>
                      <option value="xlsx">Excel (.xlsx)</option>
                      <option value="json">JSON (próximamente)</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {saveError && <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert>}

            {/* Botones */}
            <div className="flex gap-3 pt-1">
              {selectedType === 'google_drive' && !editingId ? (
                <Button onClick={handleConnectGoogleDrive} disabled={saving} className="gap-1.5">
                  <IconLink size={13} /> {saving ? 'Conectando...' : 'Conectar con Google Drive'}
                </Button>
              ) : (
                <Button onClick={handleSave} disabled={saving}>{saving ? 'Guardando...' : 'Guardar'}</Button>
              )}
              <Button variant="outline" onClick={() => { setShowForm(false); resetForm(); }} disabled={saving}>Cancelar</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal: confirmar cambio de integración activa ──────────────────── */}
      {confirmActivate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-xl shadow-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h2 className="font-semibold text-base">Cambiar integración activa</h2>
            <p className="text-sm text-muted-foreground">
              Tenés <strong>{confirmActivate.currentType}</strong> activa. Si continuás, se desactivará y se activará <strong>{confirmActivate.newType}</strong>.
            </p>
            <p className="text-xs text-muted-foreground">Solo puede haber una integración activa a la vez.</p>
            <div className="flex gap-3 justify-end pt-2">
              <Button variant="outline" onClick={() => setConfirmActivate(null)}>Cancelar</Button>
              <Button onClick={async () => {
                const { id } = confirmActivate;
                setConfirmActivate(null);
                await doToggle(id, false);
              }}>Confirmar</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Disclosure: costo incremental Excel ───────────────────────────── */}
      <Dialog open={showXlsxDisclosure} onOpenChange={(open) => { if (!open) setShowXlsxDisclosure(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Formato Excel — costo incremental</DialogTitle>
            <DialogDescription>
              Exportar en formato <strong>Excel (.xlsx)</strong> tiene un costo ligeramente mayor por documento procesado.
              El incremento exacto se aplica según la tabla de precios vigente. Podés volver a CSV en cualquier momento.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowXlsxDisclosure(false)}>Cancelar</Button>
            <Button onClick={() => { localStorage.setItem('dl_xlsx_disclosure_seen', '1'); setOutputFormat('xlsx'); setShowXlsxDisclosure(false); }}>
              Entendido, usar Excel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
