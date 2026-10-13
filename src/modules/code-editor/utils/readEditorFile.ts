import { api, readApiJson, type ApiRequestOptions } from '@/shared/api';

const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\/)/;

/**
 * The project file API reads only inside the project (plus Claude's temp and
 * transcript folders) and answers 403 elsewhere, yet a chat tool card opens
 * whatever file an agent touched, such as a render under C:\AI. An absolute
 * path it refuses is read the way the chat previews files: through the
 * downloads endpoint, which serves any absolute path to the signed-in user.
 * Writes still go through the project API alone.
 */
const isRefusedOutsideProject = (response: Response, filePath: string) =>
  response.status === 403 && ABSOLUTE_PATH.test(filePath);

export async function fetchEditorFileBlob(
  projectId: string,
  filePath: string,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const response = await api.readFileBlob(projectId, filePath, options);
  return isRefusedOutsideProject(response, filePath) ? api.downloads.content(filePath, options) : response;
}

export async function readEditorFileText(projectId: string, filePath: string): Promise<string> {
  const response = await api.readFile(projectId, filePath);
  if (isRefusedOutsideProject(response, filePath)) {
    const outside = await api.downloads.content(filePath);
    if (outside.ok) {
      return outside.text();
    }
  }
  // readApiJson carries the API's own explanation (a directory, a missing file) to the pane.
  return (await readApiJson<{ content: string }>(response)).content;
}
