import z from 'zod';
import { ExcludeConfigSchema, ReposConfigSchema } from './lib/types.ts';

await Deno.writeTextFile('resources/exclude.schema.json', JSON.stringify(z.toJSONSchema(ExcludeConfigSchema)));
await Deno.writeTextFile('resources/repos.schema.json', JSON.stringify(z.toJSONSchema(ReposConfigSchema)));
