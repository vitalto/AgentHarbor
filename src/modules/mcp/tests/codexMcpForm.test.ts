import { describe, expect, it } from 'vitest';

import { createMcpPayloadFromForm } from '@/modules/mcp/utils/mcpFormatting';
import type { McpFormState } from '@/shared/types';

const form: McpFormState = {
  name: 'fixture', scope: 'project', workspacePath: '/work', transport: 'stdio',
  command: 'example', args: [], env: {}, cwd: '/work/tools', url: '', headers: {},
  envVars: ['TOOLS_KEY'], bearerTokenEnvVar: '', envHttpHeaders: {}, importMode: 'form', jsonInput: '',
};

describe('Codex MCP fields', () => {
  it('keeps the working directory and inherited variable names for stdio', () => {
    expect(createMcpPayloadFromForm('codex', form)).toMatchObject({ cwd: '/work/tools', envVars: ['TOOLS_KEY'] });
  });

  it('preserves environment based HTTP authentication in a form and a JSON import', () => {
    const fields = { bearerTokenEnvVar: 'TOKEN', envHttpHeaders: { 'X-Client': 'CLIENT' } };
    const http = { ...form, transport: 'http' as const, url: 'https://example.test', ...fields };
    expect(createMcpPayloadFromForm('codex', http)).toMatchObject(fields);
    const jsonInput = JSON.stringify({ type: 'http', url: http.url, bearer_token_env_var: 'TOKEN', env_http_headers: fields.envHttpHeaders });
    expect(createMcpPayloadFromForm('codex', { ...form, importMode: 'json', jsonInput })).toMatchObject(fields);
    expect(createMcpPayloadFromForm('codex', http, { includeProviderSpecificFields: false }).envHttpHeaders).toBeUndefined();
  });
});
