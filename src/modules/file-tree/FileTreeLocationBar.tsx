import { useState } from 'react';
import { ArrowUp, FolderRoot } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '@/shared/ui';

type FileTreeLocationBarProps = {
  /** The tree root as the user writes paths, or what they typed when it could not be opened. */
  displayPath: string;
  parentPath: string | null;
  /** The tree shows a folder other than the project root. */
  isAwayFromProject: boolean;
  onNavigate: (path: string) => void;
  onReturnToProject: () => void;
};

/** Rendered by FileTreeHeader: the tree root's path, editable to open any folder, with buttons to go up or back to the project. */
export default function FileTreeLocationBar({
  displayPath,
  parentPath,
  isAwayFromProject,
  onNavigate,
  onReturnToProject,
}: FileTreeLocationBarProps) {
  const { t } = useTranslation();
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const shownPath = draftPath ?? displayPath;

  const submitDraft = () => {
    const requestedPath = draftPath?.trim();
    setDraftPath(null);
    if (requestedPath && requestedPath !== displayPath) {
      onNavigate(requestedPath);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 shrink-0 p-0"
        onClick={() => parentPath && onNavigate(parentPath)}
        disabled={!parentPath}
        title={t('fileTree.location.up', 'Parent folder')}
        aria-label={t('fileTree.location.up', 'Parent folder')}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Input
        type="text"
        value={shownPath}
        onChange={(event) => setDraftPath(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={() => setDraftPath(null)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submitDraft();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setDraftPath(null);
            event.currentTarget.blur();
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={t('fileTree.location.placeholder', 'Folder path')}
        aria-label={t('fileTree.location.label', 'Folder shown in the tree')}
        title={displayPath}
        className="h-7 min-w-0 flex-1 font-mono text-xs"
      />
      {isAwayFromProject && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0"
          onClick={onReturnToProject}
          title={t('fileTree.location.backToProject', 'Back to the project folder')}
          aria-label={t('fileTree.location.backToProject', 'Back to the project folder')}
        >
          <FolderRoot className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
