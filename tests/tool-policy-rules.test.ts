import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectLoader } from '../src/config/project-loader.js';
import { ConfigurationError } from '../src/errors.js';

interface ProjectConfigIssue {
  path: string;
  message: string;
}

function writeTempProject(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-policy-'));
  const filePath = path.join(dir, 'project.yaml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function expectInvalidProject(content: string): ProjectConfigIssue[] {
  const projectPath = writeTempProject(content);

  try {
    ProjectLoader.load(projectPath, { env: {} });
    throw new Error('Expected ProjectLoader.load to throw');
  } catch (error) {
    expect(error).toMatchObject<Partial<ConfigurationError>>({
      code: 'PROJECT_CONFIG_INVALID',
    });

    const metadata = (error as ConfigurationError).metadata as { issues?: ProjectConfigIssue[] } | undefined;
    expect(metadata?.issues).toBeTruthy();
    return metadata!.issues!;
  }
}

describe('tool policy confirmation rules', () => {
  it('allows a state-changing API tool when a matching confirmation rule exists', () => {
    const projectPath = writeTempProject(`
id: safe-rule-project
name: Safe Rule Project
model:
  provider: custom
  model: mock-model
connectors:
  - id: company-api
    type: api
    name: Company API
    config:
      baseUrl: https://example.test
      tools:
        - name: create_comment
          description: Create comment
          method: POST
          path: /tickets/comment
toolPolicy:
  confirmationRules:
    - tool: create_comment
      requireConfirmation: true
`);

    expect(() => ProjectLoader.load(projectPath)).not.toThrow();
  });

  it('rejects invalid confirmation rule entries', () => {
    const issues = expectInvalidProject(`
id: invalid-rule-project
name: Invalid Rule Project
model:
  provider: custom
  model: mock-model
connectors: []
toolPolicy:
  confirmationRules:
    - tool: save_result
      requireConfirmation: yes
    - requireConfirmation: true
`);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'toolPolicy.confirmationRules[0].requireConfirmation' }),
        expect.objectContaining({ path: 'toolPolicy.confirmationRules[1].tool' }),
      ]),
    );
  });
});
