import { useState } from 'react';

import type { AgentCategory, AgentProvider, AgentSettingsProject, ClaudePermissionsState, ProviderAuthStatusMap } from '@/shared/types';
import AgentCategoryContentSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryTabsSection';
import { LLM_PROVIDERS, LLM_PROVIDER_NAMES } from '@/shared/constants';
import { readSelectedProvider } from '@/shared/selectedProvider';
import { Button, LLMProviderLogo } from '@/shared/ui';

type AgentsSettingsTabProps = {
  providerAuthStatus: ProviderAuthStatusMap;
  onProviderLogin: (provider: AgentProvider) => void;
  claudePermissions: ClaudePermissionsState;
  onClaudePermissionsChange: (value: ClaudePermissionsState) => void;
  projects: AgentSettingsProject[];
};

const PROVIDER_CATEGORIES: Record<AgentProvider, AgentCategory[]> = {
  claude: ['account', 'permissions', 'runtime', 'mcp', 'skills'],
  codex: ['account', 'runtime', 'mcp', 'skills'],
};

/** Rendered by Settings for the "agents" tab, showing the settings supported by each CLI. */
export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  claudePermissions,
  onClaudePermissionsChange,
  projects,
}: AgentsSettingsTabProps) {
  // Inspecting another agent's settings must not switch the active chat.
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>(readSelectedProvider);
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');
  const categories = PROVIDER_CATEGORIES[selectedAgent];

  function selectAgent(agent: AgentProvider) {
    setSelectedAgent(agent);
    if (!PROVIDER_CATEGORIES[agent].includes(selectedCategory)) setSelectedCategory('account');
  }

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex gap-2 px-3 py-2 md:px-4">
          {LLM_PROVIDERS.map((agent) => (
            <Button
              key={agent}
              size="sm"
              variant={selectedAgent === agent ? 'secondary' : 'ghost'}
              aria-label={LLM_PROVIDER_NAMES[agent]}
              aria-pressed={selectedAgent === agent}
              onClick={() => selectAgent(agent)}
            >
              <LLMProviderLogo provider={agent} className="mr-2 h-4 w-4" />
              {LLM_PROVIDER_NAMES[agent]}
            </Button>
          ))}
        </div>
        <AgentCategoryTabsSection
          categories={categories}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />

        <AgentCategoryContentSection
          key={selectedAgent}
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          authStatus={providerAuthStatus[selectedAgent]}
          onLogin={() => onProviderLogin(selectedAgent)}
          claudePermissions={claudePermissions}
          onClaudePermissionsChange={onClaudePermissionsChange}
          projects={projects}
        />
      </div>
    </div>
  );
}
