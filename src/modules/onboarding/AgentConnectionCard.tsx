import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LLM_PROVIDER_NAMES } from '@/shared/constants';
import { LLMProviderLogo } from '@/shared/ui';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types';

type AgentConnectionCardProps = {
  provider: LLMProvider;
  status: ProviderAuthStatus;
  onLogin: () => void;
};

/** Rendered by onboarding's AgentConnectionsStep to show one CLI provider's connection state. */
export default function AgentConnectionCard({
  provider,
  status,
  onLogin,
}: AgentConnectionCardProps) {
  const { t } = useTranslation('auth');
  const title = provider === 'claude' ? 'Claude Code' : LLM_PROVIDER_NAMES[provider];
  const containerClassName = status.authenticated ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800' : 'border-border bg-card';

  const statusText = status.loading
    ? t('onboarding.checking')
    : status.installed === false
      ? t('settings:agents.authStatus.cliMissing', { agent: title })
      : status.authenticated
        ? status.email || t('onboarding.connected')
        : status.error || t('onboarding.notConnected');

  return (
    <div className={`rounded-xl border px-3 py-2.5 transition-colors ${containerClassName}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
            <LLMProviderLogo provider={provider} className="h-5 w-5" />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              {title}
              {status.authenticated && <Check className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />}
            </div>
            <div className="truncate text-xs text-muted-foreground" title={statusText}>{statusText}</div>
          </div>
        </div>

        {!status.authenticated && !status.loading && (
          <button
            onClick={onLogin}
            className="flex-shrink-0 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            {t('onboarding.login')}
          </button>
        )}
      </div>
    </div>
  );
}
