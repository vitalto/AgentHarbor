import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const writeSkill = async (
  skillsRoot: string,
  directoryName: string,
  name: string,
  description: string,
): Promise<string> => {
  const skillDir = path.join(skillsRoot, directoryName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n`,
    'utf8',
  );
  return skillPath;
};

const writeClaudePluginManifest = async (
  installPath: string,
  name: string,
): Promise<void> => {
  const pluginConfigDir = path.join(installPath, '.claude-plugin');
  await fs.mkdir(pluginConfigDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginConfigDir, 'plugin.json'),
    JSON.stringify(
      {
        name,
        version: '0.1.0',
        description: `${name} test plugin`,
      },
      null,
      2,
    ),
    'utf8',
  );
};

const writeClaudePluginCommand = async (
  commandsRoot: string,
  commandName: string,
  description: string,
): Promise<string> => {
  await fs.mkdir(commandsRoot, { recursive: true });
  const commandPath = path.join(commandsRoot, `${commandName}.md`);
  await fs.writeFile(
    commandPath,
    `---\ndescription: ${description}\nargument-hint: 'test args'\n---\n\nCommand body.\n`,
    'utf8',
  );
  return commandPath;
};

/**
 * This test covers Claude user/project skill folders plus plugin discovery from
 * installed plugin command files and plugin skill files, including a plugin that
 * ships both.
 */
test('providerSkillsService lists claude user, project, and enabled plugin skills', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-claude-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const commandPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'notion-plugin',
    'notion',
    'abc123',
  );
  const skillPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'anthropic-agent-skills',
    'example-skills',
    'def456',
  );
  const disabledPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'disabled-marketplace',
    'disabled-skills',
    'ghi789',
  );
  const emptyIdPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'invalid-empty-plugin',
    'empty',
    '000',
  );
  const atIdPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'invalid-at-plugin',
    'at',
    '000',
  );
  const siblingSkillPluginPath = path.join(path.dirname(skillPluginInstallPath), 'legacy777');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeSkill(
      path.join(tempRoot, '.claude', 'skills'),
      'claude-user-dir',
      'claude-user',
      'Claude user skill',
    );
    await writeSkill(
      path.join(workspacePath, '.claude', 'skills'),
      'claude-project-dir',
      'claude-project',
      'Claude project skill',
    );
    await writeClaudePluginManifest(commandPluginInstallPath, 'Notion');
    await writeClaudePluginCommand(
      path.join(commandPluginInstallPath, 'commands'),
      'insert-row',
      'Insert a Notion database row',
    );
    await writeSkill(
      path.join(commandPluginInstallPath, 'skills'),
      'command-plugin-skill-dir',
      'command-plugin-skill',
      'Skill shipped beside plugin commands',
    );
    await writeClaudePluginManifest(skillPluginInstallPath, 'ExampleSkills');
    // A commands folder holding nothing this reader takes must not hide the
    // skills beside it: plugins do ship commands in other agents' formats.
    await fs.mkdir(path.join(skillPluginInstallPath, 'commands'), { recursive: true });
    await fs.writeFile(
      path.join(skillPluginInstallPath, 'commands', 'other-agent.toml'),
      'description = "Command for another agent"\n',
      'utf8',
    );
    await writeSkill(
      path.join(skillPluginInstallPath, 'skills'),
      'claude-plugin-dir',
      'claude-plugin',
      'Claude plugin skill',
    );
    await writeSkill(
      path.join(skillPluginInstallPath, 'skills'),
      'claude-plugin-second-dir',
      'claude-plugin-second',
      'Second Claude plugin skill',
    );
    await writeSkill(
      path.join(skillPluginInstallPath, 'skills', 'nested', 'collection'),
      'claude-plugin-nested-dir',
      'claude-plugin-nested',
      'Nested Claude plugin skill',
    );
    await writeSkill(
      path.join(siblingSkillPluginPath, 'skills'),
      'claude-plugin-sibling-dir',
      'claude-plugin-sibling',
      'Sibling Claude plugin skill',
    );
    await writeClaudePluginManifest(disabledPluginInstallPath, 'DisabledSkills');
    await writeClaudePluginCommand(
      path.join(disabledPluginInstallPath, 'commands'),
      'disabled-command',
      'Disabled plugin command',
    );
    await writeClaudePluginCommand(
      path.join(emptyIdPluginInstallPath, 'commands'),
      'invalid-empty-command',
      'Invalid empty id command',
    );
    await writeClaudePluginCommand(
      path.join(atIdPluginInstallPath, 'commands'),
      'invalid-at-command',
      'Invalid at id command',
    );
    await writeSkill(
      path.join(
        disabledPluginInstallPath,
        'skills',
      ),
      'disabled-plugin-dir',
      'disabled-plugin',
      'Disabled plugin skill',
    );

    await fs.writeFile(
      path.join(tempRoot, '.claude', 'settings.json'),
      JSON.stringify(
        {
          enabledPlugins: {
            '': true,
            '@': true,
            'notion@notion-marketplace': true,
            'example-skills@anthropic-agent-skills': true,
            'disabled-skills@disabled-marketplace': false,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(
      path.join(tempRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            '': [
              {
                scope: 'user',
                installPath: emptyIdPluginInstallPath,
                version: '000',
              },
            ],
            '@': [
              {
                scope: 'user',
                installPath: atIdPluginInstallPath,
                version: '000',
              },
            ],
            'notion@notion-marketplace': [
              {
                scope: 'user',
                installPath: commandPluginInstallPath,
                version: 'abc123',
              },
            ],
            'example-skills@anthropic-agent-skills': [
              {
                scope: 'user',
                installPath: skillPluginInstallPath,
                version: 'def456',
              },
            ],
            'disabled-skills@disabled-marketplace': [
              {
                scope: 'user',
                installPath: disabledPluginInstallPath,
                version: 'ghi789',
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const skills = await providerSkillsService.listProviderSkills('claude', { workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.equal(byName.get('claude-user')?.scope, 'user');
    assert.equal(byName.get('claude-user')?.command, '/claude-user');
    assert.equal(byName.get('claude-project')?.scope, 'project');
    assert.equal(byName.get('claude-project')?.command, '/claude-project');

    const pluginCommand = byName.get('insert-row');
    assert.equal(pluginCommand?.scope, 'plugin');
    assert.equal(pluginCommand?.pluginName, 'Notion');
    assert.equal(pluginCommand?.pluginId, 'notion@notion-marketplace');
    assert.equal(pluginCommand?.command, '/Notion:insert-row');
    assert.equal(pluginCommand?.description, 'Insert a Notion database row');
    assert.match(pluginCommand?.sourcePath ?? '', /commands[\\/]insert-row\.md$/);
    // A plugin that ships commands keeps its skills: the CLI offers both, so
    // the menu lists both rather than letting the commands folder hide them.
    const commandPluginSkill = byName.get('command-plugin-skill');
    assert.equal(commandPluginSkill?.scope, 'plugin');
    assert.equal(commandPluginSkill?.pluginName, 'Notion');
    assert.equal(commandPluginSkill?.pluginId, 'notion@notion-marketplace');
    assert.equal(commandPluginSkill?.command, '/Notion:command-plugin-skill');
    assert.equal(commandPluginSkill?.description, 'Skill shipped beside plugin commands');

    const pluginSkill = byName.get('claude-plugin');
    assert.equal(pluginSkill?.scope, 'plugin');
    assert.equal(pluginSkill?.pluginName, 'ExampleSkills');
    assert.equal(pluginSkill?.pluginId, 'example-skills@anthropic-agent-skills');
    assert.equal(pluginSkill?.command, '/ExampleSkills:claude-plugin');
    assert.equal(pluginSkill?.description, 'Claude plugin skill');
    assert.match(
      pluginSkill?.sourcePath ?? '',
      /cache[\\/]anthropic-agent-skills[\\/]example-skills[\\/]def456[\\/]skills[\\/]/,
    );

    const secondPluginSkill = byName.get('claude-plugin-second');
    assert.equal(secondPluginSkill?.scope, 'plugin');
    assert.equal(secondPluginSkill?.command, '/ExampleSkills:claude-plugin-second');

    const nestedPluginSkill = byName.get('claude-plugin-nested');
    assert.equal(nestedPluginSkill?.scope, 'plugin');
    assert.equal(nestedPluginSkill?.command, '/ExampleSkills:claude-plugin-nested');
    assert.equal(nestedPluginSkill?.description, 'Nested Claude plugin skill');

    const siblingPluginSkill = byName.get('claude-plugin-sibling');
    assert.equal(siblingPluginSkill?.scope, 'plugin');
    assert.equal(siblingPluginSkill?.pluginName, 'example-skills');
    assert.equal(siblingPluginSkill?.command, '/example-skills:claude-plugin-sibling');
    assert.equal(siblingPluginSkill?.description, 'Sibling Claude plugin skill');
    assert.equal(byName.has('disabled-command'), false);
    assert.equal(byName.has('disabled-plugin'), false);
    assert.equal(byName.has('invalid-empty-command'), false);
    assert.equal(byName.has('invalid-at-command'), false);
    assert.equal(skills.some((skill) => skill.command.startsWith('/:')), false);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers managed global skill creation for providers that own a
 * writable user skill directory.
 */
test('providerSkillsService adds, replaces, and removes managed global claude skills', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-create-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const createdClaudeSkills = await providerSkillsService.addProviderSkills('claude', {
      entries: [
        {
          directoryName: 'claude-global-dir',
          content: '---\nname: claude-global\ndescription: Claude global skill\n---\n\nClaude body.\n',
        },
      ],
    });
    const createdClaudeSkill = createdClaudeSkills[0];
    assert.ok(createdClaudeSkill);
    assert.equal(createdClaudeSkill.command, '/claude-global');
    assert.equal(
      createdClaudeSkill.sourcePath.endsWith(path.join('.claude', 'skills', 'claude-global-dir', 'SKILL.md')),
      true,
    );
    assert.match(
      await fs.readFile(createdClaudeSkill.sourcePath, 'utf8'),
      /Claude body\./,
    );

    const createdUploadedSkills = await providerSkillsService.addProviderSkills('claude', {
      entries: [
        {
          directoryName: 'uploaded-skill-folder',
          fileName: 'SKILL.md',
          content: '---\nname: uploaded-global\ndescription: Uploaded global skill\n---\n\nUploaded body.\n',
          files: [
            {
              relativePath: 'scripts/run.js',
              content: Buffer.from('console.log("uploaded skill");\n').toString('base64'),
              encoding: 'base64',
            },
          ],
        },
      ],
    });
    const createdUploadedSkill = createdUploadedSkills[0];
    assert.ok(createdUploadedSkill);
    assert.equal(createdUploadedSkill.command, '/uploaded-global');
    assert.equal(
      createdUploadedSkill.sourcePath.endsWith(path.join('.claude', 'skills', 'uploaded-skill-folder', 'SKILL.md')),
      true,
    );
    assert.equal(
      await fs.readFile(path.join(path.dirname(createdUploadedSkill.sourcePath), 'scripts', 'run.js'), 'utf8'),
      'console.log("uploaded skill");\n',
    );

    const fallbackNamedSkills = await providerSkillsService.addProviderSkills('claude', {
      entries: [
        {
          fileName: 'fallback / skill.md',
          content: '---\ndescription: Normalized fallback skill\n---\n\nFallback body.\n',
        },
      ],
    });
    const fallbackNamedSkill = fallbackNamedSkills[0];
    assert.ok(fallbackNamedSkill);
    assert.equal(fallbackNamedSkill.name, 'fallback-skill');
    assert.equal(fallbackNamedSkill.command, '/fallback-skill');
    assert.equal(
      fallbackNamedSkill.sourcePath.endsWith(path.join('.claude', 'skills', 'fallback-skill', 'SKILL.md')),
      true,
    );

    const replacedUploadedSkills = await providerSkillsService.addProviderSkills('claude', {
      entries: [
        {
          directoryName: 'uploaded-skill-folder',
          content: '---\nname: replacement\ndescription: Replacement skill\n---\n\nReplacement body.\n',
        },
      ],
    });
    assert.equal(replacedUploadedSkills[0]?.command, '/replacement');
    assert.match(await fs.readFile(createdUploadedSkill.sourcePath, 'utf8'), /Replacement body\./);
    await assert.rejects(
      fs.stat(path.join(path.dirname(createdUploadedSkill.sourcePath), 'scripts', 'run.js')),
      { code: 'ENOENT' },
    );

    const pendingBatchSkillPath = path.join(tempRoot, '.claude', 'skills', 'pending-batch', 'SKILL.md');
    await assert.rejects(
      providerSkillsService.addProviderSkills('claude', {
        entries: [
          {
            directoryName: 'pending-batch',
            content: '---\nname: pending-batch\n---\n\nPending body.\n',
          },
          {
            directoryName: 'pending-batch',
            content: '---\nname: duplicate-batch\n---\n\nDuplicate body.\n',
          },
        ],
      }),
      /duplicate skill target/i,
    );
    await assert.rejects(fs.stat(pendingBatchSkillPath), { code: 'ENOENT' });

    const listedClaudeSkills = await providerSkillsService.listProviderSkills('claude');
    assert.equal(listedClaudeSkills.some((skill) => skill.name === 'claude-global'), true);
    assert.equal(listedClaudeSkills.some((skill) => skill.name === 'replacement'), true);

    const removedUploadedSkill = await providerSkillsService.removeProviderSkill('claude', {
      directoryName: 'uploaded-skill-folder',
    });
    assert.equal(removedUploadedSkill.removed, true);
    assert.equal(removedUploadedSkill.provider, 'claude');
    assert.equal(removedUploadedSkill.directoryName, 'uploaded-skill-folder');
    await assert.rejects(fs.stat(path.dirname(createdUploadedSkill.sourcePath)), { code: 'ENOENT' });

    const removedMissingSkill = await providerSkillsService.removeProviderSkill('claude', {
      directoryName: 'uploaded-skill-folder',
    });
    assert.equal(removedMissingSkill.removed, false);

    await assert.rejects(
      providerSkillsService.addProviderSkills('claude', {
        entries: [
          {
            content: '---\nname: unsafe-skill\n---\n',
            files: [
              {
                relativePath: '../outside.js',
                content: '',
                encoding: 'utf8',
              },
            ],
          },
        ],
      }),
      /invalid supporting file path/i,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
