import { useTranslation } from 'react-i18next';

import { LLM_PROVIDERS } from '@/shared/constants';
import type { LLMProvider, ProviderAuthStatusMap } from '@/shared/types';
import AgentConnectionCard from '@/modules/onboarding/AgentConnectionCard';

type AgentConnectionsStepProps = {
  providerStatuses: ProviderAuthStatusMap;
  onOpenProviderLogin: (provider: LLMProvider) => void;
};

/** Rendered by Onboarding as its second step, listing every CLI provider the user can log into. */
export default function AgentConnectionsStep({
  providerStatuses,
  onOpenProviderLogin,
}: AgentConnectionsStepProps) {
  const { t } = useTranslation('auth');
  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="font-serif text-xl font-bold tracking-tight text-foreground">{t('onboarding.agentsStepTitle')}</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {t('onboarding.agentsStepDescription')}
        </p>
      </div>

      <div className="-mr-1 max-h-[38vh] space-y-2 overflow-y-auto pr-1">
        {LLM_PROVIDERS.map((provider) => (
          <AgentConnectionCard
            key={provider}
            provider={provider}
            status={providerStatuses[provider]}
            onLogin={() => onOpenProviderLogin(provider)}
          />
        ))}
      </div>

      <p className="text-center text-xs text-muted-foreground">{t('onboarding.agentsLaterHint')}</p>
    </div>
  );
}
