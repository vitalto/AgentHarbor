import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Folder, FolderCog, FolderPlus, Loader2, Search } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import { joinFolderPath } from '@/modules/project-creation-wizard/utils/pathUtils';
import { matchProjectsDirectoryFolders } from '@/modules/project-creation-wizard/utils/projectsDirectoryFilter';
import type { WorkspaceLocations } from '@/modules/project-creation-wizard/utils/workspaceApi';

type ProjectsDirectoryPickerProps = {
  locations: WorkspaceLocations | null;
  loading: boolean;
  error: string | null;
  selectedPath: string;
  disabled: boolean;
  /** Picks a folder (existing, or one to create) as the new project's path; `advance` skips to the review step. */
  onChooseFolder: (folderPath: string, advance: boolean) => void;
  onOpenProject: (projectId: string) => void;
  onChangeProjectsDirectory: () => void;
};

type PickerRow =
  | { kind: 'new'; name: string; path: string }
  | { kind: 'folder'; name: string; path: string; projectId: string | null };

const samePath = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

/** Rendered by StepConfiguration: find a project in the projects folder (e.g. Develop) or name a new one there. */
export default function ProjectsDirectoryPicker({
  locations,
  loading,
  error,
  selectedPath,
  disabled,
  onChooseFolder,
  onOpenProject,
  onChangeProjectsDirectory,
}: ProjectsDirectoryPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [activeRowIndex, setActiveRowIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const projectsDirectory = locations?.projectsDirectory ?? null;

  const rows = useMemo<PickerRow[]>(() => {
    if (!projectsDirectory || !locations) {
      return [];
    }
    const matches = matchProjectsDirectoryFolders(locations.projectsDirectoryFolders, query);
    const folderRows: PickerRow[] = matches.folders.map((folder) => ({ kind: 'folder', ...folder }));
    return matches.newFolderName
      ? [
          { kind: 'new', name: matches.newFolderName, path: joinFolderPath(projectsDirectory, matches.newFolderName) },
          ...folderRows,
        ]
      : folderRows;
  }, [locations, projectsDirectory, query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${activeRowIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeRowIndex]);

  const activateRow = (row: PickerRow, advance: boolean) => {
    if (row.kind === 'folder' && row.projectId) {
      onOpenProject(row.projectId);
      return;
    }
    onChooseFolder(row.path, advance);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveRowIndex((index) => Math.min(index + 1, rows.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveRowIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && rows[activeRowIndex]) {
      event.preventDefault();
      activateRow(rows[activeRowIndex], true);
    }
  };

  if (loading && !locations) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-gray-200 py-10 dark:border-gray-700">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!projectsDirectory) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-4 dark:border-gray-600">
        <div className="flex items-start gap-3">
          <FolderCog className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-500" />
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-300">{t('projectWizard.projectsFolder.setupHint')}</p>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <Button type="button" size="sm" variant="outline" onClick={onChangeProjectsDirectory} disabled={disabled}>
              {t('projectWizard.projectsFolder.choose')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/40">
        <Folder className="h-4 w-4 flex-shrink-0 text-blue-500" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {t('projectWizard.projectsFolder.title')}
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-gray-500 dark:text-gray-400" title={projectsDirectory}>
          {projectsDirectory}
        </code>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={onChangeProjectsDirectory}
          disabled={disabled}
        >
          {t('projectWizard.projectsFolder.change')}
        </Button>
      </div>

      <div className="relative border-b border-gray-200 p-2 dark:border-gray-700">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <Input
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveRowIndex(0);
          }}
          onKeyDown={handleSearchKeyDown}
          placeholder={t('projectWizard.projectsFolder.searchPlaceholder')}
          className="w-full pl-8"
          disabled={disabled}
          autoFocus
        />
      </div>

      {error && <p className="px-3 pt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div ref={listRef} className="max-h-64 overflow-y-auto p-1" role="listbox">
        {rows.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {query.trim() ? t('projectWizard.projectsFolder.invalidName') : t('projectWizard.projectsFolder.empty')}
          </p>
        )}

        {rows.map((row, rowIndex) => {
          const isActive = rowIndex === activeRowIndex;
          const isProject = row.kind === 'folder' && Boolean(row.projectId);
          const isSelected = !isProject && samePath(row.path, selectedPath);
          return (
            <button
              key={`${row.kind}:${row.path}`}
              type="button"
              role="option"
              aria-selected={isSelected}
              data-row-index={rowIndex}
              disabled={disabled}
              onMouseEnter={() => setActiveRowIndex(rowIndex)}
              onClick={() => activateRow(row, false)}
              onDoubleClick={() => activateRow(row, true)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                isSelected
                  ? 'bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100'
                  : isActive
                    ? 'bg-gray-100 dark:bg-gray-700/60'
                    : ''
              }`}
            >
              {row.kind === 'new' ? (
                <FolderPlus className="h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" />
              ) : (
                <Folder className={`h-4 w-4 flex-shrink-0 ${isProject ? 'text-blue-500' : 'text-gray-400'}`} />
              )}

              <span className="min-w-0 flex-1 truncate">
                {row.kind === 'new'
                  ? t('projectWizard.projectsFolder.createNew', { name: row.name })
                  : row.name}
              </span>

              {isProject && (
                <span className="flex flex-shrink-0 items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
                  {t('projectWizard.projectsFolder.open')}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
