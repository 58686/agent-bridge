import { describe, expect, it } from 'vitest';
import { validateToolArguments } from '../src/tools/validator.js';
import { ToolParameter } from '../src/core/types.js';

const schema: Record<string, ToolParameter> = {
  scoreLevel: {
    type: 'string',
    description: 'Score level.',
    enum: ['excellent', 'qualified', 'needs_attention'],
    required: true,
  },
  riskLevel: {
    type: 'string',
    description: 'Risk level.',
    enum: ['low', 'medium', 'high'],
    required: true,
  },
  approved: {
    type: 'boolean',
    description: 'Approval flag.',
    enum: [true],
    required: true,
  },
  recommendations: {
    type: 'array',
    description: 'Recommendations.',
    required: true,
    items: {
      type: 'string',
      description: 'One recommendation.',
    },
  },
  evidence: {
    type: 'object',
    description: 'Evidence metrics.',
    required: true,
    properties: {
      completionRate: { type: 'number', description: 'Completion rate.', required: true },
      averageScore: { type: 'number', description: 'Average score.', required: true },
      overdueCourses: { type: 'number', description: 'Overdue courses.', default: 0 },
    },
  },
};

describe('tool argument validator', () => {
  it('validates enum values and nested array/object schemas', () => {
    const result = validateToolArguments(
      {
        scoreLevel: 'excellent',
        riskLevel: 'low',
        approved: true,
        recommendations: ['Keep the current learning cadence.'],
        evidence: {
          completionRate: 1,
          averageScore: 91,
        },
      },
      schema,
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.normalizedArgs).toMatchObject({
      scoreLevel: 'excellent',
      riskLevel: 'low',
      approved: true,
      recommendations: ['Keep the current learning cadence.'],
      evidence: {
        completionRate: 1,
        averageScore: 91,
        overdueCourses: 0,
      },
    });
  });

  it('returns precise issues for invalid enum and nested values', () => {
    const result = validateToolArguments(
      {
        scoreLevel: 'unknown',
        riskLevel: 'critical',
        approved: false,
        recommendations: ['ok', 123],
        evidence: {
          completionRate: '100%',
        },
      },
      schema,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'scoreLevel', message: expect.stringContaining('must be one of') }),
        expect.objectContaining({ path: 'riskLevel', message: expect.stringContaining('must be one of') }),
        expect.objectContaining({ path: 'approved', message: expect.stringContaining('must be one of') }),
        expect.objectContaining({ path: 'recommendations[1]', message: expect.stringContaining('must be a string') }),
        expect.objectContaining({ path: 'evidence.completionRate', message: expect.stringContaining('must be a number') }),
        expect.objectContaining({ path: 'evidence.averageScore', message: expect.stringContaining('Missing required parameter') }),
      ]),
    );
  });
});
