import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import { shouldShowGithubAuthentication } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { GithubTokenCredential, TokenMode } from '@/shared/types';
import GithubAuthenticationCard from '@/modules/project-creation-wizard/GithubAuthenticationCard';
import ProjectsDirectoryPicker from '@/modules/project-creation-wizard/ProjectsDirectoryPicker';
import WorkspacePathField from '@/modules/project-creation-wizard/WorkspacePathField';
import type { WorkspaceLocations } from '@/modules/project-creation-wizard/utils/workspaceApi';

type StepConfigurationProps = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  availableTokens: GithubTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  isCreating: boolean;
  locations: WorkspaceLocations | null;
  loadingLocations: boolean;
  locationsError: string | null;
  onWorkspacePathChange: (workspacePath: string) => void;
  onGithubUrlChange: (githubUrl: string) => void;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedGithubTokenChange: (tokenId: string) => void;
  onNewGithubTokenChange: (tokenValue: string) => void;
  onAdvanceToConfirm: () => void;
  onOpenProject: (projectId: string) => void;
  onChangeProjectsDirectory: () => void;
};

/** Rendered by ProjectCreationWizard as step 1, collecting the workspace path, clone URL and GitHub authentication. */
export default function StepConfiguration({
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  isCreating,
  locations,
  loadingLocations,
  locationsError,
  onWorkspacePathChange,
  onGithubUrlChange,
  onTokenModeChange,
  onSelectedGithubTokenChange,
  onNewGithubTokenChange,
  onAdvanceToConfirm,
  onOpenProject,
  onChangeProjectsDirectory,
}: StepConfigurationProps) {
  const { t } = useTranslation();
  const showGithubAuth = shouldShowGithubAuthentication(githubUrl);
  const projectsDirectory = locations?.projectsDirectory ?? null;

  return (
    <div className="space-y-4">
      <ProjectsDirectoryPicker
        locations={locations}
        loading={loadingLocations}
        error={locationsError}
        selectedPath={workspacePath}
        disabled={isCreating}
        onChooseFolder={(folderPath, advance) => {
          onWorkspacePathChange(folderPath);
          if (advance) {
            onAdvanceToConfirm();
          }
        }}
        onOpenProject={onOpenProject}
        onChangeProjectsDirectory={onChangeProjectsDirectory}
      />

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {projectsDirectory ? t('projectWizard.projectsFolder.anyFolder') : t('projectWizard.step2.newPath')}
        </label>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          projectsDirectory={projectsDirectory}
          places={locations?.places ?? []}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.newHelp')}
        </p>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.githubUrl')}
        </label>
        <Input
          type="text"
          value={githubUrl}
          onChange={(event) => onGithubUrlChange(event.target.value)}
          placeholder="https://github.com/username/repository"
          className="w-full"
          disabled={isCreating}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.githubHelp')}
        </p>
      </div>

      {showGithubAuth && (
        <GithubAuthenticationCard
          tokenMode={tokenMode}
          selectedGithubToken={selectedGithubToken}
          newGithubToken={newGithubToken}
          availableTokens={availableTokens}
          loadingTokens={loadingTokens}
          tokenLoadError={tokenLoadError}
          onTokenModeChange={onTokenModeChange}
          onSelectedGithubTokenChange={onSelectedGithubTokenChange}
          onNewGithubTokenChange={onNewGithubTokenChange}
        />
      )}
    </div>
  );
}
