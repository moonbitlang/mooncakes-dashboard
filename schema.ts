import z from 'zod';
import { BuildConfigsSchema, SourcesSchema } from './lib/types.ts';

// Generate schemas
await Deno.writeTextFile('resources/sources.schema.json', JSON.stringify(z.toJSONSchema(SourcesSchema)));
await Deno.writeTextFile('resources/build-config.schema.json', JSON.stringify(z.toJSONSchema(BuildConfigsSchema)));

console.log('Generated schemas:');
console.log('  - sources.schema.json');
console.log('  - build-config.schema.json');
