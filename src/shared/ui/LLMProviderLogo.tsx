import type { LLMProvider } from '@/shared/types';
import { SquareTerminal } from 'lucide-react';
import ClaudeLogo from '@/shared/ui/ClaudeLogo';

type LLMProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

/** Used by the chat, onboarding, project-workspace, settings and sidebar modules to show which coding agent a session or project belongs to. */
export function LLMProviderLogo({
  provider,
  className = 'w-5 h-5',
}: LLMProviderLogoProps) {
  if (provider === 'codex') return <SquareTerminal className={className} />;
  return <ClaudeLogo className={className} />;
}
