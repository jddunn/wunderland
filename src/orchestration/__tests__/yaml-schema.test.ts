import { describe, it, expect } from 'vitest';
import { schemaFromYaml } from '../yaml-schema.js';

describe('schemaFromYaml', () => {
  it('converts string type', () => {
    const schema = schemaFromYaml({ name: { type: 'string', required: true } });
    expect(schema.parse({ name: 'test' })).toEqual({ name: 'test' });
  });

  it('converts number type', () => {
    const schema = schemaFromYaml({ count: { type: 'number', required: true } });
    expect(schema.parse({ count: 42 })).toEqual({ count: 42 });
  });

  it('converts boolean type', () => {
    const schema = schemaFromYaml({ active: { type: 'boolean', required: true } });
    expect(schema.parse({ active: true })).toEqual({ active: true });
  });

  it('converts array type with items', () => {
    const schema = schemaFromYaml({ tags: { type: 'array', items: { type: 'string' }, required: true } });
    expect(schema.parse({ tags: ['a', 'b'] })).toEqual({ tags: ['a', 'b'] });
  });

  it('converts object type', () => {
    const schema = schemaFromYaml({ meta: { type: 'object', required: true } });
    expect(schema.parse({ meta: { foo: 'bar' } })).toEqual({ meta: { foo: 'bar' } });
  });

  it('makes fields without required: true optional', () => {
    const schema = schemaFromYaml({
      name: { type: 'string', required: true },
      bio: { type: 'string' },
    });
    expect(schema.parse({ name: 'test' })).toBeDefined();
    expect(() => schema.parse({})).toThrow();
  });

  it('applies default values', () => {
    const schema = schemaFromYaml({
      depth: { type: 'number', default: 3 },
    });
    expect(schema.parse({})).toEqual({ depth: 3 });
  });

  it('handles array without items spec', () => {
    const schema = schemaFromYaml({ data: { type: 'array', required: true } });
    expect(schema.parse({ data: [1, 'two', true] })).toEqual({ data: [1, 'two', true] });
  });
});
