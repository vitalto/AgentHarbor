import path from 'node:path';

import type { IProviderMcp } from '@/shared/interfaces.js';
import type { LLMProvider, McpScope, McpTransport, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const resolveWorkspacePath = (workspacePath?: string): string =>
  path.resolve(workspacePath ?? process.cwd());

const normalizeServerName = (name: string): string => {
  const normalized = name.trim();
  if (!normalized) {
    throw new AppError('MCP server name is required.', {
      code: 'MCP_SERVER_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  return normalized;
};

/**
 * Shared MCP provider for provider-specific config readers/writers.
 */
export abstract class McpProvider implements IProviderMcp {
  private pendingMutation = Promise.resolve();
  protected readonly provider: LLMProvider;
  protected readonly supportedScopes: McpScope[];
  protected readonly supportedTransports: McpTransport[];

  protected constructor(
    provider: LLMProvider,
    supportedScopes: McpScope[],
    supportedTransports: McpTransport[],
  ) {
    this.provider = provider;
    this.supportedScopes = supportedScopes;
    this.supportedTransports = supportedTransports;
  }

  async listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>> {
    const grouped: Record<McpScope, ProviderMcpServer[]> = {
      user: [],
      local: [],
      project: [],
    };

    for (const scope of this.supportedScopes) {
      grouped[scope] = await this.listServersForScope(scope, options);
    }

    return grouped;
  }

  async listServersForScope(
    scope: McpScope,
    options?: { workspacePath?: string },
  ): Promise<ProviderMcpServer[]> {
    if (!this.supportedScopes.includes(scope)) {
      return [];
    }

    const workspacePath = resolveWorkspacePath(options?.workspacePath);
    const scopedServers = await this.readScopedServers(scope, workspacePath);
    return Object.entries(scopedServers)
      .map(([name, rawConfig]) => this.normalizeServerConfig(scope, name, rawConfig))
      .filter((entry): entry is ProviderMcpServer => entry !== null);
  }

  // A user's local and global scopes can share a config file. Keep each read-modify-write together.
  private serializeMutation<T>(mutate: () => Promise<T>): Promise<T> {
    const result = this.pendingMutation.then(mutate);
    this.pendingMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    return this.serializeMutation(() => this.writeServer(input));
  }

  private async writeServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    const scope = input.scope ?? 'project';
    this.assertScopeAndTransport(scope, input.transport);

    const workspacePath = resolveWorkspacePath(input.workspacePath);
    const normalizedName = normalizeServerName(input.name);
    const scopedServers = await this.readScopedServers(scope, workspacePath);
    const previousName = input.previousName ? normalizeServerName(input.previousName) : normalizedName;
    if (input.previousName && !Object.hasOwn(scopedServers, previousName)) {
      throw new AppError('The MCP server being edited no longer exists.', { code: 'MCP_SERVER_NOT_FOUND', statusCode: 404 });
    }
    if (previousName !== normalizedName && Object.hasOwn(scopedServers, normalizedName)) {
      throw new AppError('Another MCP server already uses this name.', { code: 'MCP_NAME_CONFLICT', statusCode: 409 });
    }
    const config = this.buildServerConfig(input, scopedServers[previousName]);
    if (previousName !== normalizedName) delete scopedServers[previousName];
    await this.writeScopedServers(scope, workspacePath, { ...scopedServers, [normalizedName]: config });

    return {
      provider: this.provider,
      name: normalizedName,
      scope,
      transport: input.transport,
      command: input.command,
      args: input.args,
      env: input.env,
      cwd: input.cwd,
      url: input.url,
      headers: input.headers,
      envVars: input.envVars,
      bearerTokenEnvVar: input.bearerTokenEnvVar,
      envHttpHeaders: input.envHttpHeaders,
    };
  }

  removeServer(input: { name: string; scope?: McpScope; workspacePath?: string }) {
    return this.serializeMutation(() => this.deleteScopedServer(input));
  }

  private async deleteScopedServer(input: { name: string; scope?: McpScope; workspacePath?: string }) {
    const scope = input.scope ?? 'project';
    this.assertScope(scope);

    const workspacePath = resolveWorkspacePath(input.workspacePath);
    const normalizedName = normalizeServerName(input.name);
    const scopedServers = await this.readScopedServers(scope, workspacePath);
    const removed = Object.prototype.hasOwnProperty.call(scopedServers, normalizedName);
    if (removed) {
      delete scopedServers[normalizedName];
      await this.writeScopedServers(scope, workspacePath, scopedServers);
    }

    return { removed, provider: this.provider, name: normalizedName, scope };
  }

  protected abstract readScopedServers(
    scope: McpScope,
    workspacePath: string,
  ): Promise<Record<string, unknown>>;

  protected abstract writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void>;

  protected abstract buildServerConfig(input: UpsertProviderMcpServerInput, previous?: unknown): Record<string, unknown>;

  protected abstract normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null;

  protected assertScope(scope: McpScope): void {
    if (!this.supportedScopes.includes(scope)) {
      throw new AppError(`Provider "${this.provider}" does not support "${scope}" MCP scope.`, {
        code: 'MCP_SCOPE_NOT_SUPPORTED',
        statusCode: 400,
      });
    }
  }

  protected assertScopeAndTransport(scope: McpScope, transport: McpTransport): void {
    this.assertScope(scope);
    if (!this.supportedTransports.includes(transport)) {
      throw new AppError(`Provider "${this.provider}" does not support "${transport}" MCP transport.`, {
        code: 'MCP_TRANSPORT_NOT_SUPPORTED',
        statusCode: 400,
      });
    }
  }
}
