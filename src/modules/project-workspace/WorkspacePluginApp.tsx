import { useTranslation } from 'react-i18next';

import { PluginIcon, PluginTabContent, usePlugins } from '@/modules/plugins';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';

type WorkspacePluginAppProps = {
  pluginName: string;
  isMobile: boolean;
  onMenuClick: () => void;
};

/**
 * Rendered by ProjectMainRegion for /plugins/<name>: an "app" plugin across the
 * whole main region, with no project or session in its context.
 */
export default function WorkspacePluginApp({ pluginName, isMobile, onMenuClick }: WorkspacePluginAppProps) {
  const { t } = useTranslation();
  const { plugins, loading } = usePlugins();
  const plugin = plugins.find((candidate) => candidate.name === pluginName && candidate.enabled);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border/60 px-3">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        {plugin && (
          <PluginIcon
            pluginName={plugin.name}
            iconFile={plugin.icon}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:h-full [&>svg]:w-full"
          />
        )}
        <h2 className="truncate text-sm font-semibold text-foreground">{plugin?.displayName ?? pluginName}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {plugin ? (
          <PluginTabContent pluginName={plugin.name} selectedProject={null} selectedSession={null} />
        ) : !loading && (
          <div className="p-4 text-sm text-muted-foreground">
            {t('common:misc.pluginNotFound', { name: pluginName, defaultValue: 'Plugin "{{name}}" is not installed or is turned off.' })}
          </div>
        )}
      </div>
    </div>
  );
}
