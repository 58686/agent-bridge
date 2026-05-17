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

  it('rejects invalid confirmation rule entries and timeout', () => {
    const issues = expectInvalidProject(`
id: invalid-rule-project
name: Invalid Rule Project
model:
  provider: custom
  model: mock-model
connectors: []
toolPolicy:
  confirmationTimeoutMs: 0
  confirmationRules:
    - tool: save_result
      requireConfirmation: yes
    - requireConfirmation: true
`);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'toolPolicy.confirmationTimeoutMs' }),
        expect.objectContaining({ path: 'toolPolicy.confirmationRules[0].requireConfirmation' }),
        expect.objectContaining({ path: 'toolPolicy.confirmationRules[1].tool' }),
      ]),
    );
  });

  it('rejects invalid nested tool parameter schema entries', () => {
    const issues = expectInvalidProject(`
id: invalid-schema-project
name: Invalid Schema Project
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
        - name: save_result
          description: Save result
          method: POST
          path: /results
          parameters:
            scoreLevel:
              type: string
              description: Score level
              enum: []
            tags:
              type: array
              description: Tags
              items:
                type: uuid
            evidence:
              type: object
              description: Evidence
              properties: []
            invalidItems:
              type: string
              description: Invalid items
              items:
                type: string
                description: Item
            invalidProperties:
              type: number
              description: Invalid properties
              properties:
                nested:
                  type: string
                  description: Nested
            requiredFlag:
              type: string
              description: Required flag
              required: yes
toolPolicy:
  confirmationRules:
    - tool: save_result
      requireConfirmation: true
`);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'connectors[0].config.tools[0].parameters.scoreLevel.enum' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].parameters.tags.items.type' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].parameters.tags.items.description' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].parameters.evidence.properties' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].parameters.invalidItems.items' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].parameters.invalidProperties.properties' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].parameters.requiredFlag.required' }),
      ]),
    );
  });
});
