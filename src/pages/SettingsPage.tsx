import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { THEMES, applyTheme, getStoredTheme } from '@/lib/themes';
import { cn } from '@/lib/utils';

// ─── Sección ──────────────────────────────────────────────────────────────────

function SettingsSection({ title, description, children }: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && (
          <CardDescription>{description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// ─── Página ───────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const [activeTheme, setActiveTheme] = useState(getStoredTheme);

  // Aplicar tema guardado al montar
  useEffect(() => {
    applyTheme(activeTheme);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleThemeSelect = (themeName: string) => {
    applyTheme(themeName);
    setActiveTheme(themeName);
  };

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-8">

      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Configuración</h1>
        <p className="text-sm text-muted-foreground">
          Preferencias de apariencia y comportamiento del sistema.
        </p>
      </div>

      {/* Apariencia */}
      <SettingsSection
        title="Apariencia"
        description="Elige la paleta de colores de la interfaz. El cambio se aplica de inmediato."
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {THEMES.map((theme) => (
            <button
              key={theme.name}
              onClick={() => handleThemeSelect(theme.name)}
              className={cn(
                'flex flex-col items-center gap-2.5 p-3 rounded-lg border-2 transition-all text-left',
                activeTheme === theme.name
                  ? 'border-primary bg-accent'
                  : 'border-border hover:border-muted-foreground/30 hover:bg-muted/50'
              )}
            >
              {/* Preview */}
              <div className="w-full h-10 rounded-md overflow-hidden flex">
                <div className="w-1/3 h-full" style={{ background: `hsl(${theme.vars['--foreground']})` }} />
                <div className="flex-1 h-full flex flex-col gap-0.5 p-1" style={{ background: '#f4f4f5' }}>
                  <div className="h-1.5 w-3/4 rounded-full" style={{ background: `hsl(${theme.vars['--primary']})` }} />
                  <div className="h-1.5 w-1/2 rounded-full" style={{ background: `hsl(${theme.vars['--muted-foreground']})`, opacity: 0.4 }} />
                  <div className="h-1.5 w-2/3 rounded-full" style={{ background: `hsl(${theme.vars['--primary']})`, opacity: 0.5 }} />
                </div>
              </div>

              {/* Nombre + check */}
              <div className="flex items-center justify-between w-full">
                <span className="text-xs font-medium text-foreground">{theme.label}</span>
                {activeTheme === theme.name && (
                  <svg className="w-3.5 h-3.5 text-primary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
            </button>
          ))}
        </div>
      </SettingsSection>

      {/* Más secciones — futuras preferencias */}
      <SettingsSection
        title="Próximamente"
        description="Más opciones de configuración estarán disponibles aquí."
      >
        <p className="text-sm text-muted-foreground">
          Notificaciones, preferencias de exportación, configuración de cuenta y más.
        </p>
      </SettingsSection>

    </div>
  );
}
