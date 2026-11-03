import { useMatch, useNavigate } from 'react-router-dom';

import { cn } from '@/shared/utils';
import { usePlugins } from '@/modules/plugins/context/PluginsContext';
import PluginIcon from '@/modules/plugins/PluginIcon';

type AppPluginLinksProps = {
  buttonClassName: string;
  iconClassName: string;
};

/**
 * Rendered by the sidebar header and its collapsed rail: one button per enabled
 * plugin with slot "app", opening the plugin's own page at /plugins/<name>.
 * Such a plugin shows something global (not tied to a project or session), so
 * it lives beside the app-level actions instead of in each session's tab bar.
 */
export default function AppPluginLinks({ buttonClassName, iconClassName }: AppPluginLinksProps) {
  const { plugins } = usePlugins();
  const navigate = useNavigate();
  const openPluginName = useMatch('/plugins/:pluginName')?.params.pluginName;

  return (
    <>
      {plugins
        .filter((plugin) => plugin.enabled && plugin.slot === 'app')
        .map((plugin) => {
          const isOpen = plugin.name === openPluginName;
          return (
            <button
              key={plugin.name}
              type="button"
              onClick={() => navigate(`/plugins/${encodeURIComponent(plugin.name)}`)}
              aria-pressed={isOpen}
              aria-label={plugin.displayName}
              title={plugin.displayName}
              className={cn(buttonClassName, isOpen && 'bg-accent text-foreground')}
            >
              <PluginIcon
                pluginName={plugin.name}
                iconFile={plugin.icon}
                className={cn('flex items-center justify-center [&>svg]:h-full [&>svg]:w-full', iconClassName)}
              />
            </button>
          );
        })}
    </>
  );
}
